// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BountyWallet} from "../src/BountyWallet.sol";
import {BountyFixture} from "./utils/BountyFixture.sol";

contract BountyWalletFuzzTest is BountyFixture {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    function testFuzz_keeperPay_succeedsExactlyWithinBothLimits(
        uint256 perPayout,
        uint256 periodLimit,
        uint256 spent,
        uint256 amount
    ) public {
        perPayout = bound(perPayout, 0, 300e6);
        periodLimit = bound(periodLimit, 0, 400e6);
        spent = bound(spent, 0, 200e6);
        amount = bound(amount, 1, 300e6);
        vm.prank(maintainer);
        wallet.setLimits(type(uint256).max, type(uint256).max, PERIOD);
        if (spent > 0) {
            _post(1, spent);
            _keeperPay(1, contributor);
        }
        vm.prank(maintainer);
        wallet.setLimits(perPayout, periodLimit, PERIOD);
        _post(2, amount);

        if (amount > perPayout) vm.expectRevert(BountyWallet.AbovePayoutLimit.selector);
        else if (spent + amount > periodLimit) vm.expectRevert(BountyWallet.AbovePeriodLimit.selector);
        _keeperPay(2, contributor);

        if (amount <= perPayout && spent + amount <= periodLimit) {
            assertEq(usdc.balanceOf(contributor), spent + amount);
            assertEq(wallet.spentInPeriod(), spent + amount);
        }
    }

    function testFuzz_keeperPay_neverPaysMoreThanThePeriodLimitInOnePeriod(
        uint256[8] memory amounts,
        uint256[8] memory gaps
    ) public {
        uint256 periodStart;
        uint256 paidInPeriod;
        for (uint64 i; i < 8; ++i) {
            vm.warp(vm.getBlockTimestamp() + bound(gaps[i], 0, 3 days));
            uint256 amount = bound(amounts[i], 1, PER_PAYOUT);
            if (amount > wallet.available()) return;
            _post(i, amount);
            bool newPeriod = vm.getBlockTimestamp() >= periodStart + PERIOD;
            vm.prank(keeper);
            try wallet.keeperPay(i, contributor) {
                if (newPeriod) (periodStart, paidInPeriod) = (vm.getBlockTimestamp(), 0);
                paidInPeriod += amount;
            } catch {}
            assertLe(paidInPeriod, PERIOD_LIMIT);
            assertEq(wallet.spentInPeriod(), paidInPeriod);
            assertEq(wallet.periodStart(), periodStart);
        }
    }

    function testFuzz_payWithSignature_rejectsEverySignerButTheOwner(uint256 signerPk) public {
        signerPk = bound(signerPk, 1, SECP256K1_N - 1);
        vm.assume(signerPk != maintainerPk);
        _post(42, 30e6);
        bytes memory sig = _signPayout(signerPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp, sig);
    }

    function testFuzz_payWithSignature_paysOnlyTheSignedPayout(
        uint64 signedIssue,
        uint256 signedSerial,
        address signedPayee,
        uint256 signedAmount,
        uint256 signedDeadline
    ) public {
        signedDeadline = bound(signedDeadline, block.timestamp, type(uint256).max);
        _post(42, 30e6);
        bool exact = signedIssue == 42 && signedSerial == 1 && signedPayee == contributor && signedAmount == 30e6
            && signedDeadline == block.timestamp;
        bytes memory sig =
            _signPayout(maintainerPk, signedIssue, signedSerial, signedPayee, signedAmount, signedDeadline);

        if (!exact) vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp, sig);
    }

    function testFuzz_withdraw_neverReachesReservedFunds(uint256 reservedAmount, uint256 amount) public {
        reservedAmount = bound(reservedAmount, 1, FUNDED);
        amount = bound(amount, 1, 2 * FUNDED);
        _post(42, reservedAmount);

        if (amount > FUNDED - reservedAmount) vm.expectRevert(BountyWallet.InsufficientFunds.selector);
        vm.prank(maintainer);
        wallet.withdraw(maintainer, amount);

        assertGe(usdc.balanceOf(address(wallet)), reservedAmount);
        assertEq(wallet.reserved(), reservedAmount);
    }

    function testFuzz_setLimits_acceptsExactlyThePeriodBounds(uint32 periodLength) public {
        bool valid = periodLength >= 1 hours && periodLength <= 365 days;

        if (!valid) vm.expectRevert(BountyWallet.InvalidPeriodLength.selector);
        vm.prank(maintainer);
        wallet.setLimits(1, 2, periodLength);

        if (valid) assertEq(wallet.periodLength(), periodLength);
    }

    function testFuzz_create_landsAtThePredictedAddress(bytes32 repoId, address owner) public {
        vm.assume(owner != address(0) && owner != keeper);
        vm.assume(!(repoId == REPO && owner == maintainer));
        address predicted = factory.predict(repoId, owner);

        BountyWallet w = _create(owner, repoId);

        assertEq(address(w), predicted);
        assertEq(factory.walletOf(repoId, owner), predicted);
        assertEq(w.owner(), owner);
        assertEq(w.repoId(), repoId);
    }
}
