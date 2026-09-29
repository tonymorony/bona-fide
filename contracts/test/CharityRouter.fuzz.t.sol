// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CharityRouter} from "../src/CharityRouter.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract CharityRouterFuzzTest is Test {
    uint32 internal constant BASE = 6;
    bytes32 internal constant FUND = 0x000000000000000000000000000000000000000000000000000000000000f00d;
    uint256 internal constant CCTP_BURN_LIMIT_PER_MESSAGE = 10_000_000e6;

    MockUSDC internal usdc;
    MockTokenMessengerV2 internal messenger;
    CharityRouter internal router;

    function setUp() public {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        messenger.addRemoteTokenMessenger(BASE, bytes32(uint256(uint160(address(messenger)))));
        router = new CharityRouter(usdc, messenger, BASE, FUND);
    }

    function testFuzz_flush_anyoneSendsTheWholeBalanceToTheFund(address caller, uint256 amount) public {
        amount = bound(amount, 1, CCTP_BURN_LIMIT_PER_MESSAGE);
        usdc.mint(address(router), amount);

        vm.prank(caller);
        uint256 flushed = router.flush();

        MockTokenMessengerV2.Burn memory burn = messenger.burnAt(0);
        assertEq(flushed, amount);
        assertEq(burn.amount, amount);
        assertEq(burn.destinationDomain, BASE);
        assertEq(burn.mintRecipient, FUND);
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(usdc.balanceOf(address(messenger)), amount);
        assertEq(usdc.allowance(address(router), address(messenger)), 0);
    }

    function testFuzz_noCallButFlushMovesFunds(address caller, bytes calldata data) public {
        vm.assume(data.length < 4 || bytes4(data[:4]) != CharityRouter.flush.selector);
        usdc.mint(address(router), 5e6);

        vm.prank(caller);
        (bool ok,) = address(router).call(data);

        if (ok) assertTrue(_isReadOnly(bytes4(data[:4])), "a call other than flush or a getter succeeded");
        assertEq(usdc.balanceOf(address(router)), 5e6);
        assertEq(usdc.allowance(address(router), address(messenger)), 0);
        assertEq(messenger.burnCount(), 0);
    }

    function _isReadOnly(bytes4 selector) internal view returns (bool) {
        return selector == router.usdc.selector || selector == router.messenger.selector
            || selector == router.destinationDomain.selector || selector == router.mintRecipient.selector
            || selector == router.DESTINATION_CALLER.selector || selector == router.MAX_FEE.selector
            || selector == router.MIN_FINALITY_THRESHOLD.selector;
    }
}
