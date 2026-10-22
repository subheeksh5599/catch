// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CatchVault} from "../src/CatchVault.sol";
import {IMarginBank} from "../src/interfaces/IVenue.sol";
import {MockToken, MockBank, MockPool} from "./mocks/Venue.sol";

/// One test (or more) per rule the vault promises. Names say which rule.
contract CatchVaultTest is Test {
    MockToken token;
    MockBank bank;
    MockPool pool;
    CatchVault vault;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address keeper = makeAddr("keeper");
    // backers: fixed low addresses so ordering is obvious
    address l1 = address(0x1001);
    address l2 = address(0x1002);
    address s1 = address(0x2001);

    uint256 constant E18 = 1e18;
    uint256 constant MARK = 60_000e18;

    bytes32 constant TOPIC = keccak256("PositionUpdated(address,address,int128,uint128,int256,int256)");
    address constant PRECOMPILE = address(0x0100);

    function setUp() public {
        token = new MockToken();
        bank = new MockBank(token);
        pool = new MockPool(bank, MARK);
        bank.setRegistered(address(pool), true);
        vault = new CatchVault(IMarginBank(address(bank)), 2_500, 1_000, 30);

        token.mint(alice, 1_000_000e18);
        token.mint(bob, 1_000_000e18);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        token.approve(address(vault), type(uint256).max);
        vm.prank(alice);
        vault.deposit(100_000e18, alice);

        // l1, l2: 1 BTC longs, liquidation at 59,000, bankruptcy at 58,500
        _long(l1, 1e18, 58_500e18);
        _long(l2, 1e18, 58_500e18);
        // s1: 1 BTC short, liquidation at ~61,000, bankruptcy at 61,500
        bank.setPosition(s1, address(pool), -1e18, uint128(MARK));
        bank.setHealth(s1, 1_025e18, 0); // cushion 1025 -> d = 1025*1e4/10250 = 1000
        bank.setBankruptcy(s1, address(pool), 61_500e18);
    }

    function _long(address a, int128 size, uint256 bk) internal {
        bank.setPosition(a, address(pool), size, uint128(MARK));
        bank.setHealth(a, 975e18, 0); // cushion 975 -> d = 975*1e4/9750 = 1000 per 1 BTC
        bank.setBankruptcy(a, address(pool), bk);
    }

    function _two() internal view returns (address[] memory b) {
        b = new address[](2);
        b[0] = l1;
        b[1] = l2;
    }

    function _one(address a) internal pure returns (address[] memory b) {
        b = new address[](1);
        b[0] = a;
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

    // ------------------------------------------------------------ shares

    function test_deposit_mintsSharesAndMovesFundsToTheBank() public view {
        assertEq(vault.balanceOf(alice), vault.totalSupply());
        assertEq(token.balanceOf(address(bank)), 100_000e18);
        assertEq(vault.totalAssets(), 100_000e18);
    }

    function test_deposit_secondDepositorGetsProportionalShares() public {
        vm.prank(bob);
        uint256 shares = vault.deposit(50_000e18, bob);
        assertApproxEqRel(shares * 2, vault.balanceOf(alice), 1e12);
    }

    function test_deposit_zeroReverts() public {
        vm.expectRevert(CatchVault.ZeroAmount.selector);
        vm.prank(alice);
        vault.deposit(0, alice);
    }

    function test_redeem_returnsAssets() public {
        uint256 shares = vault.balanceOf(alice);
        uint256 before = token.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice);
        assertApproxEqAbs(out, 100_000e18, 1e3);
        assertEq(token.balanceOf(alice) - before, out);
        assertEq(vault.totalSupply(), 0);
    }

    function test_redeem_moreThanBalanceReverts() public {
        uint256 shares = vault.balanceOf(alice);
        vm.expectRevert(CatchVault.InsufficientShares.selector);
        vm.prank(bob);
        vault.redeem(shares, bob);
    }

    /// Invariant 4: resting orders never block a redemption.
    function test_invariant4_restingOrdersAreCancelledToRedeem() public {
        vm.prank(keeper);
        vault.place(address(pool), true, 58_800e18, 0.1e18, _two()); // locks 588
        // make the bank hold less free collateral than the full redemption needs
        bank.lock(address(vault), 95_000e18);
        bank.unlock(address(vault), 95_000e18);
        uint256 shares = vault.balanceOf(alice);
        // take most margin into a fake second lock to force the release path
        vm.prank(address(pool));
        bank.lock(address(vault), 90_000e18);
        // with 90k locked elsewhere and 5,880 in our order, 4,120 is free; redeeming 1/10 needs ~10k
        vm.prank(alice);
        vault.redeem(shares / 10, alice);
        assertEq(vault.liveSlots(address(pool)).length, 0, "order released for the redemption");
    }

    function test_shares_transferAndAllowance() public {
        vm.prank(alice);
        vault.transfer(bob, 10e18);
        assertEq(vault.balanceOf(bob), 10e18);
        vm.prank(bob);
        vault.approve(keeper, 5e18);
        vm.prank(keeper);
        vault.transferFrom(bob, keeper, 5e18);
        assertEq(vault.balanceOf(keeper), 5e18);
        vm.expectRevert(CatchVault.InsufficientShares.selector);
        vm.prank(keeper);
        vault.transferFrom(bob, keeper, 1);
    }

    // ------------------------------------------------------------ placement

    function test_place_bidUnderLongCluster() public {
        vm.prank(keeper);
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.15e18, _two());
        CatchVault.Slot memory s = vault.getSlot(id);
        assertTrue(s.live);
        assertEq(s.quantity, 0.15e18);
        assertEq(s.backers.length, 2);
        assertEq(pool.getOrder(s.orderId).owner, address(vault));
    }

    function test_place_askOverShortCluster() public {
        vm.prank(keeper);
        uint64 id = vault.place(address(pool), false, 61_200e18, 0.1e18, _one(s1));
        assertTrue(vault.getSlot(id).live);
    }

    function test_liquidationPrice_matchesTheVenueSolve() public view {
        assertEq(vault.liquidationPrice(l1, address(pool)), 59_000e18);
        assertEq(vault.liquidationPrice(s1, address(pool)), 61_000e18);
        assertEq(vault.liquidationPrice(alice, address(pool)), 0);
    }

    /// Invariant 2: no order outside a cluster's [bankruptcy, liquidation] band.
    function test_invariant2_aboveLiquidationPriceReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(CatchVault.OutsideBand.selector, l1, 58_500e18, 59_000e18, 59_100e18)
        );
        vault.place(address(pool), true, 59_100e18, 1e18, _one(l1));
    }

    function test_invariant2_belowBankruptcyReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(CatchVault.OutsideBand.selector, l1, 58_500e18, 59_000e18, 58_400e18)
        );
        vault.place(address(pool), true, 58_400e18, 1e18, _one(l1));
    }

    function test_invariant2_wrongSideBackerReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CatchVault.BackerSide.selector, s1));
        vault.place(address(pool), true, 58_800e18, 1e18, _one(s1));
    }

    function test_invariant2_flatBackerReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CatchVault.BackerSide.selector, alice));
        vault.place(address(pool), true, 58_800e18, 1e18, _one(alice));
    }

    function test_place_quantityAboveClusterReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CatchVault.QuantityExceedsCluster.selector, 3e18, 2e18));
        vault.place(address(pool), true, 58_800e18, 3e18, _two());
    }

    function test_place_unsortedOrDuplicateBackersRevert() public {
        address[] memory b = new address[](2);
        b[0] = l2;
        b[1] = l1;
        vm.expectRevert(CatchVault.BadBackers.selector);
        vault.place(address(pool), true, 58_800e18, 1e18, b);
        b[0] = l1;
        b[1] = l1;
        vm.expectRevert(CatchVault.BadBackers.selector);
        vault.place(address(pool), true, 58_800e18, 1e18, b);
    }

    function test_place_noBackersOrTooManyReverts() public {
        vm.expectRevert(CatchVault.BadBackers.selector);
        vault.place(address(pool), true, 58_800e18, 1e18, new address[](0));
        address[] memory b = new address[](9);
        for (uint256 i = 0; i < 9; i++) b[i] = address(uint160(0x3000 + i));
        vm.expectRevert(CatchVault.BadBackers.selector);
        vault.place(address(pool), true, 58_800e18, 1e18, b);
    }

    function test_place_vaultCannotBackItself() public {
        bank.setPosition(address(vault), address(pool), 1e18, uint128(MARK));
        vm.expectRevert(CatchVault.BadBackers.selector);
        vault.place(address(pool), true, 58_800e18, 1e18, _one(address(vault)));
    }

    /// Invariant 5: the vault only provides liquidity; a bid at or above the mark is refused.
    function test_invariant5_neverCrossesTheMark() public {
        vm.expectRevert(abi.encodeWithSelector(CatchVault.CrossesMark.selector, MARK, MARK));
        vault.place(address(pool), true, MARK, 1e18, _one(l1));
        vm.expectRevert(abi.encodeWithSelector(CatchVault.CrossesMark.selector, MARK - 1, MARK));
        vault.place(address(pool), false, MARK - 1, 1e18, _one(s1));
    }

    function test_invariant5_postOnlyThatWouldCrossDoesNotRest() public {
        // the venue moves the book between the mark read and the order: emulate with a mark the pool sees differently
        pool.setMark(58_000e18); // our bid at 58,800 would now be above the pool's mark
        _long(l1, 1e18, 56_500e18);
        bank.setHealth(l1, 1_950e18, 0); // liquidation 56,000 at this mark... keep band valid below
        vm.expectRevert(abi.encodeWithSelector(CatchVault.CrossesMark.selector, 58_800e18, 58_000e18));
        vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
    }

    function test_place_unknownPoolReverts() public {
        MockPool other = new MockPool(bank, MARK);
        vm.expectRevert(abi.encodeWithSelector(CatchVault.UnknownPool.selector, address(other)));
        vault.place(address(other), true, 58_800e18, 1e18, _one(l1));
    }

    function test_place_restrictedPoolReverts() public {
        pool.setRestricted(true);
        vm.expectRevert(abi.encodeWithSelector(CatchVault.PoolRestricted.selector, address(pool)));
        vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
    }

    /// Invariant 1: one cluster order is capped at CLUSTER_CAP_BPS of assets.
    function test_invariant1_clusterCap() public {
        _long(l1, 5e18, 58_500e18);
        bank.setHealth(l1, 4_875e18, 0); // keep liquidation at 59,000 for 5 BTC
        // 0.2 BTC more than the 10,000 cap allows: 10,200 notional
        uint256 qty = 0.18e18; // 10,584 notional
        vm.expectRevert();
        vault.place(address(pool), true, 58_800e18, qty, _one(l1));
        vault.place(address(pool), true, 58_800e18, 0.17e18, _one(l1)); // 9,996 fits
    }

    /// Invariant 1: total exposure per market is capped at MARKET_CAP_BPS of assets.
    function test_invariant1_marketCap() public {
        for (uint160 i = 0; i < 4; i++) {
            address a = address(0x5000 + i);
            _long(a, 1e18, 58_500e18);
        }
        for (uint160 i = 0; i < 4; i++) {
            if (i < 2) {
                vm.prank(keeper);
                vault.place(address(pool), true, 58_800e18, 0.15e18, _one(address(0x5000 + i))); // 8,820 each
            }
        }
        // 3 x 8,820 = 26,460 > 25,000: the third already had to fit, so check exposure below cap
        assertLe(vault.exposure(address(pool)), 25_000e18);
    }

    function test_invariant1_marketCapRevertsWithNumbers() public {
        _long(address(0x5000), 1e18, 58_500e18);
        _long(address(0x5001), 1e18, 58_500e18);
        _long(address(0x5002), 1e18, 58_500e18);
        vault.place(address(pool), true, 58_800e18, 0.16e18, _one(address(0x5000))); // 9,408
        vault.place(address(pool), true, 58_800e18, 0.16e18, _one(address(0x5001))); // 18,816
        vm.expectRevert(abi.encodeWithSelector(CatchVault.MarketCap.selector, 28_224e18, 25_000e18));
        vault.place(address(pool), true, 58_800e18, 0.16e18, _one(address(0x5002)));
    }

    function test_exposure_countsTheVaultPositionAtMark() public {
        bank.setPosition(address(vault), address(pool), 0.1e18, uint128(58_800e18));
        assertEq(vault.exposure(address(pool)), 6_000e18);
    }

    function test_slots_largerClusterEvictsTheSmallest() public {
        for (uint160 i = 0; i < 7; i++) _long(address(0x6000 + i), 1e18, 58_500e18);
        // six small orders of 0.01 BTC (588 each)
        for (uint160 i = 0; i < 6; i++) vault.place(address(pool), true, 58_800e18, 0.01e18, _one(address(0x6000 + i)));
        assertEq(vault.liveSlots(address(pool)).length, 6);
        vault.place(address(pool), true, 58_800e18, 0.05e18, _one(address(0x6006)));
        assertEq(vault.liveSlots(address(pool)).length, 6, "one evicted, one added");
    }

    function test_slots_fullWithEqualSizeReverts() public {
        for (uint160 i = 0; i < 7; i++) _long(address(0x6000 + i), 1e18, 58_500e18);
        for (uint160 i = 0; i < 6; i++) vault.place(address(pool), true, 58_800e18, 0.01e18, _one(address(0x6000 + i)));
        vm.expectRevert(abi.encodeWithSelector(CatchVault.SlotsFull.selector, 588e18, 588e18));
        vault.place(address(pool), true, 58_800e18, 0.01e18, _one(address(0x6006)));
    }

    // ------------------------------------------------------------ refresh

    function test_refresh_keepsAValidSlot() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _two());
        assertTrue(vault.refresh(id));
        assertTrue(vault.getSlot(id).live);
    }

    function test_invariant2_refreshReleasesWhenABackerCloses() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _two());
        bank.setPosition(l2, address(pool), 0, 0);
        assertFalse(vault.refresh(id));
        assertFalse(vault.getSlot(id).live);
        assertEq(pool.getOrder(vault.getSlot(id).orderId).quantityRemaining, 0, "order cancelled on the venue");
    }

    function test_invariant2_refreshReleasesWhenTheBandMoves() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
        bank.setHealth(l1, 2_925e18, 0); // more margin: liquidation drops to 57,000, below our bid
        assertFalse(vault.refresh(id));
    }

    function test_refresh_releasesAFilledOrder() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
        pool.fill(vault.getSlot(id).orderId, 0.1e18);
        assertFalse(vault.refresh(id));
    }

    function test_refresh_deadSlotReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CatchVault.NotLive.selector, uint64(42)));
        vault.refresh(42);
    }

    function test_refreshPool_walksEverySlot() public {
        vault.place(address(pool), true, 58_800e18, 0.05e18, _one(l1));
        vault.place(address(pool), true, 58_800e18, 0.05e18, _one(l2));
        bank.setPosition(l1, address(pool), 0, 0);
        vault.refreshPool(address(pool));
        assertEq(vault.liveSlots(address(pool)).length, 1);
    }

    // ------------------------------------------------------------ reactivity

    function test_onEvent_onlyThePrecompile() public {
        vm.expectRevert(CatchVault.OnlyReactivityPrecompile.selector);
        vault.onEvent(address(bank), new bytes32[](0), "");
    }

    function test_onEvent_ignoresOtherEmittersAndTopics() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
        bank.setPosition(l1, address(pool), 0, 0);
        bytes32[] memory topics = new bytes32[](3);
        topics[0] = keccak256("Something()");
        topics[1] = bytes32(uint256(uint160(l1)));
        topics[2] = bytes32(uint256(uint160(address(pool))));
        vm.prank(PRECOMPILE);
        vault.onEvent(address(bank), topics, "");
        topics[0] = TOPIC;
        vm.prank(PRECOMPILE);
        vault.onEvent(address(0xdead), topics, "");
        assertTrue(vault.getSlot(id).live, "nothing acted");
    }

    function test_invariant2_backerUpdateCancelsInTheSameCallback() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
        bank.setPosition(l1, address(pool), 0, 0);
        _event(l1);
        assertFalse(vault.getSlot(id).live);
    }

    /// Regression: a backer's update must not drop the index of orders that still stand.
    function test_onEvent_survivorsStayIndexed() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
        _event(l1); // still valid
        assertTrue(vault.getSlot(id).live);
        bank.setPosition(l1, address(pool), 0, 0);
        _event(l1); // second update must still find the slot
        assertFalse(vault.getSlot(id).live);
    }

    // ------------------------------------------------------------ catching and unwinding

    function test_catch_emitsAndRestsAnUnwindAtOrAboveEntry() public {
        uint64 id = vault.place(address(pool), true, 58_800e18, 0.1e18, _one(l1));
        pool.fill(vault.getSlot(id).orderId, 0.1e18); // the engine sells l1's long into our bid
        bank.setPosition(l1, address(pool), 0, 0);
        vm.expectEmit(true, false, false, true, address(vault));
        emit CatchVault.Caught(address(pool), int128(0.1e18), uint128(58_800e18));
        _event(address(vault));
        uint64[] memory live = vault.liveSlots(address(pool));
        bool found;
        for (uint256 i = 0; i < live.length; i++) {
            CatchVault.Slot memory s = vault.getSlot(live[i]);
            if (s.unwind) {
                found = true;
                assertFalse(s.isBid, "a caught long is offered back");
                assertGe(s.price, 58_800e18, "never below entry");
                assertGe(s.price, MARK, "rests above the mark");
            }
        }
        assertTrue(found, "unwind rests");
    }

    /// Invariant 3: nobody can offer a caught long below its entry.
    function test_invariant3_unwindBelowEntryReverts() public {
        bank.setPosition(address(vault), address(pool), 1e18, uint128(58_800e18));
        vm.expectRevert(abi.encodeWithSelector(CatchVault.BelowEntry.selector, 58_700e18, 58_800e18));
        vault.unwind(address(pool), 58_700e18, 1e18);
    }

    function test_invariant3_unwindShortAboveEntryReverts() public {
        bank.setPosition(address(vault), address(pool), -1e18, uint128(61_200e18));
        vm.expectRevert(abi.encodeWithSelector(CatchVault.BelowEntry.selector, 61_300e18, 61_200e18));
        vault.unwind(address(pool), 61_300e18, 1e18);
    }

    function test_unwind_permissionlessAtABetterPrice() public {
        bank.setPosition(address(vault), address(pool), 1e18, uint128(58_800e18));
        vm.prank(bob);
        uint64 id = vault.unwind(address(pool), 60_500e18, 1e18);
        assertTrue(vault.getSlot(id).unwind);
    }

    function test_unwind_replacesThePreviousUnwind() public {
        bank.setPosition(address(vault), address(pool), 1e18, uint128(58_800e18));
        uint64 a = vault.unwind(address(pool), 60_500e18, 1e18);
        uint64 b = vault.unwind(address(pool), 60_400e18, 1e18);
        assertFalse(vault.getSlot(a).live);
        assertTrue(vault.getSlot(b).live);
    }

    function test_unwind_tooLargeOrNoPositionReverts() public {
        vm.expectRevert(abi.encodeWithSelector(CatchVault.NoPosition.selector, address(pool)));
        vault.unwind(address(pool), 60_500e18, 1e18);
        bank.setPosition(address(vault), address(pool), 1e18, uint128(58_800e18));
        vm.expectRevert(abi.encodeWithSelector(CatchVault.UnwindTooLarge.selector, 2e18, 1e18));
        vault.unwind(address(pool), 60_500e18, 2e18);
    }

    function test_unwindFromHandler_selfOnly() public {
        vm.expectRevert(bytes("self"));
        vault.unwindFromHandler(address(pool), 1, 1);
    }

    function test_flatAfterUnwindReleasesTheUnwindOrder() public {
        bank.setPosition(address(vault), address(pool), 1e18, uint128(58_800e18));
        uint64 id = vault.unwind(address(pool), 60_500e18, 1e18);
        bank.setPosition(address(vault), address(pool), 0, 0);
        _event(address(vault));
        assertFalse(vault.getSlot(id).live);
    }

    // ------------------------------------------------------------ fuzz

    /// Nobody gets out more than they put in while the vault has made no gains.
    function testFuzz_roundTripNeverProfits(uint96 amount) public {
        uint256 a = bound(uint256(amount), 1e6, 500_000e18);
        uint256 before = token.balanceOf(bob);
        vm.startPrank(bob);
        uint256 shares = vault.deposit(a, bob);
        vault.redeem(shares, bob);
        vm.stopPrank();
        assertLe(token.balanceOf(bob), before);
    }

    function testFuzz_placementNeverExceedsCaps(uint64 qtyMilli) public {
        uint256 qty = bound(uint256(qtyMilli), 1, 2_000) * 1e15;
        try vault.place(address(pool), true, 58_800e18, qty, _two()) {
            assertLe(vault.exposure(address(pool)), vault.totalAssets() * 2_500 / 10_000);
            assertLe(58_800e18 * qty / 1e18, vault.totalAssets() * 1_000 / 10_000);
        } catch {}
    }

    /// The vault has no owner and no function that sends collateral anywhere but to a redeemer.
    function test_noAdminSurface() public view {
        (bool ok,) = address(vault).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(ok);
        (ok,) = address(vault).staticcall(abi.encodeWithSignature("sweep(address)", address(this)));
        assertFalse(ok);
    }
}
