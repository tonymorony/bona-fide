// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {BonaFideEscrow} from "../../src/BonaFideEscrow.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {EscrowHandler} from "./EscrowHandler.sol";

contract BonaFideEscrowInvariantTest is Test {
    EscrowHandler internal handler;
    BonaFideEscrow internal escrow;
    MockUSDC internal usdc;

    function setUp() public {
        vm.warp(1_000_000);
        handler = new EscrowHandler();
        escrow = handler.escrow();
        usdc = handler.usdc();

        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = EscrowHandler.propose.selector;
        selectors[1] = EscrowHandler.activate.selector;
        selectors[2] = EscrowHandler.deposit.selector;
        selectors[3] = EscrowHandler.refundByKeeper.selector;
        selectors[4] = EscrowHandler.refundByAnyone.selector;
        selectors[5] = EscrowHandler.forfeit.selector;
        selectors[6] = EscrowHandler.maintainerSignsWithoutSubmitting.selector;
        selectors[7] = EscrowHandler.replayOldSignature.selector;
        selectors[8] = EscrowHandler.keeperForfeit.selector;
        selectors[9] = EscrowHandler.afterDeadline.selector;
        selectors[10] = EscrowHandler.warp.selector;
        selectors[11] = EscrowHandler.depositWithAuthorization.selector;
        selectors[12] = EscrowHandler.reuseAuthorization.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_1_usdcLeavesOnlyToOwnDepositorOrForfeitSink() public view {
        address[] memory tracked = handler.trackedAddresses();
        uint256 held = usdc.balanceOf(address(escrow));
        for (uint256 i; i < tracked.length; ++i) {
            assertEq(handler.inflow(tracked[i]), handler.expectedInflow(tracked[i]), "inflow differs from model");
            held += usdc.balanceOf(tracked[i]);
        }
        assertEq(held, usdc.totalSupply(), "USDC reached an untracked address");
        assertEq(handler.inflow(handler.keeper()), 0, "keeper received USDC");
        address[] memory maintainers = handler.allMaintainers();
        for (uint256 i; i < maintainers.length; ++i) {
            assertEq(handler.inflow(maintainers[i]), 0, "maintainer received USDC");
        }
        address[] memory relayers = handler.allRelayers();
        for (uint256 i; i < relayers.length; ++i) {
            assertEq(handler.inflow(relayers[i]), 0, "relayer received USDC");
        }
    }

    function invariant_2_forfeitNeverExceedsHalfOfADeposit() public view {
        assertFalse(handler.forfeitAboveHalf());
    }

    function invariant_3_balanceEqualsSumOfActiveDeposits() public view {
        bytes32[] memory keys = handler.allKeys();
        uint256 sum;
        for (uint256 i; i < keys.length; ++i) {
            BonaFideEscrow.Deposit memory d = escrow.depositOf(keys[i]);
            if (d.status == BonaFideEscrow.Status.Active) sum += d.amount;
        }
        assertEq(usdc.balanceOf(address(escrow)), sum);
    }

    function invariant_4_keeperCannotForfeitWithoutMaintainerSignature() public view {
        assertFalse(handler.keeperForfeited(), "keeper-made signature accepted");
        assertFalse(handler.replayAccepted(), "signature for an earlier serial accepted");
        bytes32[] memory keys = handler.allKeys();
        for (uint256 i; i < keys.length; ++i) {
            if (escrow.depositOf(keys[i]).status != BonaFideEscrow.Status.Forfeited) continue;
            (,,,,,, BonaFideEscrow.Status modelled) = handler.model(keys[i]);
            assertEq(uint8(modelled), uint8(BonaFideEscrow.Status.Forfeited), "forfeit without maintainer signature");
        }
    }

    function invariant_5_afterDeadlineOnlyRefundIsPossible() public view {
        assertFalse(handler.forfeitAfterDeadline(), "forfeit succeeded at or after deadline");
        assertFalse(handler.refundAfterDeadlineFailed(), "refund by anyone failed after deadline");
    }

    function invariant_6_repoChangesNeverAlterExistingDeposits() public view {
        bytes32[] memory keys = handler.allKeys();
        for (uint256 i; i < keys.length; ++i) {
            BonaFideEscrow.Deposit memory d = escrow.depositOf(keys[i]);
            (
                address depositor,
                address maintainer,
                uint16 forfeitBps,
                uint64 deadline,
                uint64 serial,
                uint256 amount,
                BonaFideEscrow.Status status
            ) = handler.model(keys[i]);
            assertEq(d.amount, amount, "amount changed");
            assertEq(d.forfeitBps, forfeitBps, "forfeitBps changed");
            assertEq(d.maintainer, maintainer, "maintainer changed");
            assertEq(d.deadline, deadline, "deadline changed");
            assertEq(d.depositor, depositor, "depositor changed");
            assertEq(d.serial, serial, "serial changed");
            assertEq(uint8(d.status), uint8(status), "status differs from model");
        }
    }

    function invariant_7_bindingsApplyOnlyAfterDelay() public view {
        assertFalse(handler.earlyActivation(), "config activated before its delay");
        bytes32[] memory repoIds = handler.allRepoIds();
        for (uint256 i; i < repoIds.length; ++i) {
            BonaFideEscrow.RepoConfig memory onchain = escrow.activeConfig(repoIds[i]);
            EscrowHandler.Config memory modelled = handler.activeConfigModel(repoIds[i]);
            assertEq(onchain.maintainer, modelled.maintainer);
            assertEq(onchain.forfeitBps, modelled.forfeitBps);
            assertEq(onchain.timeout, modelled.timeout);
            assertEq(onchain.amount, modelled.amount);
            (BonaFideEscrow.RepoConfig memory pending, uint64 effectiveAt) = escrow.pendingConfig(repoIds[i]);
            (EscrowHandler.Config memory pendingModel, uint64 effectiveAtModel) = handler.pendingConfigModel(repoIds[i]);
            assertEq(pending.maintainer, pendingModel.maintainer);
            assertEq(pending.amount, pendingModel.amount);
            assertEq(effectiveAt, effectiveAtModel);
        }
    }

    function invariant_8_eachDepositResolvesOnceAndOnlyByTheRules() public view {
        assertFalse(handler.resolvedTwice(), "resolved deposit paid again");
        assertFalse(handler.strangerRefundedEarly(), "non-keeper refunded before deadline");
        assertFalse(
            handler.invalidDepositAccepted(),
            "deposit into inactive repo or active key, or reused authorization, accepted"
        );
    }

    function afterInvariant() public view {
        EscrowHandler.Stats memory s = handler.statsSnapshot();
        console.log(
            "proposals/activations/earlyActivationAttempts", s.proposals, s.activations, s.earlyActivationAttempts
        );
        console.log("deposits/rejectedDeposits", s.deposits, s.rejectedDeposits);
        console.log(
            "keeperRefunds/refundsAfterDeadline/earlyRefundAttempts",
            s.keeperRefunds,
            s.refundsAfterDeadline,
            s.earlyRefundAttempts
        );
        console.log(
            "forfeits/lateForfeitAttempts/keeperForfeitAttempts",
            s.forfeits,
            s.lateForfeitAttempts,
            s.keeperForfeitAttempts
        );
        console.log("replayAttempts/warps", s.replayAttempts, s.warps);
        console.log("authorizedDeposits/authorizationReuseAttempts", s.authorizedDeposits, s.authorizationReuseAttempts);
    }
}
