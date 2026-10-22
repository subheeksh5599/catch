// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20, IMarginBank, IPerpPool, ISomniaEventHandler} from "./interfaces/IVenue.sol";

/// @title CatchVault
/// @notice A liquidation backstop for dreamDEX perps. Depositors put in the venue's collateral
/// and receive shares. The vault owns one MarginBank account and rests post-only orders at the
/// price levels where open positions would be liquidated: bids between a long's bankruptcy price
/// and its liquidation price, asks between a short's liquidation price and its bankruptcy price.
/// When the engine closes a liquidated position into the book, it fills against the vault.
///
/// Every rule is enforced here, not by an operator:
///  1. Per-market exposure never exceeds MARKET_CAP_BPS of vault assets; a single cluster order
///     never exceeds CLUSTER_CAP_BPS.
///  2. An order rests only while every account backing it still has a position whose
///     [bankruptcy, liquidation] band contains the order price. Anyone can re-check an order, and
///     Somnia reactivity re-checks the orders an account backs on every PositionUpdated it emits.
///  3. A caught position is only ever offered back at or beyond its entry price.
///  4. Shares redeem against free collateral; resting orders are cancelled to make room and no
///     address can move funds any other way.
///  5. The vault never takes liquidity (orders are PostOnly) and has no liquidation entry point.
contract CatchVault is ISomniaEventHandler {
    // ---------------------------------------------------------------- constants

    address public constant REACTIVITY_PRECOMPILE = 0x0000000000000000000000000000000000000100;
    /// keccak256("PositionUpdated(address,address,int128,uint128,int256,int256)")
    bytes32 public constant POSITION_UPDATED_TOPIC =
        keccak256("PositionUpdated(address,address,int128,uint128,int256,int256)");

    uint8 internal constant POST_ONLY = 3;
    uint64 internal constant NO_EXPIRY = type(uint64).max;
    uint256 internal constant BPS = 10_000;
    uint256 public constant MAX_BACKERS = 8;
    uint256 public constant MAX_SLOTS_PER_POOL = 6;
    uint256 internal constant VIRTUAL_SHARES = 1e3;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    // ---------------------------------------------------------------- immutables

    IMarginBank public immutable BANK;
    IERC20 public immutable ASSET;
    uint256 public immutable MARKET_CAP_BPS;
    uint256 public immutable CLUSTER_CAP_BPS;
    uint256 public immutable UNWIND_SPREAD_BPS;

    // ---------------------------------------------------------------- share token

    string public constant name = "Catch Vault Share";
    string public constant symbol = "cUSDso";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // ---------------------------------------------------------------- orders

    struct Slot {
        address pool;
        bool isBid;
        bool unwind;
        bool live;
        uint128 orderId;
        uint256 price;
        uint256 quantity;
        address[] backers;
    }

    uint64 public nextSlotId = 1;
    mapping(uint64 => Slot) internal _slots;
    mapping(address => uint64[]) internal _poolSlots; // live slots per pool
    mapping(address => mapping(address => uint64[])) internal _backedBy; // pool => account => slots
    address[] internal _pools; // every pool the vault has quoted
    mapping(address => bool) internal _knownPool;

    uint256 private _lock = 1;

    // ---------------------------------------------------------------- events

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposited(address indexed owner, uint256 assets, uint256 shares);
    event Redeemed(address indexed owner, uint256 shares, uint256 assets);
    event Placed(
        uint64 indexed slotId,
        address indexed pool,
        bool isBid,
        uint256 price,
        uint256 quantity,
        uint128 orderId,
        address[] backers
    );
    event Unwinding(uint64 indexed slotId, address indexed pool, bool isBid, uint256 price, uint256 quantity, uint128 orderId);
    event Released(uint64 indexed slotId, address indexed pool, uint8 reason);
    event Caught(address indexed pool, int128 newSize, uint128 avgEntryPrice);

    // reasons a slot is released
    uint8 public constant RELEASE_FILLED = 1; // order no longer rests: filled or removed by the venue
    uint8 public constant RELEASE_BAND = 2; // a backer left the band or closed
    uint8 public constant RELEASE_EVICTED = 3; // replaced by a larger cluster
    uint8 public constant RELEASE_REDEMPTION = 4; // collateral freed for a redemption
    uint8 public constant RELEASE_REPRICE = 5; // unwind re-priced

    // ---------------------------------------------------------------- errors

    error Reentrancy();
    error ZeroAmount();
    error InsufficientShares();
    error InsufficientFreeCollateral(uint256 needed, uint256 free);
    error UnknownPool(address pool);
    error PoolRestricted(address pool);
    error BadBackers();
    error BackerSide(address account);
    error OutsideBand(address account, uint256 bankruptcy, uint256 liquidation, uint256 price);
    error CrossesMark(uint256 price, uint256 mark);
    error QuantityExceedsCluster(uint256 quantity, uint256 clusterSize);
    error ClusterCap(uint256 notional, uint256 cap);
    error MarketCap(uint256 exposure, uint256 cap);
    error SlotsFull(uint256 notional, uint256 smallest);
    error NotRested();
    error NoPosition(address pool);
    error BelowEntry(uint256 price, uint256 entry);
    error UnwindTooLarge(uint256 quantity, uint256 position);
    error OnlyReactivityPrecompile();
    error NotLive(uint64 slotId);

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IMarginBank bank, uint256 marketCapBps, uint256 clusterCapBps, uint256 unwindSpreadBps) {
        require(marketCapBps > 0 && marketCapBps <= BPS, "market cap");
        require(clusterCapBps > 0 && clusterCapBps <= marketCapBps, "cluster cap");
        require(unwindSpreadBps < 1_000, "spread");
        BANK = bank;
        ASSET = IERC20(bank.getSystemConfig().collateralToken);
        MARKET_CAP_BPS = marketCapBps;
        CLUSTER_CAP_BPS = clusterCapBps;
        UNWIND_SPREAD_BPS = unwindSpreadBps;
        ASSET.approve(address(bank), type(uint256).max);
    }

    // ================================================================ shares

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) {
            if (a < value) revert InsufficientShares();
            allowance[from][msg.sender] = a - value;
        }
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        if (balanceOf[from] < value) revert InsufficientShares();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    // ================================================================ accounting

    /// @notice Vault assets in collateral units: idle tokens + MarginBank equity + locked collateral.
    function totalAssets() public view returns (uint256) {
        uint256 idle = ASSET.balanceOf(address(this));
        IMarginBank.AccountState memory s = BANK.getAccountState(address(this));
        (bool ok, int256 equity) = BANK.tryGetAccountEquity(address(this));
        if (!ok) equity = s.unlockedCollateralBalance;
        int256 total = int256(idle) + equity + int256(s.lockedCollateral);
        return total > 0 ? uint256(total) : 0;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return assets * (totalSupply + VIRTUAL_SHARES) / (totalAssets() + VIRTUAL_ASSETS);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return shares * (totalAssets() + VIRTUAL_ASSETS) / (totalSupply + VIRTUAL_SHARES);
    }

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        shares = convertToShares(assets);
        if (shares == 0) revert ZeroAmount();
        require(ASSET.transferFrom(msg.sender, address(this), assets), "transferFrom");
        BANK.deposit(assets);
        totalSupply += shares;
        balanceOf[receiver] += shares;
        emit Transfer(address(0), receiver, shares);
        emit Deposited(receiver, assets, shares);
    }

    /// @notice Burn shares for their share of assets. Resting cluster orders are cancelled until
    /// enough collateral is free; only collateral held by an open caught position can stand in
    /// the way, and that is bounded by MARKET_CAP_BPS per market.
    function redeem(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < shares) revert InsufficientShares();
        assets = convertToAssets(shares);
        uint256 free = BANK.getWithdrawableCollateral(address(this));
        if (free < assets) {
            _releaseUntilFree(assets);
            free = BANK.getWithdrawableCollateral(address(this));
        }
        uint256 idle = ASSET.balanceOf(address(this));
        if (free + idle < assets) revert InsufficientFreeCollateral(assets, free + idle);
        balanceOf[msg.sender] -= shares;
        totalSupply -= shares;
        emit Transfer(msg.sender, address(0), shares);
        if (idle < assets) BANK.withdraw(assets - idle);
        require(ASSET.transfer(receiver, assets), "transfer");
        emit Redeemed(msg.sender, shares, assets);
    }

    function _releaseUntilFree(uint256 needed) internal {
        for (uint256 p = 0; p < _pools.length; p++) {
            uint64[] storage ids = _poolSlots[_pools[p]];
            while (ids.length > 0) {
                uint64 id = ids[ids.length - 1];
                _release(id, RELEASE_REDEMPTION);
                if (BANK.getWithdrawableCollateral(address(this)) + ASSET.balanceOf(address(this)) >= needed) return;
            }
        }
    }

    // ================================================================ cluster orders

    /// @notice Rest a post-only order backed by a cluster of positions. Permissionless: the
    /// caller only proposes; every number is re-derived from the venue here.
    /// @param isBid true: bid under longs that would be liquidated (backers must be long).
    /// @param backers strictly increasing addresses, each holding a position on the forced side.
    function place(address pool, bool isBid, uint256 price, uint256 quantity, address[] calldata backers)
        external
        nonReentrant
        returns (uint64 slotId)
    {
        _checkPool(pool);
        uint256 oneBase;
        uint256 notional;
        (oneBase, notional) = _validateCluster(pool, isBid, price, quantity, backers);
        _enforceCaps(pool, notional, oneBase);

        slotId = nextSlotId++;
        uint128 orderId = _rest(pool, isBid, price, quantity, slotId);
        Slot storage slot = _slots[slotId];
        slot.pool = pool;
        slot.isBid = isBid;
        slot.live = true;
        slot.orderId = orderId;
        slot.price = price;
        slot.quantity = quantity;
        for (uint256 i = 0; i < backers.length; i++) {
            slot.backers.push(backers[i]);
            _backedBy[pool][backers[i]].push(slotId);
        }
        _poolSlots[pool].push(slotId);
        emit Placed(slotId, pool, isBid, price, quantity, orderId, backers);
    }

    function _validateCluster(
        address pool,
        bool isBid,
        uint256 price,
        uint256 quantity,
        address[] calldata backers
    ) internal view returns (uint256 oneBase, uint256 notional) {
        if (backers.length == 0 || backers.length > MAX_BACKERS) revert BadBackers();
        IPerpPool.HealthSnapshot memory s = IPerpPool(pool).getHealthSnapshot();
        if (isBid ? price >= s.markPrice : price <= s.markPrice) revert CrossesMark(price, s.markPrice);
        uint256 clusterSize;
        address prev;
        for (uint256 i = 0; i < backers.length; i++) {
            address a = backers[i];
            if (a <= prev || a == address(this)) revert BadBackers();
            prev = a;
            clusterSize += _checkBacker(pool, a, isBid, price, s);
        }
        if (quantity > clusterSize) revert QuantityExceedsCluster(quantity, clusterSize);
        oneBase = s.oneBase;
        notional = price * quantity / oneBase;
    }

    function _enforceCaps(address pool, uint256 notional, uint256 oneBase) internal {
        uint256 assets = totalAssets();
        uint256 clusterCap = assets * CLUSTER_CAP_BPS / BPS;
        if (notional > clusterCap) revert ClusterCap(notional, clusterCap);
        _makeRoom(pool, notional, oneBase);
        uint256 marketCap = assets * MARKET_CAP_BPS / BPS;
        uint256 exposureAfter = exposure(pool) + notional;
        if (exposureAfter > marketCap) revert MarketCap(exposureAfter, marketCap);
    }

    /// @notice Re-check one slot against the venue; releases it if it no longer stands.
    function refresh(uint64 slotId) external nonReentrant returns (bool stillLive) {
        if (!_slots[slotId].live) revert NotLive(slotId);
        return _recheck(slotId);
    }

    /// @notice Re-check every live slot on a pool.
    function refreshPool(address pool) external nonReentrant {
        uint64[] memory ids = _poolSlots[pool];
        for (uint256 i = 0; i < ids.length; i++) {
            if (_slots[ids[i]].live) _recheck(ids[i]);
        }
    }

    /// @notice Offer the vault's position on `pool` back to the book, never past its entry.
    /// Permissionless: anyone may choose a better (further) price; nobody may choose a worse one.
    function unwind(address pool, uint256 price, uint256 quantity) external nonReentrant returns (uint64 slotId) {
        return _unwind(pool, price, quantity);
    }

    // ================================================================ reactivity

    /// @notice Called by the Somnia reactivity precompile for MarginBank PositionUpdated logs.
    function onEvent(address emitter, bytes32[] calldata topics, bytes calldata data) external {
        if (msg.sender != REACTIVITY_PRECOMPILE) revert OnlyReactivityPrecompile();
        if (emitter != address(BANK) || topics.length < 3 || topics[0] != POSITION_UPDATED_TOPIC) return;
        if (_lock != 1) return;
        _lock = 2;
        address account = address(uint160(uint256(topics[1])));
        address pool = address(uint160(uint256(topics[2])));
        if (account == address(this)) {
            (int128 newSize, uint128 avgEntry) = abi.decode(data, (int128, uint128));
            emit Caught(pool, newSize, avgEntry);
            _autoUnwind(pool, newSize, avgEntry);
        } else {
            // take the index, then let every slot that still stands put itself back
            uint64[] memory ids = _backedBy[pool][account];
            delete _backedBy[pool][account];
            for (uint256 i = 0; i < ids.length; i++) {
                if (_slots[ids[i]].live) _recheck(ids[i]);
            }
        }
        _lock = 1;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == type(ISomniaEventHandler).interfaceId;
    }

    // ================================================================ views

    function getSlot(uint64 slotId) external view returns (Slot memory) {
        return _slots[slotId];
    }

    function liveSlots(address pool) external view returns (uint64[] memory) {
        return _poolSlots[pool];
    }

    function pools() external view returns (address[] memory) {
        return _pools;
    }

    /// @notice Open notional on a pool: the vault's position at mark plus every resting cluster order.
    function exposure(address pool) public view returns (uint256 total) {
        IPerpPool.HealthSnapshot memory s = IPerpPool(pool).getHealthSnapshot();
        IMarginBank.Position memory p = BANK.getPosition(address(this), pool);
        uint256 size = p.size >= 0 ? uint256(uint128(p.size)) : uint256(uint128(-p.size));
        total = size * s.markPrice / s.oneBase;
        uint64[] storage ids = _poolSlots[pool];
        for (uint256 i = 0; i < ids.length; i++) {
            Slot storage sl = _slots[ids[i]];
            if (!sl.unwind) total += sl.price * sl.quantity / s.oneBase;
        }
    }

    /// @notice Liquidation trigger estimate for `account` on `pool` (single-market solve of
    /// equity == maintenance requirement, the same solve the venue's SDK publishes).
    function liquidationPrice(address account, address pool) public view returns (uint256) {
        IPerpPool.HealthSnapshot memory s = IPerpPool(pool).getHealthSnapshot();
        IMarginBank.Position memory p = BANK.getPosition(account, pool);
        if (p.size == 0) return 0;
        return _liquidationPrice(account, p.size, s);
    }

    // ================================================================ internals

    function _checkPool(address pool) internal {
        if (IPerpPool(pool).marginBank() != address(BANK) || !BANK.isPerpPoolRegistered(pool)) {
            revert UnknownPool(pool);
        }
        if (IPerpPool(pool).isRestricted()) revert PoolRestricted(pool);
        if (!_knownPool[pool]) {
            _knownPool[pool] = true;
            _pools.push(pool);
        }
    }

    /// @return size the backer's position size that a liquidation would force through the book
    function _checkBacker(address pool, address a, bool isBid, uint256 price, IPerpPool.HealthSnapshot memory s)
        internal
        view
        returns (uint256 size)
    {
        IMarginBank.Position memory p = BANK.getPosition(a, pool);
        // a bid catches a long being sold; an ask catches a short being bought back
        if (isBid ? p.size <= 0 : p.size >= 0) revert BackerSide(a);
        uint256 bankruptcy = BANK.getBankruptcyPrice(a, pool);
        uint256 liq = _liquidationPrice(a, p.size, s);
        bool inside = isBid ? (price >= bankruptcy && price <= liq) : (price <= bankruptcy && price >= liq);
        if (!inside) revert OutsideBand(a, bankruptcy, liq, price);
        size = p.size > 0 ? uint256(uint128(p.size)) : uint256(uint128(-p.size));
    }

    function _liquidationPrice(address account, int128 size, IPerpPool.HealthSnapshot memory s)
        internal
        view
        returns (uint256)
    {
        (int256 equity,, uint256 mmReq,) = BANK.getAccountHealth(account);
        if (equity <= int256(mmReq)) return s.markPrice; // already liquidatable at the mark
        uint256 cushion = uint256(equity - int256(mmReq));
        if (size > 0) {
            uint256 abs = uint256(uint128(size));
            uint256 d = cushion * s.oneBase * BPS / (abs * (BPS - s.maintenanceMarginBps));
            return d >= s.markPrice ? 0 : s.markPrice - d;
        }
        uint256 absS = uint256(uint128(-size));
        return s.markPrice + cushion * s.oneBase * BPS / (absS * (BPS + s.maintenanceMarginBps));
    }

    function _bandHolds(Slot storage sl) internal view returns (bool) {
        IPerpPool.HealthSnapshot memory s = IPerpPool(sl.pool).getHealthSnapshot();
        if (sl.isBid ? sl.price >= s.markPrice : sl.price <= s.markPrice) return true; // a liquidation is in progress at our level; let it fill
        for (uint256 i = 0; i < sl.backers.length; i++) {
            address a = sl.backers[i];
            IMarginBank.Position memory p = BANK.getPosition(a, sl.pool);
            if (sl.isBid ? p.size <= 0 : p.size >= 0) return false;
            uint256 bankruptcy = BANK.getBankruptcyPrice(a, sl.pool);
            uint256 liq = _liquidationPrice(a, p.size, s);
            bool inside =
                sl.isBid ? (sl.price >= bankruptcy && sl.price <= liq) : (sl.price <= bankruptcy && sl.price >= liq);
            if (!inside) return false;
        }
        return true;
    }

    function _stillResting(Slot storage sl) internal view returns (bool) {
        IPerpPool.Order memory o = IPerpPool(sl.pool).getOrder(sl.orderId);
        return o.owner == address(this) && o.quantityRemaining > 0;
    }

    function _recheck(uint64 id) internal returns (bool) {
        Slot storage sl = _slots[id];
        if (!_stillResting(sl)) {
            _release(id, RELEASE_FILLED);
            return false;
        }
        if (!sl.unwind && !_bandHolds(sl)) {
            _release(id, RELEASE_BAND);
            return false;
        }
        if (!sl.unwind) {
            // keep the slot indexed under each backer (onEvent pops as it walks)
            for (uint256 i = 0; i < sl.backers.length; i++) {
                uint64[] storage list = _backedBy[sl.pool][sl.backers[i]];
                bool present;
                for (uint256 j = 0; j < list.length; j++) {
                    if (list[j] == id) {
                        present = true;
                        break;
                    }
                }
                if (!present) list.push(id);
            }
        }
        return true;
    }

    function _release(uint64 id, uint8 reason) internal {
        Slot storage sl = _slots[id];
        if (!sl.live) return;
        sl.live = false;
        if (_stillResting(sl)) IPerpPool(sl.pool).cancelOrder(sl.orderId);
        uint64[] storage ids = _poolSlots[sl.pool];
        for (uint256 i = 0; i < ids.length; i++) {
            if (ids[i] == id) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
                break;
            }
        }
        emit Released(id, sl.pool, reason);
    }

    function _makeRoom(address pool, uint256 notional, uint256 oneBase) internal {
        uint64[] storage ids = _poolSlots[pool];
        if (ids.length < MAX_SLOTS_PER_POOL) return;
        uint64 smallest;
        uint256 smallestNotional = type(uint256).max;
        for (uint256 i = 0; i < ids.length; i++) {
            Slot storage sl = _slots[ids[i]];
            if (sl.unwind) continue;
            uint256 n = sl.price * sl.quantity / oneBase;
            if (n < smallestNotional) {
                smallestNotional = n;
                smallest = ids[i];
            }
        }
        if (smallest == 0 || notional <= smallestNotional) revert SlotsFull(notional, smallestNotional);
        _release(smallest, RELEASE_EVICTED);
    }

    function _rest(address pool, bool isBid, uint256 price, uint256 quantity, uint64 slotId)
        internal
        returns (uint128 orderId)
    {
        IPerpPool(pool).placeOrder(isBid, slotId, price, quantity, NO_EXPIRY, POST_ONLY, 0, address(0), 0);
        uint128[] memory open = IPerpPool(pool).getOwnOpenOrders();
        for (uint256 i = open.length; i > 0; i--) {
            IPerpPool.Order memory o = IPerpPool(pool).getOrder(open[i - 1]);
            if (o.userData == slotId && o.owner == address(this)) return o.orderId;
        }
        revert NotRested();
    }

    function _unwind(address pool, uint256 price, uint256 quantity) internal returns (uint64 slotId) {
        IMarginBank.Position memory p = BANK.getPosition(address(this), pool);
        if (p.size == 0) revert NoPosition(pool);
        bool isBid = p.size < 0; // a long is sold back, a short is bought back
        uint256 entry = p.avgEntryPrice;
        if (isBid ? price > entry : price < entry) revert BelowEntry(price, entry);
        uint256 size = p.size > 0 ? uint256(uint128(p.size)) : uint256(uint128(-p.size));
        if (quantity == 0 || quantity > size) revert UnwindTooLarge(quantity, size);

        // one unwind order per pool: a new one replaces the old
        uint64[] storage ids = _poolSlots[pool];
        for (uint256 i = ids.length; i > 0; i--) {
            if (_slots[ids[i - 1]].unwind) _release(ids[i - 1], RELEASE_REPRICE);
        }

        slotId = nextSlotId++;
        uint128 orderId = _rest(pool, isBid, price, quantity, slotId);
        Slot storage slot = _slots[slotId];
        slot.pool = pool;
        slot.isBid = isBid;
        slot.unwind = true;
        slot.live = true;
        slot.orderId = orderId;
        slot.price = price;
        slot.quantity = quantity;
        ids.push(slotId);
        emit Unwinding(slotId, pool, isBid, price, quantity, orderId);
    }

    /// @dev Called from the reactivity handler after the vault's own position changed. Best
    /// effort: if the venue refuses the order (e.g. it would cross), the position simply waits
    /// for anyone to call `unwind` at a valid price.
    function _autoUnwind(address pool, int128 newSize, uint128 avgEntry) internal {
        if (newSize == 0) {
            uint64[] storage ids = _poolSlots[pool];
            for (uint256 i = ids.length; i > 0; i--) {
                if (_slots[ids[i - 1]].unwind) _release(ids[i - 1], RELEASE_FILLED);
            }
            return;
        }
        IPerpPool.HealthSnapshot memory s = IPerpPool(pool).getHealthSnapshot();
        IPerpPool.BookParameters memory b = IPerpPool(pool).getOrderBookParameters();
        bool isBid = newSize < 0;
        uint256 size = newSize > 0 ? uint256(uint128(newSize)) : uint256(uint128(-newSize));
        uint256 qty = size / b.lotSize * b.lotSize;
        if (qty < b.minQuantity) return;
        uint256 price;
        if (isBid) {
            uint256 ref = avgEntry < s.markPrice ? avgEntry : s.markPrice;
            price = ref * (BPS - UNWIND_SPREAD_BPS) / BPS / b.tickSize * b.tickSize;
        } else {
            uint256 ref = avgEntry > s.markPrice ? avgEntry : s.markPrice;
            price = (ref * (BPS + UNWIND_SPREAD_BPS) / BPS + b.tickSize - 1) / b.tickSize * b.tickSize;
        }
        try this.unwindFromHandler(pool, price, qty) {} catch {}
    }

    /// @dev External hop so a venue refusal inside the handler can be caught. Self-only.
    function unwindFromHandler(address pool, uint256 price, uint256 quantity) external {
        require(msg.sender == address(this), "self");
        _unwind(pool, price, quantity);
    }
}
