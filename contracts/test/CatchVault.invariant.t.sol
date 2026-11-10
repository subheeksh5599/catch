// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CatchVault} from "../src/CatchVault.sol";
import {IMarginBank} from "../src/interfaces/IVenue.sol";
import {IPerpPool} from "../src/interfaces/IVenue.sol";
import {MockToken, MockBank, MockPool} from "./mocks/Venue.sol";
import {console2} from "forge-std/console2.sol";

/// Drives the vault through random sequences of everything that can happen to it: depositors
/// coming and going, share transfers, keepers proposing good and bad orders, the engine filling
/// them, backers moving or closing, the mark and the oracle drifting apart, open interest
/// shrinking and time passing. Every rule the vault promises is checked after every call.
contract Handler is Test {
    CatchVault public vault;
    MockToken public token;
    MockBank public bank;
    MockPool public pool;

    bytes32 constant TOPIC = keccak256("PositionUpdated(address,address,int128,uint128,int256,int256)");
    address constant PRECOMPILE = address(0x0100);
    uint256 constant MARK0 = 60_000e18;

    address[] public actors;
    address[] public longs;
    address[] public shorts;

    // ghosts: what has moved in and out, and any broken promise seen mid-sequence
    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 public lastPricePerShare;
    bool public pricePerShareFell;
    bool public lockedExitSucceeded;
    bool public placedOverACap;
    bool public placedOutsideAWindow;
    bool public placedOnABadPrice;
    bool public placedAcrossTheMark;
    bool public dislocatedSlotSurvivedRefresh;
    uint256 public placements;
    uint256 public refusals;
    uint256 public fills;
    uint256 public cancelsByCallback;

    constructor(CatchVault v, MockToken t, MockBank b, MockPool p) {
        vault = v;
        token = t;
        bank = b;
        pool = p;
        for (uint256 i = 0; i < 4; i++) {
            address a = makeAddr(string(abi.encodePacked("depositor", vm.toString(i))));
            actors.push(a);
            token.mint(a, 1e40); // effectively unlimited, so a deposit only fails for a reason in the vault
            vm.prank(a);
            token.approve(address(vault), type(uint256).max);
        }
        for (uint160 i = 1; i <= 3; i++) {
            longs.push(address(0x1000 + i));
            shorts.push(address(0x2000 + i));
        }
        _resetBackers();
        lastPricePerShare = vault.convertToAssets(1e21);
    }

    // ------------------------------------------------------------ helpers

    function _resetBackers() internal {
        for (uint256 i = 0; i < longs.length; i++) {
            bank.setPosition(longs[i], address(pool), 1e18, uint128(MARK0));
            bank.setHealth(longs[i], 975e18, 0);
            bank.setBankruptcy(longs[i], address(pool), 58_500e18);
            bank.setPosition(shorts[i], address(pool), -1e18, uint128(MARK0));
            bank.setHealth(shorts[i], 1_025e18, 0);
            bank.setBankruptcy(shorts[i], address(pool), 61_500e18);
        }
    }

    function _event(address account) internal {
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = TOPIC;
        topics[1] = bytes32(uint256(uint160(account)));
        topics[2] = bytes32(uint256(uint160(address(pool))));
        IMarginBank.Position memory p = bank.getPosition(account, address(pool));
        vm.prank(PRECOMPILE);
        vault.onEvent(address(bank), topics, abi.encode(p.size, p.avgEntryPrice, int256(0), int256(0)));
    }

    function _liveClusterSlots() internal view returns (uint256 n) {
        uint64[] memory ids = vault.liveSlots(address(pool));
        for (uint256 i = 0; i < ids.length; i++) if (!vault.getSlot(ids[i]).unwind) n++;
    }

    /// The share price may only move when the vault's position is marked; deposits, redemptions,
    /// placements and cancels must never take value from existing holders.
    function _checkPricePerShare() internal {
        uint256 pps = vault.convertToAssets(1e21);
        if (pps + 1 < lastPricePerShare) pricePerShareFell = true;
        lastPricePerShare = pps;
    }

    modifier tracked() {
        _;
        _checkPricePerShare();
    }

    // ------------------------------------------------------------ depositors

    function deposit(uint256 who, uint256 amount) external tracked {
        address a = actors[who % actors.length];
        amount = bound(amount, 1e15, 2_000_000e18);
        vm.prank(a);
        vault.deposit(amount, a);
        ghostIn += amount;
    }

    function redeem(uint256 who, uint256 fraction) external tracked {
        address a = actors[who % actors.length];
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        uint256 shares = bound(fraction, 1, bal);
        bool locked = block.timestamp < vault.unlockAt(a);
        vm.prank(a);
        try vault.redeem(shares, a) returns (uint256 out) {
            if (locked) lockedExitSucceeded = true;
            ghostOut += out;
        } catch {}
    }

    function transferShares(uint256 from, uint256 to, uint256 fraction) external tracked {
        address a = actors[from % actors.length];
        address b = actors[to % actors.length];
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        uint256 shares = bound(fraction, 1, bal);
        bool locked = block.timestamp < vault.unlockAt(a);
        vm.prank(a);
        try vault.transfer(b, shares) {
            if (locked) lockedExitSucceeded = true;
        } catch {}
    }

    function depositForSomeoneElse(uint256 who, uint256 other) external {
        address a = actors[who % actors.length];
        uint256 i = who % actors.length;
        address b = actors[(i + 1 + other % (actors.length - 1)) % actors.length];
        vm.prank(a);
        try vault.deposit(1e18, b) {
            lockedExitSucceeded = true; // a deposit for someone else would reset their lock
        } catch {}
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
    }

    // ------------------------------------------------------------ keepers

    /// Anyone proposes an order. Half the time the price is drawn from the backers' real window,
    /// half the time from anywhere near the book, so both acceptance and refusal are exercised.
    function place(bool isBid, uint256 mask, uint256 priceSeed, uint256 qtySeed, bool inWindow) external tracked {
        address[] storage side = isBid ? longs : shorts;
        mask = bound(mask, 1, (1 << side.length) - 1);
        uint256 n;
        for (uint256 i = 0; i < side.length; i++) if (mask & (1 << i) != 0) n++;
        address[] memory backers = new address[](n);
        n = 0;
        for (uint256 i = 0; i < side.length; i++) if (mask & (1 << i) != 0) backers[n++] = side[i];

        uint256 price;
        (uint256 lo, uint256 hi) = vault.catchWindow(backers[0], address(pool));
        if (inWindow && hi > lo) price = lo + priceSeed % (hi - lo + 1);
        else price = bound(priceSeed, 55_000e18, 65_000e18);
        price = price / 1e15 * 1e15;
        // up to 0.4 BTC: most proposals fit the caps, the largest do not
        uint256 qty = bound(qtySeed, 1, 400) * 1e15;

        (uint8 status,,,) = vault.priceStatus(address(pool));
        try vault.place(address(pool), isBid, price, qty, backers) returns (uint64 id) {
            placements++;
            uint256 assets = vault.totalAssets();
            if (price * qty / 1e18 > assets * vault.CLUSTER_CAP_BPS() / 10_000) placedOverACap = true;
            if (vault.exposure(address(pool)) > assets * vault.MARKET_CAP_BPS() / 10_000) placedOverACap = true;
            if (vault.exposure(address(pool)) > vault.openInterestCap(address(pool))) placedOverACap = true;
            if (status != 0) placedOnABadPrice = true;
            if (isBid ? price >= pool.mark() : price <= pool.mark()) placedAcrossTheMark = true;
            CatchVault.Slot memory s = vault.getSlot(id);
            for (uint256 i = 0; i < s.backers.length; i++) {
                (uint256 wlo, uint256 whi) = vault.catchWindow(s.backers[i], address(pool));
                if (price < wlo || price > whi) placedOutsideAWindow = true;
            }
        } catch {
            refusals++;
        }
    }

    // ------------------------------------------------------------ the venue

    /// The engine closes a liquidated position into one of the vault's resting orders.
    function fill(uint256 slotSeed, uint256 qtySeed) external tracked {
        uint64[] memory ids = vault.liveSlots(address(pool));
        if (ids.length == 0) return;
        CatchVault.Slot memory s = vault.getSlot(ids[slotSeed % ids.length]);
        if (s.unwind) return;
        try pool.getOrder(s.orderId) returns (IPerpPool.Order memory) {} catch {
            return;
        }
        uint256 qty = bound(qtySeed, 1, s.quantity / 1e15) * 1e15;
        try pool.fill(s.orderId, qty) {
            fills++;
            _event(address(vault)); // the vault's own PositionUpdated starts the unwind
        } catch {}
    }

    /// A backer trades, adds margin, or closes, and Reactivity calls the vault in the same block.
    function moveBacker(bool isLong, uint256 which, uint256 sizeSeed, uint256 equitySeed) external tracked {
        address a = isLong ? longs[which % longs.length] : shorts[which % shorts.length];
        uint256 before = _liveClusterSlots();
        int128 size = int128(int256(bound(sizeSeed, 0, 3e18)));
        bank.setPosition(a, address(pool), isLong ? size : -size, uint128(pool.mark()));
        bank.setHealth(a, int256(bound(equitySeed, 500e18, 3_000e18)), 0);
        _event(a);
        if (_liveClusterSlots() < before) cancelsByCallback++;
    }

    /// The mark drifts; the keeper (or anyone) re-checks the pool afterwards.
    function moveMark(uint256 bps, bool up) external tracked {
        bps = bound(bps, 0, 400);
        uint256 m = pool.mark();
        m = up ? m * (10_000 + bps) / 10_000 : m * (10_000 - bps) / 10_000;
        if (m < 50_000e18 || m > 70_000e18) m = MARK0;
        pool.setMark(m);
        _refresh();
    }

    /// The oracle index separates from the mark, goes stale, or comes back.
    function moveIndex(uint256 mode, uint256 bps) external tracked {
        mode = mode % 4;
        if (mode == 0) {
            pool.setIndex(0);
            pool.setIndexTime(0);
            pool.setIndexReverts(false);
        } else if (mode == 1) {
            pool.setIndex(pool.mark() * (10_000 + bound(bps, 0, 800)) / 10_000);
        } else if (mode == 2) {
            pool.setIndexTime(block.timestamp > 1_000 ? block.timestamp - bound(bps, 0, 1_000) : 1);
        } else {
            pool.setIndexReverts(bps % 2 == 0);
        }
        _refresh();
    }

    function shrinkOpenInterest(uint256 oi) external tracked {
        pool.setOpenInterest(bound(oi, 1e17, 1_000e18));
    }

    function refreshPool() external tracked {
        _refresh();
    }

    function _refresh() internal {
        vault.refreshPool(address(pool));
        (uint8 status,,,) = vault.priceStatus(address(pool));
        if (status != 0 && _liveClusterSlots() > 0) dislocatedSlotSurvivedRefresh = true;
    }

    /// Anyone may re-price the vault's unwind; the contract must hold it at or past entry.
    function unwindAt(uint256 priceSeed, uint256 qtySeed) external tracked {
        IMarginBank.Position memory p = bank.getPosition(address(vault), address(pool));
        if (p.size == 0) return;
        uint256 abs = p.size > 0 ? uint256(uint128(p.size)) : uint256(uint128(-p.size));
        uint256 price = bound(priceSeed, 50_000e18, 70_000e18) / 1e15 * 1e15;
        uint256 qty = bound(qtySeed, 1, abs / 1e15 == 0 ? 1 : abs / 1e15) * 1e15;
        try vault.unwind(address(pool), price, qty) {} catch {}
    }

    function backToNormal() external tracked {
        pool.setMark(MARK0);
        pool.setIndex(0);
        pool.setIndexTime(0);
        pool.setIndexReverts(false);
        pool.setOpenInterest(1_000_000e18);
        _resetBackers();
        for (uint256 i = 0; i < longs.length; i++) {
            _event(longs[i]);
            _event(shorts[i]);
        }
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract CatchVaultInvariantTest is StdInvariant, Test {
    MockToken token;
    MockBank bank;
    MockPool pool;
    CatchVault vault;
    Handler handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockToken();
        bank = new MockBank(token);
        pool = new MockPool(bank, 60_000e18);
        bank.setRegistered(address(pool), true);
        vault = new CatchVault(IMarginBank(address(bank)), [uint256(2_500), 1_000, 30, 1_000, 300, 120, 3_600]);
        handler = new Handler(vault, token, bank, pool);
        // seed the vault so the first placements have capital behind them
        handler.deposit(0, 100_000e18);
        targetContract(address(handler));
    }

    /// Shares exist only in depositors' hands; the supply is exactly what they hold.
    function invariant_supplyIsWhatDepositorsHold() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) sum += vault.balanceOf(handler.actors(i));
        assertEq(sum, vault.totalSupply());
    }

    /// No value leaves except through redemptions: assets equal deposits minus what was redeemed.
    /// (The mock venue pays no PnL, so nothing else may change the total.)
    function invariant_noLeakage() public view {
        assertEq(vault.totalAssets(), handler.ghostIn() - handler.ghostOut());
    }

    /// Nothing anyone does moves value from existing holders to someone else.
    function invariant_sharePriceNeverFalls() public view {
        assertFalse(handler.pricePerShareFell());
    }

    /// Invariant 8: no redemption or transfer of locked shares, and no deposit into another holder.
    function invariant_lockHolds() public view {
        assertFalse(handler.lockedExitSucceeded());
    }

    /// Invariants 1 and 6: every accepted order fit the cluster, market and open-interest caps.
    function invariant_capsHeldAtEveryPlacement() public view {
        assertFalse(handler.placedOverACap());
    }

    /// Invariant 2: every accepted order sat inside every backer's catch window...
    function invariant_placedInsideWindows() public view {
        assertFalse(handler.placedOutsideAWindow());
    }

    /// ...and after any re-check, every order still resting is inside every backer's window,
    /// unless the mark has reached its price: then the backers are being liquidated at that level
    /// and the contract deliberately lets the order fill. That is the catch itself.
    function invariant_restingOrdersStillInsideWindows() public view {
        uint64[] memory ids = vault.liveSlots(address(pool));
        uint256 mark = pool.mark();
        for (uint256 i = 0; i < ids.length; i++) {
            CatchVault.Slot memory s = vault.getSlot(ids[i]);
            if (s.unwind) continue;
            if (s.isBid ? s.price >= mark : s.price <= mark) continue;
            for (uint256 j = 0; j < s.backers.length; j++) {
                (uint256 lo, uint256 hi) = vault.catchWindow(s.backers[j], address(pool));
                assertTrue(s.price >= lo && s.price <= hi, "a resting order outside a backer's window");
            }
        }
    }

    /// Invariant 7: nothing placed on a stale or dislocated price, nothing left resting on one.
    function invariant_priceCheck() public view {
        assertFalse(handler.placedOnABadPrice());
        assertFalse(handler.dislocatedSlotSurvivedRefresh());
    }

    /// Invariant 3: an unwind is never priced past the vault's entry.
    function invariant_unwindNeverPastEntry() public view {
        IMarginBank.Position memory p = bank.getPosition(address(vault), address(pool));
        uint64[] memory ids = vault.liveSlots(address(pool));
        for (uint256 i = 0; i < ids.length; i++) {
            CatchVault.Slot memory s = vault.getSlot(ids[i]);
            if (!s.unwind || p.size == 0) continue;
            if (p.size > 0) assertGe(s.price, p.avgEntryPrice, "long offered below entry");
            else assertLe(s.price, p.avgEntryPrice, "short bought back above entry");
        }
    }

    /// Slot bookkeeping stays bounded and consistent.
    function invariant_slotsBounded() public view {
        uint64[] memory ids = vault.liveSlots(address(pool));
        assertLe(ids.length, vault.MAX_SLOTS_PER_POOL());
        for (uint256 i = 0; i < ids.length; i++) assertTrue(vault.getSlot(ids[i]).live);
    }

    /// Invariant 5: the vault never takes liquidity; every order it placed sat on its own side of the mark.
    function invariant_neverCrossesTheMark() public view {
        assertFalse(handler.placedAcrossTheMark());
    }

    /// Shows how much of each path a run exercised (forge test -vv).
    function afterInvariant() public view {
        console2.log("placements", handler.placements(), "refusals", handler.refusals());
        console2.log("fills", handler.fills(), "callback cancels", handler.cancelsByCallback());
    }
}
