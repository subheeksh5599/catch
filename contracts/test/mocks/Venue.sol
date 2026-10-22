// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMarginBank, IPerpPool} from "../../src/interfaces/IVenue.sol";

/// Test doubles that follow the venue ABIs closely enough to exercise every vault rule.
/// They live under test/ and are never deployed.

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "balance");
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        require(balanceOf[f] >= v, "balance");
        uint256 a = allowance[f][msg.sender];
        require(a >= v, "allowance");
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}

contract MockBank {
    MockToken public token;
    mapping(address => int256) public unlocked;
    mapping(address => uint256) public locked;
    mapping(address => mapping(address => IMarginBank.Position)) internal _pos;
    mapping(address => int256) public equityOverride;
    mapping(address => bool) public hasEquityOverride;
    mapping(address => uint256) public mmReq;
    mapping(address => mapping(address => uint256)) public bankruptcy;
    mapping(address => bool) public registered;

    constructor(MockToken t) {
        token = t;
    }

    // ---- writes
    function deposit(uint256 amount) external {
        token.transferFrom(msg.sender, address(this), amount);
        unlocked[msg.sender] += int256(amount);
    }

    function withdraw(uint256 amount) external {
        require(unlocked[msg.sender] >= int256(amount), "withdraw");
        unlocked[msg.sender] -= int256(amount);
        token.transfer(msg.sender, amount);
    }

    // ---- hooks used by MockPool
    function lock(address a, uint256 amt) external {
        require(unlocked[a] >= int256(amt), "InsufficientCollateral");
        unlocked[a] -= int256(amt);
        locked[a] += amt;
    }

    function unlock(address a, uint256 amt) external {
        locked[a] -= amt;
        unlocked[a] += int256(amt);
    }

    // ---- test setters
    function setRegistered(address pool, bool v) external {
        registered[pool] = v;
    }

    function setPosition(address a, address pool, int128 size, uint128 entry) external {
        _pos[a][pool] = IMarginBank.Position(size, entry, 0, 0);
    }

    function setHealth(address a, int256 equity, uint256 mm) external {
        equityOverride[a] = equity;
        hasEquityOverride[a] = true;
        mmReq[a] = mm;
    }

    function setBankruptcy(address a, address pool, uint256 p) external {
        bankruptcy[a][pool] = p;
    }

    // ---- reads
    function getSystemConfig() external view returns (IMarginBank.SystemConfig memory c) {
        c.marginBank = address(this);
        c.collateralToken = address(token);
        c.fullyWired = true;
    }

    function getPosition(address a, address pool) external view returns (IMarginBank.Position memory) {
        return _pos[a][pool];
    }

    function getAccountState(address a) external view returns (IMarginBank.AccountState memory s) {
        s.unlockedCollateralBalance = unlocked[a];
        s.lockedCollateral = locked[a];
    }

    function tryGetAccountEquity(address a) external view returns (bool, int256) {
        if (hasEquityOverride[a]) return (true, equityOverride[a]);
        return (true, unlocked[a]);
    }

    function getWithdrawableCollateral(address a) external view returns (uint256) {
        return unlocked[a] > 0 ? uint256(unlocked[a]) : 0;
    }

    function getAccountHealth(address a) external view returns (int256, uint256, uint256, uint256) {
        return (equityOverride[a], 0, mmReq[a], 0);
    }

    function getBankruptcyPrice(address a, address pool) external view returns (uint256) {
        require(_pos[a][pool].size != 0, "NoOpenPosition");
        return bankruptcy[a][pool];
    }

    function isPerpPoolRegistered(address pool) external view returns (bool) {
        return registered[pool];
    }

    // emits the same event the real bank emits
    event PositionUpdated(
        address indexed account,
        address indexed perpPool,
        int128 newSize,
        uint128 avgEntryPrice,
        int256 realizedPnl,
        int256 entryFundingIndex
    );
}

contract MockPool {
    MockBank public bank;
    uint256 public mark;
    uint256 public constant ONE_BASE = 1e18;
    uint256 public mmBps = 250;
    bool public restricted;
    uint128 public nextId = 1;
    uint256 public lockDivisor = 10; // 10x leverage on the margin lock
    mapping(uint128 => IPerpPool.Order) internal _orders;
    mapping(address => uint128[]) internal _own;

    constructor(MockBank b, uint256 mark_) {
        bank = b;
        mark = mark_;
    }

    function setMark(uint256 m) external {
        mark = m;
    }

    function setRestricted(bool r) external {
        restricted = r;
    }

    function marginBank() external view returns (address) {
        return address(bank);
    }

    function isRestricted() external view returns (bool) {
        return restricted;
    }

    function getHealthSnapshot() external view returns (IPerpPool.HealthSnapshot memory s) {
        s.oneBase = ONE_BASE;
        s.markPrice = mark;
        s.maintenanceMarginBps = mmBps;
    }

    function getOrderBookParameters() external pure returns (IPerpPool.BookParameters memory b) {
        b.tickSize = 1e15;
        b.minQuantity = 1e15;
        b.lotSize = 1e15;
    }

    function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 exp, uint8 orderType, uint8, address, uint96)
        external
    {
        require(orderType == 3, "post-only expected");
        // a post-only that would cross the mark does not rest
        if (isBid ? price >= mark : price <= mark) return;
        uint256 lockAmt = price * quantity / ONE_BASE / lockDivisor;
        bank.lock(msg.sender, lockAmt);
        uint128 id = nextId++;
        _orders[id] = IPerpPool.Order(id, isBid, msg.sender, userData, price, quantity, quantity, exp);
        _own[msg.sender].push(id);
    }

    function cancelOrder(uint128 id) external {
        IPerpPool.Order storage o = _orders[id];
        require(o.owner == msg.sender, "owner");
        require(o.quantityRemaining > 0, "not open");
        bank.unlock(msg.sender, o.price * o.quantityRemaining / ONE_BASE / lockDivisor);
        o.quantityRemaining = 0;
    }

    function getOrder(uint128 id) external view returns (IPerpPool.Order memory) {
        return _orders[id];
    }

    function getOwnOpenOrders() external view returns (uint128[] memory out) {
        uint128[] storage all = _own[msg.sender];
        uint256 n;
        for (uint256 i = 0; i < all.length; i++) if (_orders[all[i]].quantityRemaining > 0) n++;
        out = new uint128[](n);
        n = 0;
        for (uint256 i = 0; i < all.length; i++) if (_orders[all[i]].quantityRemaining > 0) out[n++] = all[i];
    }

    /// Simulate the engine closing a liquidated position into this resting order.
    function fill(uint128 id, uint256 qty) external {
        IPerpPool.Order storage o = _orders[id];
        require(qty <= o.quantityRemaining, "qty");
        bank.unlock(o.owner, o.price * qty / ONE_BASE / lockDivisor);
        o.quantityRemaining -= qty;
        IMarginBank.Position memory p = bank.getPosition(o.owner, address(this));
        int128 delta = o.isBid ? int128(int256(qty)) : -int128(int256(qty));
        bank.setPosition(o.owner, address(this), p.size + delta, uint128(o.price));
    }
}
