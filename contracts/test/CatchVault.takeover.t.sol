// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CatchVault} from "../src/CatchVault.sol";
import {IMarginBank} from "../src/interfaces/IVenue.sol";
import {MockToken, MockBank, MockPool, MockEngine} from "./mocks/Venue.sol";

/// Stage-4 takeover quotes: the rules a takeover must pass are the rules a book order must pass.
/// The same path runs against the real LiquidationEngine in CatchVault.takeover.fork.t.sol.
contract CatchVaultTakeoverTest is Test {
    MockToken token;
    MockBank bank;
    MockPool pool;
    CatchVault vault;
    address engine;
    address alice = makeAddr("alice");
    address trader = address(0x1001);

    uint256 constant MARK = 60_000e18;
    bytes4 constant QUOTE = 0x6627a0db;

    function setUp() public {
        vm.warp(1_700_000_000);
        token = new MockToken();
        bank = new MockBank(token);
        pool = new MockPool(bank, MARK);
        bank.setRegistered(address(pool), true);
        // market cap 25%, per-order cap 10%, OI cap 10%, 3% index deviation
        vault = new CatchVault(IMarginBank(address(bank)), [uint256(2_500), 1_000, 30, 1_000, 300, 120, 3_600]);
        engine = address(vault.ENGINE());
        token.mint(alice, 1_000_000e18);
        vm.startPrank(alice);
        token.approve(address(vault), type(uint256).max);
        vault.deposit(100_000e18, alice);
        vm.stopPrank();
    }

    function _ask(int256 size) internal returns (bool accept, uint256 price) {
        vm.prank(engine);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeWithSelector(QUOTE, trader, address(pool), size, MARK));
        require(ok, "quote reverted");
        return abi.decode(ret, (bool, uint256));
    }

    function test_selectorIsTheEnginesBidderCallback() public view {
        assertEq(vault.TAKEOVER_QUOTE_SELECTOR(), QUOTE);
    }

    function test_longIsTakenOverBelowTheMark() public {
        (bool accept, uint256 price) = _ask(0.1e18);
        assertTrue(accept);
        assertEq(price, MARK * 9_900 / 10_000);
    }

    function test_shortIsTakenOverAboveTheMark() public {
        (bool accept, uint256 price) = _ask(-0.1e18);
        assertTrue(accept);
        assertEq(price, MARK * 10_100 / 10_000);
    }

    function test_spreadStaysInsideTheEnginesBounds() public {
        MockEngine(engine).setSpread(80); // engine max below the vault's 100 bps
        (, uint256 price) = _ask(0.1e18);
        assertEq(price, MARK * 9_920 / 10_000);
    }

    function test_declinesAboveThePerOrderCap() public {
        // 0.2 BTC at ~59.4k = 11.9k > 10% of 100k
        (bool accept, uint256 price) = _ask(0.2e18);
        assertFalse(accept);
        assertEq(price, 0);
    }

    function test_declinesAboveTheOpenInterestCap() public {
        pool.setOpenInterest(1e18); // 10% of 1 BTC OI = ~6k
        (bool accept,) = _ask(0.11e18);
        assertFalse(accept);
    }

    function test_declinesWhenTheMarkIsOffTheIndex() public {
        pool.setIndex(MARK * 90 / 100);
        (bool accept,) = _ask(0.1e18);
        assertFalse(accept);
    }

    function test_declinesOnAStaleIndex() public {
        pool.setIndexTime(block.timestamp - 1_000);
        (bool accept,) = _ask(0.1e18);
        assertFalse(accept);
    }

    function test_declinesARestrictedOrUnknownMarket() public {
        pool.setRestricted(true);
        (bool accept,) = _ask(0.1e18);
        assertFalse(accept);
        pool.setRestricted(false);
        bank.setRegistered(address(pool), false);
        (accept,) = _ask(0.1e18);
        assertFalse(accept);
    }

    function test_declinesItsOwnPositionAndZeroSize() public {
        (bool accept,) = vault.takeoverQuote(address(vault), address(pool), 0.1e18, MARK);
        assertFalse(accept);
        (accept,) = vault.takeoverQuote(trader, address(pool), 0, MARK);
        assertFalse(accept);
    }

    function test_onlyTheEngineCanAsk() public {
        vm.expectRevert(CatchVault.OnlyEngine.selector);
        (bool ok,) = address(vault).call(abi.encodeWithSelector(QUOTE, trader, address(pool), int256(0.1e18), MARK));
        ok;
    }

    function test_unknownCallsRevert() public {
        vm.expectRevert(abi.encodeWithSelector(CatchVault.UnknownCall.selector, bytes4(0xdeadbeef)));
        (bool ok,) = address(vault).call(abi.encodeWithSelector(bytes4(0xdeadbeef), uint256(1)));
        ok;
    }

    function testFuzz_acceptedQuotesAlwaysRespectTheCaps(int256 size) public {
        size = bound(size, -2e18, 2e18);
        (bool accept, uint256 price) = _ask(size);
        if (!accept) return;
        uint256 abs = size > 0 ? uint256(size) : uint256(-size);
        uint256 notional = abs * price / 1e18;
        assertLe(notional, vault.totalAssets() * 1_000 / 10_000, "per-order cap");
        if (size > 0) assertLt(price, MARK);
        else assertGt(price, MARK);
    }
}
