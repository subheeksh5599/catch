// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2, Vm} from "forge-std/Test.sol";
import {CatchVault} from "../src/CatchVault.sol";
import {IMarginBank, IERC20} from "../src/interfaces/IVenue.sol";

/// Stage-4 takeover against the real LiquidationEngine, on a fork of Somnia Hideki.
///
/// Forks the block before a real takeover (tx 0x08f6988a…4cfe, block 45,209,705: account
/// 0x734d…bf74's BTC long, taken over by the then-only bidder 0xAF32…93b9). Deploys Catch,
/// registers it the way the engine owner registered the live bidders (same selector, same
/// arguments as tx 0xe5572646…c738), replays the original liquidation call byte for byte, and
/// checks who the real engine handed the position to.
///
/// Run: HIDEKI_RPC=https://api.hideki2.infra.testnet.somnia.network forge test --match-contract TakeoverFork -vv
contract TakeoverForkTest is Test {
    uint256 constant FORK_BLOCK = 45_209_704;
    IMarginBank constant BANK = IMarginBank(0x478769E1177C0773c43A593DCCc4Ad15F15F1394);
    address constant ENGINE = 0xA66d3C24Ad4a389d863846905D8173e1017e9F4D;
    address constant ENGINE_OWNER = 0xd58596620Ee6951B2958a931949e4ff7ce6222be;
    address constant LIVE_BIDDER = 0xAF327764345c2f54C1F2bc3322D28E4f633793b9;
    address constant BTC_POOL = 0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0;
    address constant LIQUIDATED = 0x734DBC62cA91Bd537cF965332C34c85152B1BF74;
    address constant KEEPER = 0x92d237DEa7eb9d37E1B303DA586f4B83956df6AD;
    address constant KEEPER_TARGET = 0x03CA1F61c5A475951F69F51BD16523075Fdfb1cc;
    bytes constant LIQUIDATION_CALL =
        hex"03159a8f000000000000000000000000734dbc62ca91bd537cf965332c34c85152b1bf7400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    bytes32 constant TAKEN_OVER = keccak256("PositionTakenOver(address,address,address,int128,uint256)");

    CatchVault vault;
    bool forked;

    function setUp() public {
        string memory rpc = vm.envOr("HIDEKI_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        forked = true;
        uint256[7] memory limits = [uint256(5000), 2500, 30, 200, 150, 120, 3600];
        vault = new CatchVault(BANK, limits);
        address depositor = makeAddr("depositor");
        IERC20 usd = IERC20(BANK.getSystemConfig().collateralToken);
        deal(address(usd), depositor, 100_000e18);
        vm.startPrank(depositor);
        usd.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e18, depositor);
        vm.stopPrank();
    }

    /// Same call the owner made for the live bidder 0x0040…fb99 (tx 0xe5572646…c738), except the
    /// last argument, the market tiers the bidder covers: that one asked for tier 5 only; Catch
    /// asks for tiers 1-5 (BTC is tier 1).
    function _register(address bidder) internal {
        uint256[] memory tiers = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) tiers[i] = i + 1;
        vm.prank(ENGINE_OWNER);
        (bool ok, bytes memory ret) = ENGINE.call(abi.encodeWithSelector(0x1abb67d5, bidder, uint256(0), uint256(10_000e18), tiers));
        require(ok, string(ret));
    }

    function _isBidder(address a) internal view returns (bool) {
        (, bytes memory r) = ENGINE.staticcall(abi.encodeWithSignature("isBidder(address)", a));
        return abi.decode(r, (bool));
    }

    function _replay() internal returns (address bidder, int128 size, uint256 price) {
        vm.recordLogs();
        vm.prank(KEEPER, KEEPER);
        (bool ok, bytes memory ret) = KEEPER_TARGET.call{gas: 150_000_000}(LIQUIDATION_CALL);
        require(ok, string(ret));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == ENGINE && logs[i].topics[0] == TAKEN_OVER) {
                bidder = address(uint160(uint256(logs[i].topics[2])));
                (size, price) = abi.decode(logs[i].data, (int128, uint256));
            }
        }
    }

    /// Outsiders cannot register; the engine owner can, with the live bidders' arguments.
    function test_registrationIsOwnerOnly_andCatchQualifies() public {
        if (!forked) return;
        uint256[] memory tiers = new uint256[](5);
        for (uint256 i = 0; i < 5; i++) tiers[i] = i + 1;
        (bool ok,) = ENGINE.call(abi.encodeWithSelector(0x1abb67d5, address(vault), uint256(0), uint256(10_000e18), tiers));
        assertFalse(ok, "an outsider registered a bidder");
        _register(address(vault));
        assertTrue(_isBidder(address(vault)));
    }

    /// The real engine asks Catch for a quote, accepts it, and moves the liquidated BTC long
    /// into the vault's account at Catch's price.
    function test_realEngineHandsTheTakeoverToCatch() public {
        if (!forked) return;
        // Catch as the registered bidder (the live one stepped aside), so the result is Catch's alone
        _register(address(vault));
        vm.prank(ENGINE_OWNER);
        (bool ok,) = ENGINE.call(abi.encodeWithSignature("removeBidder(address)", LIVE_BIDDER));
        require(ok, "removeBidder");

        int128 before = BANK.getPosition(LIQUIDATED, BTC_POOL).size;
        (address bidder, int128 size, uint256 price) = _replay();
        console2.log("liquidated BTC size (base units)", uint256(uint128(before)));
        console2.log("taken over by", bidder);
        console2.log("takeover price", price);

        assertEq(bidder, address(vault), "engine handed the position to someone else");
        IMarginBank.Position memory p = BANK.getPosition(address(vault), BTC_POOL);
        assertEq(p.size, size, "vault position != size taken over");
        assertEq(uint256(p.avgEntryPrice), price, "entry != takeover price");
        assertEq(BANK.getPosition(LIQUIDATED, BTC_POOL).size, 0, "liquidated position not closed");
    }

    /// Both bidders registered: the engine picks Catch, at a better price for the liquidated
    /// trader than the 73,076.68 the live bidder took the same position at on chain.
    function test_alongsideTheLiveBidder() public {
        if (!forked) return;
        _register(address(vault));
        (address bidder,, uint256 price) = _replay();
        console2.log("with both registered, taken over by", bidder);
        console2.log("at price", price);
        // the engine prefers the better price for the liquidated trader; Catch's is higher
        assertEq(bidder, address(vault), "the live bidder outbid Catch");
        assertGt(price, 73_076_680293970727481192, "not better than the live bidder's on-chain price");
    }

    /// A quote that breaks a vault rule is a "no", and the engine moves on rather than reverting.
    function test_declinesOutsideItsCaps() public {
        if (!forked) return;
        (bool accept,) = vault.takeoverQuote(LIQUIDATED, BTC_POOL, int256(1_000_000e18), 73_000e18);
        assertFalse(accept, "accepted a takeover far above its caps");
        vm.expectRevert(CatchVault.OnlyEngine.selector);
        (bool ok,) = address(vault).call(abi.encodeWithSelector(bytes4(0x6627a0db), LIQUIDATED, BTC_POOL, int256(1), uint256(1)));
        ok;
    }
}
