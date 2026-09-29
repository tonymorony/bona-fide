// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BonaFideEscrow} from "../src/BonaFideEscrow.sol";
import {CharityRouter} from "../src/CharityRouter.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {EscrowFixture} from "./utils/EscrowFixture.sol";

uint32 constant BASE = 6;
bytes32 constant FUND = 0x000000000000000000000000000000000000000000000000000000000000f00d;
bytes32 constant BASE_TOKEN_MESSENGER = 0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa;

contract CharityRouterTest is Test {
    uint32 internal constant ETHEREUM = 0;
    uint32 internal constant ARC = 26;

    MockUSDC internal usdc;
    MockTokenMessengerV2 internal messenger;
    CharityRouter internal router;

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        messenger.addRemoteTokenMessenger(BASE, BASE_TOKEN_MESSENGER);
        router = new CharityRouter(usdc, messenger, BASE, FUND);
    }

    function test_constructor_storesParameters() public view {
        assertEq(address(router.usdc()), address(usdc));
        assertEq(address(router.messenger()), address(messenger));
        assertEq(router.destinationDomain(), 6);
        assertEq(router.mintRecipient(), FUND);
    }

    function test_constructor_revertsOnZeroUsdc() public {
        vm.expectRevert(CharityRouter.ZeroAddress.selector);
        new CharityRouter(MockUSDC(address(0)), messenger, BASE, FUND);
    }

    function test_constructor_revertsOnZeroMessenger() public {
        vm.expectRevert(CharityRouter.ZeroAddress.selector);
        new CharityRouter(usdc, MockTokenMessengerV2(address(0)), BASE, FUND);
    }

    function test_constructor_revertsOnZeroMintRecipient() public {
        vm.expectRevert(CharityRouter.ZeroMintRecipient.selector);
        new CharityRouter(usdc, messenger, BASE, bytes32(0));
    }

    function test_constructor_revertsOnADomainTheMessengerDoesNotRoute() public {
        vm.expectRevert(CharityRouter.UnsupportedDomain.selector);
        new CharityRouter(usdc, messenger, ARC, FUND);
    }

    function test_constructor_acceptsEthereumWhoseDomainIsZero() public {
        messenger.addRemoteTokenMessenger(ETHEREUM, BASE_TOKEN_MESSENGER);

        CharityRouter toEthereum = new CharityRouter(usdc, messenger, ETHEREUM, FUND);

        assertEq(toEthereum.destinationDomain(), 0);
    }

    function test_flush_burnsTheWholeBalance() public {
        usdc.mint(address(router), 3_500_000);

        router.flush();

        assertEq(messenger.burnCount(), 1);
        assertEq(messenger.burnAt(0).amount, 3_500_000);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(messenger)), 3_500_000);
    }

    function test_flush_isAStandardTransferToTheFundOnTheFixedDomain() public {
        usdc.mint(address(router), 1e6);

        router.flush();

        MockTokenMessengerV2.Burn memory burn = messenger.burnAt(0);
        assertEq(burn.sender, address(router));
        assertEq(burn.destinationDomain, 6);
        assertEq(burn.mintRecipient, FUND);
        assertEq(burn.burnToken, address(usdc));
        assertEq(burn.destinationCaller, bytes32(0));
        assertEq(burn.maxFee, 0);
        assertEq(burn.minFinalityThreshold, 2000);
    }

    function test_flush_revertsWhenThereIsNothingToFlush() public {
        vm.expectRevert(CharityRouter.NothingToFlush.selector);
        router.flush();
    }

    function test_flush_secondFlushWithNothingNewReverts() public {
        usdc.mint(address(router), 1e6);
        router.flush();

        vm.expectRevert(CharityRouter.NothingToFlush.selector);
        router.flush();
    }

    function test_flush_approvesExactlyTheBalance() public {
        usdc.mint(address(router), 2_250_000);

        router.flush();

        assertEq(messenger.burnAt(0).allowanceAtCall, 2_250_000);
    }

    function test_flush_leavesNoAllowance() public {
        usdc.mint(address(router), 2_250_000);

        router.flush();

        assertEq(usdc.allowance(address(router), address(messenger)), 0);
    }

    function test_flush_emitsFlushed() public {
        usdc.mint(address(router), 1_500_000);
        address keeper = makeAddr("keeper");

        vm.expectEmit(address(router));
        emit CharityRouter.Flushed(keeper, 1_500_000);
        vm.prank(keeper);
        router.flush();
    }
}

contract CharityRouterWithEscrowTest is EscrowFixture {
    MockTokenMessengerV2 internal messenger;
    CharityRouter internal router;

    function setUp() public override {
        super.setUp();
        messenger = new MockTokenMessengerV2();
        messenger.addRemoteTokenMessenger(BASE, BASE_TOKEN_MESSENGER);
        router = new CharityRouter(usdc, messenger, BASE, FUND);
        escrow = new BonaFideEscrow(usdc, keeper, address(router), BINDING_DELAY, MAX_AMOUNT);
        vm.prank(contributor);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function test_forfeitedShareReachesTheFundWithTheNextFlush() public {
        bytes32 key = _depositPR7();
        uint256 sigDeadline = block.timestamp + 1 hours;
        escrow.forfeit(key, sigDeadline, _signForfeit(maintainerPk, key, 1, sigDeadline));
        assertEq(usdc.balanceOf(address(router)), 1e6);

        vm.prank(makeAddr("anyone"));
        router.flush();

        MockTokenMessengerV2.Burn memory burn = messenger.burnAt(0);
        assertEq(burn.amount, 1e6);
        assertEq(burn.destinationDomain, BASE);
        assertEq(burn.mintRecipient, FUND);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(contributor), 99e6);
    }

    function test_forfeitsAccumulateBetweenFlushes() public {
        _activate(maintainer, 5000, 14 days, 2e6);
        uint256 sigDeadline = block.timestamp + 1 hours;
        for (uint64 pr = 1; pr <= 3; ++pr) {
            vm.prank(contributor);
            escrow.deposit(REPO, BonaFideEscrow.Kind.PullRequest, pr);
            bytes32 key = escrow.keyOf(REPO, BonaFideEscrow.Kind.PullRequest, pr);
            uint256 serial = escrow.depositOf(key).serial;
            escrow.forfeit(key, sigDeadline, _signForfeit(maintainerPk, key, serial, sigDeadline));
        }

        router.flush();

        assertEq(messenger.burnCount(), 1);
        assertEq(messenger.burnAt(0).amount, 3e6);
    }
}
