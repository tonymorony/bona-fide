// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {BountyWallet} from "../../src/BountyWallet.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {BountyHandler} from "./BountyHandler.sol";

contract BountyWalletInvariantTest is Test {
    BountyHandler internal handler;
    MockUSDC internal usdc;

    function setUp() public {
        vm.warp(1_000_000);
        handler = new BountyHandler();
        usdc = handler.usdc();

        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = BountyHandler.fund.selector;
        selectors[1] = BountyHandler.donate.selector;
        selectors[2] = BountyHandler.post.selector;
        selectors[3] = BountyHandler.cancel.selector;
        selectors[4] = BountyHandler.keeperPay.selector;
        selectors[5] = BountyHandler.payWithSignature.selector;
        selectors[6] = BountyHandler.replaySignature.selector;
        selectors[7] = BountyHandler.forgedSignature.selector;
        selectors[8] = BountyHandler.ownerPay.selector;
        selectors[9] = BountyHandler.withdraw.selector;
        selectors[10] = BountyHandler.setLimits.selector;
        selectors[11] = BountyHandler.setKeeperEnabled.selector;
        selectors[12] = BountyHandler.strangerActs.selector;
        selectors[13] = BountyHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_1_usdcLeavesOnlyToAPostedBountysPayeeOrTheOwnersWithdrawTarget() public view {
        uint256 held;
        for (uint256 w; w < handler.walletCount(); ++w) {
            uint256 balance = usdc.balanceOf(address(handler.walletAt(w)));
            assertEq(balance, handler.balanceModel(w), "wallet balance differs from model");
            held += balance;
        }
        address[] memory tracked = handler.trackedAddresses();
        for (uint256 i; i < tracked.length; ++i) {
            assertEq(handler.inflow(tracked[i]), handler.expectedInflow(tracked[i]), "inflow differs from model");
            held += usdc.balanceOf(tracked[i]);
        }
        assertEq(held, usdc.totalSupply(), "USDC reached an untracked address");
        assertEq(handler.inflow(handler.keeper()), 0, "keeper received USDC");
        address[] memory relayers = handler.allRelayers();
        for (uint256 i; i < relayers.length; ++i) {
            assertEq(handler.inflow(relayers[i]), 0, "relayer received USDC");
        }
    }

    function invariant_2_keeperPayoutsStayWithinThePerPayoutAndPeriodLimits() public view {
        assertFalse(handler.keeperAboveLimit(), "keeper paid above a limit");
        for (uint256 w; w < handler.walletCount(); ++w) {
            BountyWallet wallet = handler.walletAt(w);
            BountyHandler.Limits memory l = handler.limits(w);
            assertEq(wallet.spentInPeriod(), l.spent, "spent differs from model");
            assertEq(wallet.periodStart(), l.periodStart, "period start differs from model");
            assertEq(wallet.perPayoutLimit(), l.perPayout);
            assertEq(wallet.periodLimit(), l.periodLimit);
            assertEq(wallet.periodLength(), l.periodLength);
        }
    }

    function invariant_3_eachBountyIsPaidAtMostOnce() public view {
        assertFalse(handler.paidTwice(), "a bounty was paid twice");
        for (uint256 w; w < handler.walletCount(); ++w) {
            BountyWallet wallet = handler.walletAt(w);
            for (uint64 i; i < handler.ISSUES(); ++i) {
                BountyWallet.Bounty memory b = wallet.bountyOf(i);
                BountyHandler.Model memory m = handler.bountyModel(w, i);
                assertEq(uint8(b.status), uint8(m.status), "status differs from model");
                assertEq(b.amount, m.amount, "amount changed");
                assertEq(b.serial, m.serial, "serial changed");
                assertEq(b.payee, m.payee, "payee differs from model");
            }
        }
    }

    function invariant_4_reservedIsTheSumOfOpenBountiesAndNeverAboveTheBalance() public view {
        for (uint256 w; w < handler.walletCount(); ++w) {
            BountyWallet wallet = handler.walletAt(w);
            assertEq(wallet.reserved(), handler.reservedModel(w), "reserved differs from open bounties");
            assertLe(wallet.reserved(), usdc.balanceOf(address(wallet)), "reserved above balance");
        }
    }

    function invariant_5_signaturesCannotBeReplayedOrForged() public view {
        assertFalse(handler.replayAccepted(), "signature replayed on another wallet, issue, payee or serial");
        assertFalse(handler.forgedAccepted(), "signature by someone other than the owner accepted");
    }

    function invariant_6_aDisabledKeeperCannotPay() public view {
        assertFalse(handler.disabledKeeperPaid(), "disabled keeper paid");
        for (uint256 w; w < handler.walletCount(); ++w) {
            assertEq(handler.walletAt(w).keeperEnabled(), handler.limits(w).keeperEnabled);
        }
    }

    function invariant_7_onlyTheOwnerControlsTheWallet() public view {
        assertFalse(handler.strangerSucceeded(), "someone other than the owner used an owner control");
        assertFalse(handler.invalidActionAccepted(), "an invalid post, cancel, payout or withdrawal was accepted");
    }

    function afterInvariant() public view {
        BountyHandler.Stats memory s = handler.statsSnapshot();
        console.log("funds/posts/cancels", s.funds, s.posts, s.cancels);
        console.log("keeperPays/whileDisabled", s.keeperPays, s.keeperPaysWhileDisabled);
        console.log(
            "keeperPays notOpen/aboveLimit/invalidPayee",
            s.keeperPaysNotOpen,
            s.keeperPaysAboveLimit,
            s.keeperPaysToInvalidPayee
        );
        console.log("signaturePays/ownerPays/withdrawals", s.signaturePays, s.ownerPays, s.withdrawals);
        console.log("limitChanges/switches/warps", s.limitChanges, s.switches, s.warps);
        console.log(
            "replayAttempts/forgedAttempts/strangerAttempts", s.replayAttempts, s.forgedAttempts, s.strangerAttempts
        );
    }
}
