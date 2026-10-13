// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BountyWallet} from "../src/BountyWallet.sol";
import {BountyWalletFactory} from "../src/BountyWalletFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {BountyFixture} from "./utils/BountyFixture.sol";

contract BountyWalletTest is BountyFixture {
    function test_fund_pullsFromAnyFunder() public {
        address sponsor = makeAddr("sponsor");
        usdc.mint(sponsor, 10e6);
        vm.prank(sponsor);
        usdc.approve(address(wallet), 10e6);

        vm.expectEmit(address(wallet));
        emit BountyWallet.Funded(sponsor, 10e6);
        vm.prank(sponsor);
        wallet.fund(10e6);

        assertEq(usdc.balanceOf(address(wallet)), FUNDED + 10e6);
        assertEq(wallet.available(), FUNDED + 10e6);
    }

    function test_fund_revertsOnZero() public {
        vm.expectRevert(BountyWallet.InvalidAmount.selector);
        vm.prank(maintainer);
        wallet.fund(0);
    }

    function test_fundWithAuthorization_takesOneSignatureAnyoneRelays() public {
        (address sponsor, uint256 sponsorPk) = makeAddrAndKey("sponsor");
        usdc.mint(sponsor, 10e6);
        bytes memory sig =
            _signReceive(sponsorPk, sponsor, address(wallet), 10e6, block.timestamp - 1, block.timestamp + 1 hours, "n");

        vm.expectEmit(address(wallet));
        emit BountyWallet.Funded(sponsor, 10e6);
        vm.prank(makeAddr("relayer"));
        wallet.fundWithAuthorization(sponsor, 10e6, block.timestamp - 1, block.timestamp + 1 hours, "n", sig);

        assertEq(usdc.balanceOf(sponsor), 0);
        assertEq(wallet.available(), FUNDED + 10e6);
    }

    function test_fundWithAuthorization_revertsWhenReplayed() public {
        (address sponsor, uint256 sponsorPk) = makeAddrAndKey("sponsor");
        usdc.mint(sponsor, 20e6);
        bytes memory sig =
            _signReceive(sponsorPk, sponsor, address(wallet), 10e6, block.timestamp - 1, block.timestamp + 1 hours, "n");
        wallet.fundWithAuthorization(sponsor, 10e6, block.timestamp - 1, block.timestamp + 1 hours, "n", sig);

        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        wallet.fundWithAuthorization(sponsor, 10e6, block.timestamp - 1, block.timestamp + 1 hours, "n", sig);
    }

    function test_fundWithAuthorization_cannotBeRedeemedByAnotherWallet() public {
        (address sponsor, uint256 sponsorPk) = makeAddrAndKey("sponsor");
        usdc.mint(sponsor, 10e6);
        BountyWallet other = _create(maintainer, keccak256("github:tonymorony/other"));
        bytes memory sig =
            _signReceive(sponsorPk, sponsor, address(wallet), 10e6, block.timestamp - 1, block.timestamp + 1 hours, "n");

        vm.expectRevert("FiatTokenV2: invalid signature");
        other.fundWithAuthorization(sponsor, 10e6, block.timestamp - 1, block.timestamp + 1 hours, "n", sig);
    }

    function test_fundWithAuthorization_revertsOnZero() public {
        vm.expectRevert(BountyWallet.InvalidAmount.selector);
        wallet.fundWithAuthorization(maintainer, 0, 0, type(uint256).max, "n", "");
    }

    function test_directTransfer_isAvailableToTheOwner() public {
        usdc.mint(address(wallet), 3e6);

        assertEq(wallet.available(), FUNDED + 3e6);
    }

    function test_postBounty_reservesTheAmountUnderANewSerial() public {
        vm.expectEmit(address(wallet));
        emit BountyWallet.BountyPosted(42, 1, 30e6);
        vm.prank(maintainer);
        wallet.postBounty(42, 30e6);

        BountyWallet.Bounty memory b = wallet.bountyOf(42);
        assertEq(b.amount, 30e6);
        assertEq(b.serial, 1);
        assertEq(uint8(b.status), uint8(BountyWallet.Status.Open));
        assertEq(b.payee, address(0));
        assertEq(wallet.reserved(), 30e6);
        assertEq(wallet.available(), FUNDED - 30e6);
        assertEq(wallet.lastSerial(), 1);
    }

    function test_postBounty_revertsForAnyoneButTheOwner() public {
        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(keeper);
        wallet.postBounty(42, 30e6);
        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(contributor);
        wallet.postBounty(42, 30e6);
    }

    function test_postBounty_revertsOnZero() public {
        vm.expectRevert(BountyWallet.InvalidAmount.selector);
        vm.prank(maintainer);
        wallet.postBounty(42, 0);
    }

    function test_postBounty_revertsAboveTheUnreservedBalance() public {
        _post(1, 300e6);

        vm.expectRevert(BountyWallet.InsufficientFunds.selector);
        vm.prank(maintainer);
        wallet.postBounty(2, 200e6 + 1);
    }

    function test_postBounty_acceptsExactlyTheUnreservedBalance() public {
        _post(1, 300e6);
        _post(2, 200e6);

        assertEq(wallet.available(), 0);
        assertEq(wallet.reserved(), FUNDED);
    }

    function test_postBounty_revertsWhileOpen() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.BountyAlreadyPosted.selector);
        vm.prank(maintainer);
        wallet.postBounty(42, 40e6);
    }

    function test_postBounty_revertsOncePaid() public {
        _post(42, 30e6);
        _keeperPay(42, contributor);

        vm.expectRevert(BountyWallet.BountyAlreadyPaid.selector);
        vm.prank(maintainer);
        wallet.postBounty(42, 30e6);
    }

    function test_postBounty_afterCancelGetsANewSerial() public {
        _post(42, 30e6);
        vm.prank(maintainer);
        wallet.cancelBounty(42);

        uint64 serial = _post(42, 40e6);

        assertEq(serial, 2);
        assertEq(wallet.bountyOf(42).amount, 40e6);
        assertEq(wallet.reserved(), 40e6);
    }

    function test_cancelBounty_releasesTheReservation() public {
        _post(42, 30e6);

        vm.expectEmit(address(wallet));
        emit BountyWallet.BountyCancelled(42, 1, 30e6);
        vm.prank(maintainer);
        wallet.cancelBounty(42);

        assertEq(uint8(wallet.bountyOf(42).status), uint8(BountyWallet.Status.Cancelled));
        assertEq(wallet.reserved(), 0);
        assertEq(wallet.available(), FUNDED);
    }

    function test_cancelBounty_revertsForAnyoneButTheOwner() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(keeper);
        wallet.cancelBounty(42);
    }

    function test_cancelBounty_revertsUnlessOpen() public {
        vm.expectRevert(BountyWallet.BountyNotOpen.selector);
        vm.prank(maintainer);
        wallet.cancelBounty(42);

        _post(42, 30e6);
        _keeperPay(42, contributor);
        vm.expectRevert(BountyWallet.BountyNotOpen.selector);
        vm.prank(maintainer);
        wallet.cancelBounty(42);
    }

    function test_keeperPay_paysThePostedAmountToThePayee() public {
        _post(42, 30e6);

        vm.expectEmit(address(wallet));
        emit BountyWallet.Paid(42, 1, contributor, 30e6, BountyWallet.Method.Keeper);
        _keeperPay(42, contributor);

        BountyWallet.Bounty memory b = wallet.bountyOf(42);
        assertEq(uint8(b.status), uint8(BountyWallet.Status.Paid));
        assertEq(b.payee, contributor);
        assertEq(usdc.balanceOf(contributor), 30e6);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(usdc.balanceOf(address(wallet)), FUNDED - 30e6);
        assertEq(wallet.reserved(), 0);
        assertEq(wallet.spentInPeriod(), 30e6);
        assertEq(wallet.periodStart(), START);
    }

    function test_keeperPay_revertsForAnyoneButTheKeeper() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.NotKeeper.selector);
        vm.prank(maintainer);
        wallet.keeperPay(42, contributor);
        vm.expectRevert(BountyWallet.NotKeeper.selector);
        vm.prank(contributor);
        wallet.keeperPay(42, contributor);
    }

    function test_keeperPay_paysOnlyOnce() public {
        _post(42, 30e6);
        _keeperPay(42, contributor);

        vm.expectRevert(BountyWallet.BountyNotOpen.selector);
        _keeperPay(42, makeAddr("someoneElse"));
    }

    function test_keeperPay_revertsForAnIssueWithoutABounty() public {
        vm.expectRevert(BountyWallet.BountyNotOpen.selector);
        _keeperPay(42, contributor);
    }

    function test_keeperPay_revertsForACancelledBounty() public {
        _post(42, 30e6);
        vm.prank(maintainer);
        wallet.cancelBounty(42);

        vm.expectRevert(BountyWallet.BountyNotOpen.selector);
        _keeperPay(42, contributor);
    }

    function test_keeperPay_revertsWhileDisabledAndWorksOnceReenabled() public {
        _post(42, 30e6);
        vm.expectEmit(address(wallet));
        emit BountyWallet.KeeperEnabled(false);
        vm.prank(maintainer);
        wallet.setKeeperEnabled(false);

        vm.expectRevert(BountyWallet.KeeperDisabled.selector);
        _keeperPay(42, contributor);

        vm.prank(maintainer);
        wallet.setKeeperEnabled(true);
        _keeperPay(42, contributor);
        assertEq(usdc.balanceOf(contributor), 30e6);
    }

    function test_keeperPay_paysExactlyThePerPayoutLimit() public {
        _post(42, PER_PAYOUT);

        _keeperPay(42, contributor);

        assertEq(usdc.balanceOf(contributor), PER_PAYOUT);
    }

    function test_keeperPay_revertsAboveThePerPayoutLimit() public {
        _post(42, PER_PAYOUT + 1);

        vm.expectRevert(BountyWallet.AbovePayoutLimit.selector);
        _keeperPay(42, contributor);
    }

    function test_keeperPay_revertsAbovePeriodLimit() public {
        _post(1, 100e6);
        _post(2, 100e6);
        _post(3, 50e6 + 1);
        _keeperPay(1, contributor);
        _keeperPay(2, contributor);

        vm.expectRevert(BountyWallet.AbovePeriodLimit.selector);
        _keeperPay(3, contributor);
        assertEq(wallet.keeperAllowance(), 50e6);
    }

    function test_keeperPay_paysExactlyThePeriodLimit() public {
        _post(1, 100e6);
        _post(2, 100e6);
        _post(3, 50e6);
        _keeperPay(1, contributor);
        _keeperPay(2, contributor);

        _keeperPay(3, contributor);

        assertEq(wallet.spentInPeriod(), PERIOD_LIMIT);
        assertEq(wallet.keeperAllowance(), 0);
    }

    function test_keeperPay_newPeriodStartsAfterPeriodLength() public {
        _post(1, 100e6);
        _post(2, 100e6);
        _post(3, 100e6);
        _keeperPay(1, contributor);
        _keeperPay(2, contributor);
        vm.warp(START + PERIOD - 1);
        vm.expectRevert(BountyWallet.AbovePeriodLimit.selector);
        _keeperPay(3, contributor);

        vm.warp(START + PERIOD);
        assertEq(wallet.keeperAllowance(), PERIOD_LIMIT);
        _keeperPay(3, contributor);

        assertEq(wallet.periodStart(), START + PERIOD);
        assertEq(wallet.spentInPeriod(), 100e6);
    }

    function test_keeperPay_aPeriodStartsAtTheFirstPayoutAfterTheLastEnded() public {
        _post(1, 100e6);
        _post(2, 100e6);
        _keeperPay(1, contributor);
        vm.warp(START + PERIOD + 3 days);

        _keeperPay(2, contributor);

        assertEq(wallet.periodStart(), START + PERIOD + 3 days);
    }

    function test_keeperPay_revertsForAZeroPayee() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.InvalidRecipient.selector);
        _keeperPay(42, address(0));
    }

    function test_keeperPay_revertsWhenThePayeeIsTheKeeper() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.InvalidRecipient.selector);
        _keeperPay(42, keeper);
    }

    function test_keeperPay_revertsWhenThePayeeIsTheWallet() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.InvalidRecipient.selector);
        _keeperPay(42, address(wallet));
    }

    function test_keeperPay_mayPayTheOwner() public {
        _post(42, 30e6);
        uint256 before = usdc.balanceOf(maintainer);

        _keeperPay(42, maintainer);

        assertEq(usdc.balanceOf(maintainer), before + 30e6);
    }

    function test_setLimits_loweringAppliesAtOnceAndKeepsWhatThePeriodSpent() public {
        _post(1, 60e6);
        _post(2, 60e6);
        _keeperPay(1, contributor);

        vm.expectEmit(address(wallet));
        emit BountyWallet.LimitsSet(80e6, 100e6, PERIOD);
        vm.prank(maintainer);
        wallet.setLimits(80e6, 100e6, PERIOD);

        assertEq(wallet.spentInPeriod(), 60e6);
        vm.expectRevert(BountyWallet.AbovePeriodLimit.selector);
        _keeperPay(2, contributor);
    }

    function test_setLimits_raisingAppliesAtOnce() public {
        _post(42, 200e6);
        vm.expectRevert(BountyWallet.AbovePayoutLimit.selector);
        _keeperPay(42, contributor);

        vm.prank(maintainer);
        wallet.setLimits(200e6, PERIOD_LIMIT, PERIOD);

        _keeperPay(42, contributor);
        assertEq(usdc.balanceOf(contributor), 200e6);
    }

    function test_setLimits_zeroStopsEveryKeeperPayout() public {
        _post(42, 1);
        vm.prank(maintainer);
        wallet.setLimits(0, 0, PERIOD);

        vm.expectRevert(BountyWallet.AbovePayoutLimit.selector);
        _keeperPay(42, contributor);
    }

    function test_setLimits_revertsForAnyoneButTheOwner() public {
        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(keeper);
        wallet.setLimits(type(uint256).max, type(uint256).max, PERIOD);
    }

    function test_setLimits_revertsOnPeriodLengthOutOfBounds() public {
        vm.startPrank(maintainer);
        vm.expectRevert(BountyWallet.InvalidPeriodLength.selector);
        wallet.setLimits(PER_PAYOUT, PERIOD_LIMIT, 1 hours - 1);
        vm.expectRevert(BountyWallet.InvalidPeriodLength.selector);
        wallet.setLimits(PER_PAYOUT, PERIOD_LIMIT, 365 days + 1);
        vm.stopPrank();
    }

    function test_setKeeperEnabled_revertsForAnyoneButTheOwner() public {
        vm.prank(maintainer);
        wallet.setKeeperEnabled(false);

        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(keeper);
        wallet.setKeeperEnabled(true);
    }

    function test_payWithSignature_relayedOwnerSignaturePaysAboveTheLimitsWithTheKeeperDisabled() public {
        _post(42, 400e6);
        vm.prank(maintainer);
        wallet.setKeeperEnabled(false);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 400e6, deadline);
        address relayer = makeAddr("relayer");

        vm.expectEmit(address(wallet));
        emit BountyWallet.Paid(42, 1, contributor, 400e6, BountyWallet.Method.Signature);
        vm.prank(relayer);
        wallet.payWithSignature(42, contributor, deadline, sig);

        assertEq(usdc.balanceOf(contributor), 400e6);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(wallet.reserved(), 0);
        assertEq(wallet.spentInPeriod(), 0);
        assertEq(uint8(wallet.bountyOf(42).status), uint8(BountyWallet.Status.Paid));
    }

    function test_payWithSignature_keeperMayRelay() public {
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.prank(keeper);
        wallet.payWithSignature(42, contributor, block.timestamp, sig);

        assertEq(usdc.balanceOf(contributor), 30e6);
    }

    function test_payWithSignature_revertsWhenSignedByTheKeeper() public {
        _post(42, 30e6);
        (, uint256 keeperPk) = makeAddrAndKey("keeper");
        bytes memory sig = _signPayout(keeperPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp, sig);
    }

    function test_payWithSignature_revertsForAnotherPayee() public {
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, makeAddr("thief"), block.timestamp, sig);
    }

    function test_payWithSignature_revertsForAnotherIssue() public {
        _post(42, 30e6);
        _post(43, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(43, contributor, block.timestamp, sig);
    }

    function test_payWithSignature_revertsForAnotherAmount() public {
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 3e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp, sig);
    }

    function test_payWithSignature_revertsForAnotherDeadline() public {
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp + 1, sig);
    }

    function test_payWithSignature_revertsForTheSameOwnersOtherWallet() public {
        BountyWallet other = _create(maintainer, keccak256("github:tonymorony/other"));
        vm.prank(maintainer);
        usdc.approve(address(other), type(uint256).max);
        vm.startPrank(maintainer);
        other.fund(30e6);
        other.postBounty(42, 30e6);
        vm.stopPrank();
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        other.payWithSignature(42, contributor, block.timestamp, sig);
    }

    function test_payWithSignature_aCancelledBountysSignatureDoesNotPayItsRepost() public {
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, block.timestamp + 1 days);
        vm.prank(maintainer);
        wallet.cancelBounty(42);
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp + 1 days, sig);
    }

    function test_payWithSignature_paysOnlyOnce() public {
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, block.timestamp);
        wallet.payWithSignature(42, contributor, block.timestamp, sig);

        vm.expectRevert(BountyWallet.BountyNotOpen.selector);
        wallet.payWithSignature(42, contributor, block.timestamp, sig);
    }

    function test_payWithSignature_worksAtTheDeadlineAndRevertsAfter() public {
        _post(42, 30e6);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory sig = _signPayout(maintainerPk, 42, 1, contributor, 30e6, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(BountyWallet.SignatureExpired.selector);
        wallet.payWithSignature(42, contributor, deadline, sig);

        vm.warp(deadline);
        wallet.payWithSignature(42, contributor, deadline, sig);
        assertEq(usdc.balanceOf(contributor), 30e6);
    }

    function test_payWithSignature_revertsWhenThePayeeIsTheKeeper() public {
        _post(42, 30e6);
        bytes memory sig = _signPayout(maintainerPk, 42, 1, keeper, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidRecipient.selector);
        wallet.payWithSignature(42, keeper, block.timestamp, sig);
    }

    function test_payWithSignature_rejectsAHighSSignature() public {
        _post(42, 30e6);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(maintainerPk, _payoutDigest(address(wallet), 42, 1, contributor, 30e6, block.timestamp));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleated = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp, malleated);
    }

    function test_payWithSignature_revertsOnMalformedSignature() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        wallet.payWithSignature(42, contributor, block.timestamp, hex"1234");
    }

    function test_payWithSignature_acceptsAContractWalletOwner() public {
        (address signer, uint256 signerPk) = makeAddrAndKey("safeSigner");
        address safe = address(new MockERC1271Wallet(signer));
        BountyWallet w = _create(safe, REPO);
        usdc.mint(address(w), 30e6);
        vm.prank(safe);
        w.postBounty(42, 30e6);
        bytes memory sig = _signPayoutAt(w, signerPk, 42, 1, contributor, 30e6, block.timestamp);

        w.payWithSignature(42, contributor, block.timestamp, sig);

        assertEq(usdc.balanceOf(contributor), 30e6);
    }

    function test_payWithSignature_revertsWhenTheContractWalletRejects() public {
        address safe = address(new MockERC1271Wallet(makeAddr("safeSigner")));
        BountyWallet w = _create(safe, REPO);
        usdc.mint(address(w), 30e6);
        vm.prank(safe);
        w.postBounty(42, 30e6);
        bytes memory sig = _signPayoutAt(w, maintainerPk, 42, 1, contributor, 30e6, block.timestamp);

        vm.expectRevert(BountyWallet.InvalidSignature.selector);
        w.payWithSignature(42, contributor, block.timestamp, sig);
    }

    function test_eip712Domain_isBonaFideBountyVersion1() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            wallet.eip712Domain();
        assertEq(name, "BonaFide Bounty");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(wallet));
    }

    function test_ownerPay_paysAboveTheLimitsWithTheKeeperDisabled() public {
        _post(42, 400e6);
        vm.startPrank(maintainer);
        wallet.setKeeperEnabled(false);

        vm.expectEmit(address(wallet));
        emit BountyWallet.Paid(42, 1, contributor, 400e6, BountyWallet.Method.Owner);
        wallet.ownerPay(42, contributor);
        vm.stopPrank();

        assertEq(usdc.balanceOf(contributor), 400e6);
        assertEq(wallet.reserved(), 0);
    }

    function test_ownerPay_revertsForAnyoneButTheOwner() public {
        _post(42, 30e6);

        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(keeper);
        wallet.ownerPay(42, contributor);
    }

    function test_ownerPay_revertsUnlessOpen() public {
        vm.expectRevert(BountyWallet.BountyNotOpen.selector);
        vm.prank(maintainer);
        wallet.ownerPay(42, contributor);
    }

    function test_withdraw_sendsUnreservedFundsToTheOwnersTarget() public {
        _post(42, 300e6);
        address cold = makeAddr("cold");

        vm.expectEmit(address(wallet));
        emit BountyWallet.Withdrawn(cold, 200e6);
        vm.prank(maintainer);
        wallet.withdraw(cold, 200e6);

        assertEq(usdc.balanceOf(cold), 200e6);
        assertEq(usdc.balanceOf(address(wallet)), 300e6);
        assertEq(wallet.available(), 0);
    }

    function test_withdraw_revertsIntoReservedFunds() public {
        _post(42, 300e6);

        vm.expectRevert(BountyWallet.InsufficientFunds.selector);
        vm.prank(maintainer);
        wallet.withdraw(maintainer, 200e6 + 1);
    }

    function test_withdraw_revertsForAnyoneButTheOwner() public {
        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(keeper);
        wallet.withdraw(keeper, 1);
        vm.expectRevert(BountyWallet.NotOwner.selector);
        vm.prank(contributor);
        wallet.withdraw(contributor, 1);
    }

    function test_withdraw_revertsOnZero() public {
        vm.expectRevert(BountyWallet.InvalidAmount.selector);
        vm.prank(maintainer);
        wallet.withdraw(maintainer, 0);
    }

    function test_withdraw_revertsToTheKeeperTheWalletOrZero() public {
        vm.startPrank(maintainer);
        vm.expectRevert(BountyWallet.InvalidRecipient.selector);
        wallet.withdraw(keeper, 1);
        vm.expectRevert(BountyWallet.InvalidRecipient.selector);
        wallet.withdraw(address(wallet), 1);
        vm.expectRevert(BountyWallet.InvalidRecipient.selector);
        wallet.withdraw(address(0), 1);
        vm.stopPrank();
    }

    function test_withdraw_worksWithTheKeeperDisabled() public {
        vm.startPrank(maintainer);
        wallet.setKeeperEnabled(false);
        wallet.withdraw(maintainer, FUNDED);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(wallet)), 0);
    }

    function test_keeperPay_reentrantTokenCannotPayTwice() public {
        ReentrantToken token = new ReentrantToken();
        BountyWalletFactory f = new BountyWalletFactory(MockUSDC(address(token)), keeper);
        vm.prank(maintainer);
        BountyWallet w = f.create(REPO, PER_PAYOUT, PERIOD_LIMIT, PERIOD);
        token.mint(address(w), 60e6);
        vm.startPrank(maintainer);
        w.postBounty(1, 30e6);
        w.postBounty(2, 30e6);
        vm.stopPrank();
        bytes memory sig = _signPayoutAt(w, maintainerPk, 2, 2, contributor, 30e6, block.timestamp);
        token.arm(address(w), abi.encodeCall(w.payWithSignature, (2, contributor, block.timestamp, sig)));

        vm.prank(keeper);
        w.keeperPay(1, contributor);

        assertTrue(token.reentered());
        assertFalse(token.reentrySucceeded());
        assertEq(bytes4(token.reentryResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(token.balanceOf(contributor), 30e6);
        assertEq(uint8(w.bountyOf(2).status), uint8(BountyWallet.Status.Open));
    }
}
