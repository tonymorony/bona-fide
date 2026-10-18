// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BonaFideEscrow} from "../src/BonaFideEscrow.sol";
import {EscrowFixture} from "./utils/EscrowFixture.sol";

contract BonaFideEscrowFuzzTest is EscrowFixture {
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    BonaFideEscrow.Kind internal constant PR = BonaFideEscrow.Kind.PullRequest;

    function testFuzz_forfeit_sinkGetsFlooredShareAtMostHalfAndAmountIsConserved(uint256 amount, uint16 forfeitBps)
        public
    {
        amount = bound(amount, 1, MAX_AMOUNT);
        forfeitBps = uint16(bound(forfeitBps, 0, 5000));
        _activate(maintainer, forfeitBps, 14 days, amount);
        vm.prank(contributor);
        escrow.deposit(REPO, PR, 7);
        bytes32 key = escrow.keyOf(REPO, PR, 7);
        address relayer = makeAddr("relayer");

        vm.prank(relayer);
        escrow.forfeit(key, block.timestamp, _signForfeit(maintainerPk, key, 1, block.timestamp));

        uint256 forfeited = usdc.balanceOf(FORFEIT_SINK);
        uint256 refunded = usdc.balanceOf(contributor) - (100e6 - amount);
        assertEq(forfeited + refunded, amount);
        assertLe(forfeited * 2, amount);
        assertLe(forfeited * 10_000, amount * forfeitBps);
        assertGt((forfeited + 1) * 10_000, amount * forfeitBps);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(relayer) + usdc.balanceOf(maintainer) + usdc.balanceOf(keeper), 0);
    }

    function testFuzz_proposeRepo_acceptsExactlyTheBounds(uint16 forfeitBps, uint32 timeout, uint256 amount) public {
        forfeitBps = uint16(bound(forfeitBps, 0, 10_000));
        timeout = uint32(bound(timeout, 0, 90 days));
        amount = bound(amount, 0, 2 * MAX_AMOUNT);
        bool valid = forfeitBps <= 5000 && timeout >= 1 days && timeout <= 60 days && amount > 0 && amount <= MAX_AMOUNT;

        if (!valid) vm.expectRevert();
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, forfeitBps, timeout, amount);

        if (valid) {
            (BonaFideEscrow.RepoConfig memory pending,) = escrow.pendingConfig(REPO);
            assertEq(pending.forfeitBps, forfeitBps);
            assertEq(pending.timeout, timeout);
            assertEq(pending.amount, amount);
        }
    }

    function testFuzz_deposit_deadlineIsDepositTimePlusTimeout(uint32 timeout, uint256 startAt) public {
        timeout = uint32(bound(timeout, 1 days, 60 days));
        startAt = bound(startAt, START, 10_000_000_000);
        vm.warp(startAt);
        _activate(maintainer, 5000, timeout, 2e6);

        vm.prank(contributor);
        escrow.deposit(REPO, PR, 7);

        assertEq(escrow.depositOf(escrow.keyOf(REPO, PR, 7)).deadline, startAt + BINDING_DELAY + timeout);
    }

    function testFuzz_depositWithAuthorization_onlyStrictlyInsideTheWindow(uint256 afterOffset, uint256 beforeOffset)
        public
    {
        _activate(maintainer, 5000, 14 days, 2e6);
        uint256 validAfter = block.timestamp - 2 + bound(afterOffset, 0, 4);
        uint256 validBefore = block.timestamp - 2 + bound(beforeOffset, 0, 4);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 key = escrow.keyOf(REPO, PR, 7);
        bytes memory sig = _signReceive(agentPk, agent, 2e6, validAfter, validBefore, _nonce(key, SALT));

        if (block.timestamp <= validAfter) vm.expectRevert("FiatTokenV2: authorization is not yet valid");
        else if (block.timestamp >= validBefore) vm.expectRevert("FiatTokenV2: authorization is expired");
        escrow.depositWithAuthorization(REPO, PR, 7, agent, validAfter, validBefore, SALT, sig);

        if (validAfter < block.timestamp && block.timestamp < validBefore) {
            assertEq(escrow.depositOf(key).depositor, agent);
        }
    }

    function testFuzz_refund_byAnyoneExactlyFromDeadline(uint32 timeout, uint256 elapsed) public {
        timeout = uint32(bound(timeout, 1 days, 60 days));
        elapsed = bound(elapsed, 0, 120 days);
        _activate(maintainer, 5000, timeout, 2e6);
        vm.prank(contributor);
        escrow.deposit(REPO, PR, 7);
        bytes32 key = escrow.keyOf(REPO, PR, 7);
        address stranger = makeAddr("stranger");
        vm.warp(block.timestamp + elapsed);

        if (elapsed < timeout) vm.expectRevert(BonaFideEscrow.DeadlineNotReached.selector);
        vm.prank(stranger);
        escrow.refund(key);

        if (elapsed >= timeout) {
            assertEq(usdc.balanceOf(contributor), 100e6);
            assertEq(usdc.balanceOf(stranger), 0);
        }
    }

    function testFuzz_forfeit_onlyBeforeDeadlineAndUntilSigDeadline(uint32 timeout, uint256 elapsed, uint256 sigWindow)
        public
    {
        timeout = uint32(bound(timeout, 1 days, 60 days));
        elapsed = bound(elapsed, 0, 90 days);
        sigWindow = bound(sigWindow, 0, 90 days);
        _activate(maintainer, 5000, timeout, 2e6);
        vm.prank(contributor);
        escrow.deposit(REPO, PR, 7);
        bytes32 key = escrow.keyOf(REPO, PR, 7);
        uint256 sigDeadline = vm.getBlockTimestamp() + sigWindow;
        bytes memory sig = _signForfeit(maintainerPk, key, 1, sigDeadline);
        vm.warp(block.timestamp + elapsed);

        if (elapsed >= timeout) vm.expectRevert(BonaFideEscrow.DeadlinePassed.selector);
        else if (elapsed > sigWindow) vm.expectRevert(BonaFideEscrow.SignatureExpired.selector);
        escrow.forfeit(key, sigDeadline, sig);

        if (elapsed < timeout && elapsed <= sigWindow) {
            assertEq(uint8(escrow.depositOf(key).status), uint8(BonaFideEscrow.Status.Forfeited));
        }
    }

    function testFuzz_forfeit_rejectsEverySignerButTheMaintainer(uint256 signerPk) public {
        signerPk = bound(signerPk, 1, SECP256K1_N - 1);
        vm.assume(signerPk != maintainerPk);
        bytes32 key = _depositPR7();
        bytes memory sig = _signForfeit(signerPk, key, 1, block.timestamp);

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        vm.prank(keeper);
        escrow.forfeit(key, block.timestamp, sig);
    }

    function testFuzz_repoChange_neverAltersExistingDeposit(
        address newMaintainer,
        uint16 forfeitBps,
        uint32 timeout,
        uint256 amount
    ) public {
        vm.assume(newMaintainer != address(0));
        forfeitBps = uint16(bound(forfeitBps, 0, 5000));
        timeout = uint32(bound(timeout, 1 days, 60 days));
        amount = bound(amount, 1, MAX_AMOUNT);
        bytes32 key = _depositPR7();

        _activate(newMaintainer, forfeitBps, timeout, amount);

        BonaFideEscrow.Deposit memory d = escrow.depositOf(key);
        assertEq(d.depositor, contributor);
        assertEq(d.amount, 2e6);
        assertEq(d.forfeitBps, 5000);
        assertEq(d.maintainer, maintainer);
        assertEq(d.deadline, PR7_DEADLINE);
        assertEq(d.serial, 1);
    }
}
