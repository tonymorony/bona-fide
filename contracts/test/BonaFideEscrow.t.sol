// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {BonaFideEscrow} from "../src/BonaFideEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockERC1271Wallet} from "./mocks/MockERC1271Wallet.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {EscrowFixture} from "./utils/EscrowFixture.sol";

contract BonaFideEscrowTest is EscrowFixture {
    function test_constructor_storesParameters() public view {
        assertEq(address(escrow.usdc()), address(usdc));
        assertEq(escrow.keeper(), keeper);
        assertEq(escrow.forfeitSink(), FORFEIT_SINK);
        assertEq(escrow.bindingDelay(), BINDING_DELAY);
        assertEq(escrow.maxAmount(), MAX_AMOUNT);
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(BonaFideEscrow.ZeroAddress.selector);
        new BonaFideEscrow(MockUSDC(address(0)), keeper, FORFEIT_SINK, BINDING_DELAY, MAX_AMOUNT);
    }

    function test_constructor_revertsOnZeroKeeper() public {
        vm.expectRevert(BonaFideEscrow.ZeroAddress.selector);
        new BonaFideEscrow(usdc, address(0), FORFEIT_SINK, BINDING_DELAY, MAX_AMOUNT);
    }

    function test_constructor_revertsOnZeroForfeitSink() public {
        vm.expectRevert(BonaFideEscrow.ZeroAddress.selector);
        new BonaFideEscrow(usdc, keeper, address(0), BINDING_DELAY, MAX_AMOUNT);
    }

    function test_constructor_revertsWhenForfeitSinkIsKeeper() public {
        vm.expectRevert(BonaFideEscrow.ForfeitSinkIsKeeper.selector);
        new BonaFideEscrow(usdc, keeper, keeper, BINDING_DELAY, MAX_AMOUNT);
    }

    function test_constructor_revertsWhenForfeitSinkIsTheEscrowItself() public {
        address escrowAddress = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));

        vm.expectRevert(BonaFideEscrow.ForfeitSinkIsEscrow.selector);
        new BonaFideEscrow(usdc, keeper, escrowAddress, BINDING_DELAY, MAX_AMOUNT);
    }

    function test_constructor_revertsWhenBindingDelayUnderOneHour() public {
        vm.expectRevert(BonaFideEscrow.BindingDelayTooShort.selector);
        new BonaFideEscrow(usdc, keeper, FORFEIT_SINK, 1 hours - 1, MAX_AMOUNT);
    }

    function test_constructor_acceptsOneHourBindingDelay() public {
        BonaFideEscrow e = new BonaFideEscrow(usdc, keeper, FORFEIT_SINK, 1 hours, MAX_AMOUNT);

        assertEq(e.bindingDelay(), 1 hours);
    }

    function test_constructor_revertsOnZeroMaxAmount() public {
        vm.expectRevert(BonaFideEscrow.InvalidAmount.selector);
        new BonaFideEscrow(usdc, keeper, FORFEIT_SINK, BINDING_DELAY, 0);
    }

    function test_keyOf_matchesOffChainEncoding() public view {
        bytes32 repoId = keccak256(bytes("github:tonymorony/lottie-squeeze"));
        assertEq(repoId, 0xea15c2a89b4cb2ee300a00a8825e2ad26f65d25b7eb3b325b5be4faa9f182694);
        assertEq(
            escrow.keyOf(repoId, BonaFideEscrow.Kind.PullRequest, 7),
            0xfff00ffc18bd0123618fbaf0fe918ad07cdcb7d5da95ac36c74c6d0a9dbeba36
        );
        assertEq(
            escrow.keyOf(repoId, BonaFideEscrow.Kind.Issue, 7),
            0x17f7c54ab2a0c11116a8909313ee4c4c0540892ff2468d620280f88c5c81e0fa
        );
    }

    function test_authorizationNonce_matchesOffChainEncoding() public view {
        bytes32 pr7 = 0xfff00ffc18bd0123618fbaf0fe918ad07cdcb7d5da95ac36c74c6d0a9dbeba36;

        assertEq(
            escrow.authorizationNonce(pr7, bytes32(uint256(1))),
            0x8629b1e81490328a0a93ed329b3bbaf6cc32cf8b0b46c5883c0cadd527484974
        );
    }

    function test_proposeRepo_storesPendingConfigThatIsNotYetActive() public {
        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.RepoProposed(REPO, maintainer, 5000, 14 days, 2e6, START + 1 days);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);

        (BonaFideEscrow.RepoConfig memory pending, uint64 effectiveAt) = escrow.pendingConfig(REPO);
        assertEq(pending.maintainer, maintainer);
        assertEq(pending.forfeitBps, 5000);
        assertEq(pending.timeout, 14 days);
        assertEq(pending.amount, 2e6);
        assertEq(effectiveAt, START + 1 days);
        assertEq(escrow.activeConfig(REPO).maintainer, address(0));
    }

    function test_proposeRepo_revertsForNonKeeper() public {
        vm.expectRevert(BonaFideEscrow.NotKeeper.selector);
        vm.prank(maintainer);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
    }

    function test_proposeRepo_revertsOnZeroMaintainer() public {
        vm.expectRevert(BonaFideEscrow.ZeroAddress.selector);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, address(0), 5000, 14 days, 2e6);
    }

    function test_proposeRepo_revertsWhenForfeitAboveHalf() public {
        vm.expectRevert(BonaFideEscrow.InvalidForfeitBps.selector);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5001, 14 days, 2e6);
    }

    function test_proposeRepo_revertsWhenTimeoutBelowOneDay() public {
        vm.expectRevert(BonaFideEscrow.InvalidTimeout.selector);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 1 days - 1, 2e6);
    }

    function test_proposeRepo_revertsWhenTimeoutAboveSixtyDays() public {
        vm.expectRevert(BonaFideEscrow.InvalidTimeout.selector);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 60 days + 1, 2e6);
    }

    function test_proposeRepo_revertsOnZeroAmount() public {
        vm.expectRevert(BonaFideEscrow.InvalidAmount.selector);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 0);
    }

    function test_proposeRepo_revertsWhenAmountAboveMax() public {
        vm.expectRevert(BonaFideEscrow.InvalidAmount.selector);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, MAX_AMOUNT + 1);
    }

    function test_proposeRepo_acceptsInclusiveBounds() public {
        vm.startPrank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 1 days, MAX_AMOUNT);
        escrow.proposeRepo(bytes32(uint256(1)), maintainer, 0, 60 days, 1);
        vm.stopPrank();

        (BonaFideEscrow.RepoConfig memory high,) = escrow.pendingConfig(REPO);
        (BonaFideEscrow.RepoConfig memory low,) = escrow.pendingConfig(bytes32(uint256(1)));
        assertEq(high.forfeitBps, 5000);
        assertEq(high.timeout, 1 days);
        assertEq(high.amount, MAX_AMOUNT);
        assertEq(low.forfeitBps, 0);
        assertEq(low.timeout, 60 days);
        assertEq(low.amount, 1);
    }

    function test_activateRepo_byAnyoneOnceBindingDelayElapsed() public {
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
        vm.warp(START + 1 days);

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.RepoActivated(REPO, maintainer, 5000, 14 days, 2e6);
        vm.prank(makeAddr("anyone"));
        escrow.activateRepo(REPO);

        BonaFideEscrow.RepoConfig memory active = escrow.activeConfig(REPO);
        assertEq(active.maintainer, maintainer);
        assertEq(active.forfeitBps, 5000);
        assertEq(active.timeout, 14 days);
        assertEq(active.amount, 2e6);
        (BonaFideEscrow.RepoConfig memory pending, uint64 effectiveAt) = escrow.pendingConfig(REPO);
        assertEq(pending.maintainer, address(0));
        assertEq(effectiveAt, 0);
    }

    function test_activateRepo_revertsBeforeBindingDelayElapsed() public {
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
        vm.warp(START + 1 days - 1);

        vm.expectRevert(BonaFideEscrow.NotYetEffective.selector);
        escrow.activateRepo(REPO);
    }

    function test_activateRepo_revertsWithoutPendingConfig() public {
        vm.expectRevert(BonaFideEscrow.NoPendingConfig.selector);
        escrow.activateRepo(REPO);
    }

    function test_activateRepo_revertsWhenAlreadyActivated() public {
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
        vm.warp(START + 1 days);
        escrow.activateRepo(REPO);

        vm.expectRevert(BonaFideEscrow.NoPendingConfig.selector);
        escrow.activateRepo(REPO);
    }

    function test_proposeRepo_replacesPendingAndRestartsDelay() public {
        address newMaintainer = makeAddr("newMaintainer");
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
        vm.warp(START + 12 hours);
        vm.prank(keeper);
        escrow.proposeRepo(REPO, newMaintainer, 1000, 7 days, 1e6);

        vm.warp(START + 1 days);
        vm.expectRevert(BonaFideEscrow.NotYetEffective.selector);
        escrow.activateRepo(REPO);

        vm.warp(START + 12 hours + 1 days);
        escrow.activateRepo(REPO);
        BonaFideEscrow.RepoConfig memory active = escrow.activeConfig(REPO);
        assertEq(active.maintainer, newMaintainer);
        assertEq(active.forfeitBps, 1000);
        assertEq(active.timeout, 7 days);
        assertEq(active.amount, 1e6);
    }

    function test_deposit_pullsAmountAndSnapshotsRepoConfig() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint64 expectedDeadline = START + 1 days + 14 days;

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Deposited(
            key, 1, REPO, BonaFideEscrow.Kind.PullRequest, 7, contributor, 2e6, expectedDeadline
        );
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);

        assertEq(usdc.balanceOf(contributor), 98e6);
        assertEq(usdc.balanceOf(address(escrow)), 2e6);
        BonaFideEscrow.Deposit memory d = escrow.depositOf(key);
        assertEq(d.depositor, contributor);
        assertEq(d.amount, 2e6);
        assertEq(d.forfeitBps, 5000);
        assertEq(d.maintainer, maintainer);
        assertEq(d.deadline, expectedDeadline);
        assertEq(d.serial, 1);
        assertEq(uint8(d.status), uint8(BonaFideEscrow.Status.Active));
    }

    function test_deposit_revertsWhenRepoUnknown() public {
        vm.expectRevert(BonaFideEscrow.RepoNotActive.selector);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
    }

    function test_deposit_revertsWhenRepoOnlyProposed() public {
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);

        vm.expectRevert(BonaFideEscrow.RepoNotActive.selector);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
    }

    function test_deposit_revertsWhileKeyHasActiveDeposit() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        address other = _funded("other");

        vm.expectRevert(BonaFideEscrow.DepositAlreadyActive.selector);
        vm.prank(other);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
    }

    function test_deposit_serialIncrementsGloballyAcrossKeys() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        vm.startPrank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        escrow.deposit(REPO, BonaFideEscrow.Kind.Issue, 7);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 8);
        vm.stopPrank();

        assertEq(escrow.depositOf(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7)).serial, 1);
        assertEq(escrow.depositOf(escrow.keyOf(REPO, BonaFideEscrow.Kind.Issue, 7)).serial, 2);
        assertEq(escrow.depositOf(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 8)).serial, 3);
        assertEq(usdc.balanceOf(address(escrow)), 6e6);
    }

    function test_deposit_revertsWithoutAllowance() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        address stranger = makeAddr("stranger");
        usdc.mint(stranger, 2e6);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(escrow), 0, 2e6)
        );
        vm.prank(stranger);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
    }

    function test_depositWithAuthorization_takesOneSignatureAndNoApproval() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(agentPk, agent, 2e6, 0, validBefore, _nonce(key, SALT));

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Deposited(key, 1, REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 2e6, PR7_DEADLINE);
        vm.prank(keeper);
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);

        assertEq(usdc.allowance(agent, address(escrow)), 0);
        assertEq(usdc.balanceOf(agent), 98e6);
        assertEq(usdc.balanceOf(address(escrow)), 2e6);
        assertTrue(usdc.authorizationState(agent, _nonce(key, SALT)));
        BonaFideEscrow.Deposit memory d = escrow.depositOf(key);
        assertEq(d.depositor, agent);
        assertEq(d.amount, 2e6);
        assertEq(d.forfeitBps, 5000);
        assertEq(d.maintainer, maintainer);
        assertEq(d.deadline, PR7_DEADLINE);
        assertEq(d.serial, 1);
        assertEq(uint8(d.status), uint8(BonaFideEscrow.Status.Active));
    }

    function test_depositWithAuthorization_byAnyRelayerRecordsTheSignerAsDepositor() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(agentPk, agent, 2e6, 0, validBefore, _nonce(key, SALT));
        address relayer = _funded("relayer");

        vm.prank(relayer);
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);

        assertEq(escrow.depositOf(key).depositor, agent);
        assertEq(usdc.balanceOf(agent), 98e6);
        assertEq(usdc.balanceOf(relayer), 100e6);
    }

    function test_depositWithAuthorization_refundPaysTheSignerNotTheRelayer() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(agentPk, agent, 2e6, 0, validBefore, _nonce(key, SALT));
        address relayer = makeAddr("relayer");
        vm.prank(relayer);
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);
        vm.warp(PR7_DEADLINE);

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Refunded(key, 1, agent, 2e6, false);
        vm.prank(relayer);
        escrow.refund(key);

        assertEq(usdc.balanceOf(agent), 100e6);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_depositWithAuthorization_fromErc1271Wallet() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address owner, uint256 ownerPk) = makeAddrAndKey("agentWalletOwner");
        MockERC1271Wallet wallet = new MockERC1271Wallet(owner);
        usdc.mint(address(wallet), 100e6);
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(ownerPk, address(wallet), 2e6, 0, validBefore, _nonce(key, SALT));

        vm.prank(keeper);
        escrow.depositWithAuthorization(
            REPO, BonaFideEscrow.Kind.PullRequest, 7, address(wallet), 0, validBefore, SALT, sig
        );

        assertEq(escrow.depositOf(key).depositor, address(wallet));
        assertEq(usdc.balanceOf(address(wallet)), 98e6);
        assertEq(usdc.balanceOf(address(escrow)), 2e6);
    }

    function test_depositWithAuthorization_revertsWhenWalletRejectsTheSignature() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        MockERC1271Wallet wallet = new MockERC1271Wallet(makeAddr("agentWalletOwner"));
        usdc.mint(address(wallet), 100e6);
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(
            strangerPk,
            address(wallet),
            2e6,
            0,
            validBefore,
            _nonce(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7), SALT)
        );

        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.depositWithAuthorization(
            REPO, BonaFideEscrow.Kind.PullRequest, 7, address(wallet), 0, validBefore, SALT, sig
        );
    }

    function test_depositWithAuthorization_revertsWhenSignedValueIsNotTheRepoAmount() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 nonce = _nonce(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7), SALT);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory tooLow = _signReceive(agentPk, agent, 1e6, 0, validBefore, nonce);
        bytes memory tooHigh = _signReceive(agentPk, agent, 3e6, 0, validBefore, nonce);

        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, tooLow);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, tooHigh);
    }

    function test_depositWithAuthorization_frontRunWithAnotherKeyReverts() public {
        bytes32 attackerRepo = keccak256("github:attacker/repo");
        vm.startPrank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
        escrow.proposeRepo(attackerRepo, makeAddr("attacker"), 5000, 14 days, 2e6);
        vm.stopPrank();
        vm.warp(block.timestamp + BINDING_DELAY);
        escrow.activateRepo(REPO);
        escrow.activateRepo(attackerRepo);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 pr7 = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(agentPk, agent, 2e6, 0, validBefore, _nonce(pr7, SALT));

        vm.startPrank(makeAddr("frontRunner"));
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 8, agent, 0, validBefore, SALT, sig);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.Issue, 7, agent, 0, validBefore, SALT, sig);
        vm.expectRevert("FiatTokenV2: invalid signature");
        escrow.depositWithAuthorization(
            attackerRepo, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig
        );
        vm.stopPrank();

        vm.prank(keeper);
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);
        assertEq(escrow.depositOf(pr7).depositor, agent);
        assertEq(usdc.balanceOf(agent), 98e6);
    }

    function test_depositWithAuthorization_revertsFromValidBefore() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(
            agentPk, agent, 2e6, 0, validBefore, _nonce(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7), SALT)
        );
        vm.warp(validBefore);

        vm.expectRevert("FiatTokenV2: authorization is expired");
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);
    }

    function test_depositWithAuthorization_revertsUntilAfterValidAfter() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        uint256 validAfter = block.timestamp + 1 hours;
        uint256 validBefore = validAfter + 1 hours;
        bytes memory sig = _signReceive(
            agentPk,
            agent,
            2e6,
            validAfter,
            validBefore,
            _nonce(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7), SALT)
        );
        vm.warp(validAfter);

        vm.expectRevert("FiatTokenV2: authorization is not yet valid");
        escrow.depositWithAuthorization(
            REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, validAfter, validBefore, SALT, sig
        );
    }

    function test_depositWithAuthorization_revertsWhenAuthorizationIsReplayed() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(agentPk, agent, 2e6, 0, validBefore, _nonce(key, SALT));
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);
        vm.prank(keeper);
        escrow.refund(key);

        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);
    }

    function test_depositWithAuthorization_revertsWhenRepoNotActive() public {
        vm.prank(keeper);
        escrow.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(
            agentPk, agent, 2e6, 0, validBefore, _nonce(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7), SALT)
        );

        vm.expectRevert(BonaFideEscrow.RepoNotActive.selector);
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);
    }

    function test_depositWithAuthorization_revertsWhileKeyHasActiveDeposit() public {
        bytes32 key = _depositPR7();
        (address agent, uint256 agentPk) = _signer("agent");
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(agentPk, agent, 2e6, 0, validBefore, _nonce(key, SALT));

        vm.expectRevert(BonaFideEscrow.DepositAlreadyActive.selector);
        escrow.depositWithAuthorization(REPO, BonaFideEscrow.Kind.PullRequest, 7, agent, 0, validBefore, SALT, sig);

        assertEq(escrow.depositOf(key).depositor, contributor);
        assertFalse(usdc.authorizationState(agent, _nonce(key, SALT)));
    }

    function test_depositWithAuthorization_relayerCannotRedirectTheAuthorization() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        (address agent, uint256 agentPk) = _signer("agent");
        bytes32 nonce = _nonce(escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7), SALT);
        uint256 validBefore = block.timestamp + 1 hours;
        bytes memory sig = _signReceive(agentPk, agent, 2e6, 0, validBefore, nonce);
        address relayer = makeAddr("relayer");

        vm.startPrank(relayer);
        vm.expectRevert("FiatTokenV2: caller must be the payee");
        usdc.receiveWithAuthorization(agent, address(escrow), 2e6, 0, validBefore, nonce, sig);
        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.receiveWithAuthorization(agent, relayer, 2e6, 0, validBefore, nonce, sig);
        vm.stopPrank();

        assertEq(usdc.balanceOf(agent), 100e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(relayer), 0);
    }

    function test_refund_byKeeperBeforeDeadlinePaysDepositorInFull() public {
        bytes32 key = _depositPR7();

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Refunded(key, 1, contributor, 2e6, true);
        vm.prank(keeper);
        escrow.refund(key);

        assertEq(usdc.balanceOf(contributor), 100e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(uint8(escrow.depositOf(key).status), uint8(BonaFideEscrow.Status.Refunded));
    }

    function test_refund_byAnyoneRevertsBeforeDeadline() public {
        bytes32 key = _depositPR7();
        vm.warp(PR7_DEADLINE - 1);

        vm.expectRevert(BonaFideEscrow.DeadlineNotReached.selector);
        vm.prank(makeAddr("stranger"));
        escrow.refund(key);
    }

    function test_refund_byAnyoneAtDeadlinePaysDepositor() public {
        bytes32 key = _depositPR7();
        address stranger = makeAddr("stranger");
        vm.warp(PR7_DEADLINE);

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Refunded(key, 1, contributor, 2e6, false);
        vm.prank(stranger);
        escrow.refund(key);

        assertEq(usdc.balanceOf(contributor), 100e6);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_refund_byKeeperAfterDeadlineIsMarkedByKeeper() public {
        bytes32 key = _depositPR7();
        vm.warp(PR7_DEADLINE + 30 days);

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Refunded(key, 1, contributor, 2e6, true);
        vm.prank(keeper);
        escrow.refund(key);
    }

    function test_refund_revertsForUnknownKey() public {
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);

        vm.expectRevert(BonaFideEscrow.DepositNotActive.selector);
        vm.prank(keeper);
        escrow.refund(key);
    }

    function test_refund_revertsWhenAlreadyRefunded() public {
        bytes32 key = _depositPR7();
        vm.prank(keeper);
        escrow.refund(key);

        vm.expectRevert(BonaFideEscrow.DepositNotActive.selector);
        vm.prank(keeper);
        escrow.refund(key);
    }

    function test_deposit_allowedAgainAfterResolutionWithNewSerial() public {
        bytes32 key = _depositPR7();
        vm.prank(keeper);
        escrow.refund(key);
        address second = _funded("second");

        vm.prank(second);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);

        BonaFideEscrow.Deposit memory d = escrow.depositOf(key);
        assertEq(d.serial, 2);
        assertEq(d.depositor, second);
        assertEq(uint8(d.status), uint8(BonaFideEscrow.Status.Active));
        assertEq(usdc.balanceOf(address(escrow)), 2e6);
    }

    function test_forfeit_relayedMaintainerSignatureSendsShareToSinkAndRefundsRest() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _signForfeit(maintainerPk, key, 1, sigDeadline);
        address relayer = makeAddr("relayer");

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Forfeited(key, 1, 1e6, 1e6);
        vm.prank(relayer);
        escrow.forfeit(key, sigDeadline, sig);

        assertEq(usdc.balanceOf(FORFEIT_SINK), 1e6);
        assertEq(usdc.balanceOf(contributor), 99e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(relayer), 0);
        assertEq(usdc.balanceOf(maintainer), 0);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(uint8(escrow.depositOf(key).status), uint8(BonaFideEscrow.Status.Forfeited));
    }

    function test_forfeit_revertsWhenSignedByKeeper() public {
        bytes32 key = _depositPR7();
        (, uint256 keeperPk) = makeAddrAndKey("keeper");
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _signForfeit(keeperPk, key, 1, sigDeadline);

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        vm.prank(keeper);
        escrow.forfeit(key, sigDeadline, sig);
    }

    function test_forfeit_revertsWhenSignatureIsForAnotherKey() public {
        bytes32 key = _depositPR7();
        bytes32 otherKey = escrow.keyOf(REPO, BonaFideEscrow.Kind.Issue, 7);
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _signForfeit(maintainerPk, otherKey, 1, sigDeadline);

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline, sig);
    }

    function test_forfeit_revertsWhenSigDeadlineDiffersFromSigned() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _signForfeit(maintainerPk, key, 1, sigDeadline);

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline + 1 days, sig);
    }

    function test_forfeit_revertsWhenSignatureIsForAnotherEscrow() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        BonaFideEscrow otherEscrow = new BonaFideEscrow(usdc, keeper, FORFEIT_SINK, BINDING_DELAY, MAX_AMOUNT);
        bytes memory sig = _signForfeitAt(otherEscrow, maintainerPk, key, 1, sigDeadline);

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline, sig);
    }

    function test_eip712Domain_isBonaFideVersion1() public view {
        (, string memory name, string memory version, uint256 chainId, address verifyingContract,,) =
            escrow.eip712Domain();
        assertEq(name, "BonaFide");
        assertEq(version, "1");
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(escrow));
    }

    function test_forfeit_roundsForfeitedShareDownInDepositorsFavour() public {
        _activate(maintainer, 5000, 14 days, 3);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);

        vm.expectEmit(address(escrow));
        emit BonaFideEscrow.Forfeited(key, 1, 1, 2);
        escrow.forfeit(key, block.timestamp, _signForfeit(maintainerPk, key, 1, block.timestamp));

        assertEq(usdc.balanceOf(FORFEIT_SINK), 1);
        assertEq(usdc.balanceOf(contributor), 100e6 - 1);
    }

    function test_forfeit_withZeroForfeitBpsRefundsEverything() public {
        _activate(maintainer, 0, 14 days, 2e6);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);

        escrow.forfeit(key, block.timestamp, _signForfeit(maintainerPk, key, 1, block.timestamp));

        assertEq(usdc.balanceOf(FORFEIT_SINK), 0);
        assertEq(usdc.balanceOf(contributor), 100e6);
        assertEq(uint8(escrow.depositOf(key).status), uint8(BonaFideEscrow.Status.Forfeited));
    }

    function test_forfeit_revertsOnMalformedSignature() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline, "");
        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline, new bytes(65));
    }

    function test_forfeit_signatureForEarlierSerialDoesNotWorkOnRedeposit() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory firstSig = _signForfeit(maintainerPk, key, 1, sigDeadline);
        vm.prank(keeper);
        escrow.refund(key);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline, firstSig);
    }

    function test_forfeit_keeperMayRelayMaintainerSignature() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _signForfeit(maintainerPk, key, 1, sigDeadline);

        vm.prank(keeper);
        escrow.forfeit(key, sigDeadline, sig);

        assertEq(usdc.balanceOf(FORFEIT_SINK), 1e6);
        assertEq(usdc.balanceOf(keeper), 0);
    }

    function test_forfeit_worksUntilOneSecondBeforeDeadline() public {
        bytes32 key = _depositPR7();
        bytes memory sig = _signForfeit(maintainerPk, key, 1, PR7_DEADLINE);
        vm.warp(PR7_DEADLINE - 1);

        escrow.forfeit(key, PR7_DEADLINE, sig);

        assertEq(uint8(escrow.depositOf(key).status), uint8(BonaFideEscrow.Status.Forfeited));
    }

    function test_forfeit_revertsAtDeadline() public {
        bytes32 key = _depositPR7();
        bytes memory sig = _signForfeit(maintainerPk, key, 1, PR7_DEADLINE + 1 days);
        vm.warp(PR7_DEADLINE);

        vm.expectRevert(BonaFideEscrow.DeadlinePassed.selector);
        escrow.forfeit(key, PR7_DEADLINE + 1 days, sig);
    }

    function test_forfeit_worksAtSigDeadline() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _signForfeit(maintainerPk, key, 1, sigDeadline);
        vm.warp(sigDeadline);

        escrow.forfeit(key, sigDeadline, sig);

        assertEq(uint8(escrow.depositOf(key).status), uint8(BonaFideEscrow.Status.Forfeited));
    }

    function test_forfeit_revertsAfterSigDeadline() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory sig = _signForfeit(maintainerPk, key, 1, sigDeadline);
        vm.warp(sigDeadline + 1);

        vm.expectRevert(BonaFideEscrow.SignatureExpired.selector);
        escrow.forfeit(key, sigDeadline, sig);
    }

    function test_forfeit_revertsForUnknownKey() public {
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        bytes memory sig = _signForfeit(maintainerPk, key, 0, block.timestamp);

        vm.expectRevert(BonaFideEscrow.DepositNotActive.selector);
        escrow.forfeit(key, block.timestamp, sig);
    }

    function test_forfeit_revertsAfterRefund() public {
        bytes32 key = _depositPR7();
        bytes memory sig = _signForfeit(maintainerPk, key, 1, block.timestamp);
        vm.prank(keeper);
        escrow.refund(key);

        vm.expectRevert(BonaFideEscrow.DepositNotActive.selector);
        escrow.forfeit(key, block.timestamp, sig);
    }

    function test_forfeit_resolvesOnlyOnce() public {
        bytes32 key = _depositPR7();
        bytes memory sig = _signForfeit(maintainerPk, key, 1, block.timestamp);
        escrow.forfeit(key, block.timestamp, sig);

        vm.expectRevert(BonaFideEscrow.DepositNotActive.selector);
        escrow.forfeit(key, block.timestamp, sig);
        vm.expectRevert(BonaFideEscrow.DepositNotActive.selector);
        vm.prank(keeper);
        escrow.refund(key);
    }

    function test_forfeit_acceptsContractWalletMaintainer() public {
        (address owner, uint256 ownerPk) = makeAddrAndKey("walletOwner");
        MockERC1271Wallet wallet = new MockERC1271Wallet(owner);
        _activate(address(wallet), 5000, 14 days, 2e6);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 sigDeadline = block.timestamp + 1 hours;

        escrow.forfeit(key, sigDeadline, _signForfeit(ownerPk, key, 1, sigDeadline));

        assertEq(usdc.balanceOf(FORFEIT_SINK), 1e6);
        assertEq(usdc.balanceOf(contributor), 99e6);
        assertEq(usdc.balanceOf(address(wallet)), 0);
    }

    function test_forfeit_revertsWhenContractWalletRejects() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(makeAddr("walletOwner"));
        _activate(address(wallet), 5000, 14 days, 2e6);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory strangerSig = _signForfeit(maintainerPk, key, 1, sigDeadline);

        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline, strangerSig);
    }

    function test_directTransferIsNeverPaidOut() public {
        address donor = _funded("donor");
        vm.prank(donor);
        usdc.transfer(address(escrow), 5e6);
        bytes32 key = _depositPR7();
        vm.prank(keeper);
        escrow.refund(key);
        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        escrow.forfeit(key, block.timestamp, _signForfeit(maintainerPk, key, 2, block.timestamp));

        assertEq(usdc.balanceOf(address(escrow)), 5e6);
        assertEq(usdc.balanceOf(contributor), 99e6);
        assertEq(usdc.balanceOf(FORFEIT_SINK), 1e6);
    }

    function test_repoChange_doesNotAlterExistingDeposit() public {
        bytes32 key = _depositPR7();
        (address newMaintainer, uint256 newMaintainerPk) = makeAddrAndKey("newMaintainer");
        _activate(newMaintainer, 1000, 30 days, 5e6);

        BonaFideEscrow.Deposit memory d = escrow.depositOf(key);
        assertEq(d.amount, 2e6);
        assertEq(d.forfeitBps, 5000);
        assertEq(d.maintainer, maintainer);
        assertEq(d.deadline, PR7_DEADLINE);

        uint256 sigDeadline = block.timestamp + 1 hours;
        bytes memory newMaintainerSig = _signForfeit(newMaintainerPk, key, 1, sigDeadline);
        vm.expectRevert(BonaFideEscrow.InvalidSignature.selector);
        escrow.forfeit(key, sigDeadline, newMaintainerSig);

        escrow.forfeit(key, sigDeadline, _signForfeit(maintainerPk, key, 1, sigDeadline));
        assertEq(usdc.balanceOf(FORFEIT_SINK), 1e6);
        assertEq(usdc.balanceOf(contributor), 99e6);
    }

    function test_repoChange_appliesToNewDeposits() public {
        _depositPR7();
        address newMaintainer = makeAddr("newMaintainer");
        _activate(newMaintainer, 1000, 30 days, 5e6);

        vm.prank(contributor);
        escrow.deposit(REPO, BonaFideEscrow.Kind.Issue, 7);

        BonaFideEscrow.Deposit memory d = escrow.depositOf(escrow.keyOf(REPO, BonaFideEscrow.Kind.Issue, 7));
        assertEq(d.amount, 5e6);
        assertEq(d.forfeitBps, 1000);
        assertEq(d.maintainer, newMaintainer);
        assertEq(d.deadline, START + 2 days + 30 days);
    }

    function _reentrantSetup() internal returns (ReentrantToken token, BonaFideEscrow e, bytes32 key) {
        token = new ReentrantToken();
        e = new BonaFideEscrow(token, keeper, FORFEIT_SINK, BINDING_DELAY, MAX_AMOUNT);
        vm.prank(keeper);
        e.proposeRepo(REPO, maintainer, 5000, 14 days, 2e6);
        vm.warp(block.timestamp + BINDING_DELAY);
        e.activateRepo(REPO);
        address other = makeAddr("other");
        token.mint(contributor, 100e6);
        token.mint(other, 100e6);
        vm.prank(contributor);
        token.approve(address(e), type(uint256).max);
        vm.prank(other);
        token.approve(address(e), type(uint256).max);
        vm.prank(contributor);
        e.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 7);
        vm.prank(other);
        e.deposit(REPO, BonaFideEscrow.Kind.PullRequest, 8);
        key = e.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 7);
    }

    function test_refund_reentrantTokenCannotDoublePay() public {
        (ReentrantToken token, BonaFideEscrow e, bytes32 key) = _reentrantSetup();
        vm.warp(PR7_DEADLINE);
        token.arm(address(e), abi.encodeCall(BonaFideEscrow.refund, (key)));

        vm.prank(makeAddr("stranger"));
        e.refund(key);

        assertTrue(token.reentered());
        assertFalse(token.reentrySucceeded());
        assertEq(token.balanceOf(contributor), 100e6);
        assertEq(token.balanceOf(address(e)), 2e6);
    }

    function test_forfeit_reentrantRedepositCannotRedirectRefund() public {
        (ReentrantToken token, BonaFideEscrow e, bytes32 key) = _reentrantSetup();
        token.mint(address(token), 100e6);
        token.approveAs(address(e), type(uint256).max);
        token.arm(address(e), abi.encodeCall(BonaFideEscrow.deposit, (REPO, BonaFideEscrow.Kind.PullRequest, 7)));
        uint256 sigDeadline = block.timestamp + 1 hours;

        e.forfeit(key, sigDeadline, _signForfeitAt(e, maintainerPk, key, 1, sigDeadline));

        assertTrue(token.reentered());
        assertEq(token.balanceOf(contributor), 99e6);
        assertEq(token.balanceOf(FORFEIT_SINK), 1e6);
        assertEq(token.balanceOf(address(token)) + token.balanceOf(address(e)), 100e6 + 2e6);
    }

    function test_depositWithAuthorization_reentrantTokenCannotReenter() public {
        (ReentrantToken token, BonaFideEscrow e,) = _reentrantSetup();
        token.mint(address(token), 100e6);
        token.approveAs(address(e), type(uint256).max);
        token.arm(address(e), abi.encodeCall(BonaFideEscrow.deposit, (REPO, BonaFideEscrow.Kind.PullRequest, 10)));

        e.depositWithAuthorization(
            REPO, BonaFideEscrow.Kind.PullRequest, 9, contributor, 0, block.timestamp + 1 hours, SALT, ""
        );

        assertTrue(token.reentered());
        assertFalse(token.reentrySucceeded());
        assertEq(bytes4(token.reentryResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(
            uint8(e.depositOf(e.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 10)).status),
            uint8(BonaFideEscrow.Status.None)
        );
    }

    function test_depositWithAuthorization_recordsTheDepositBeforeCallingTheToken() public {
        (ReentrantToken token, BonaFideEscrow e,) = _reentrantSetup();
        bytes32 key = e.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, 9);
        token.arm(address(e), abi.encodeCall(BonaFideEscrow.depositOf, (key)));

        e.depositWithAuthorization(
            REPO, BonaFideEscrow.Kind.PullRequest, 9, contributor, 0, block.timestamp + 1 hours, SALT, ""
        );

        BonaFideEscrow.Deposit memory seen = abi.decode(token.reentryResult(), (BonaFideEscrow.Deposit));
        assertEq(uint8(seen.status), uint8(BonaFideEscrow.Status.Active));
        assertEq(seen.depositor, contributor);
        assertEq(seen.serial, 3);
    }
}
