// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {CharityRouter} from "../../src/CharityRouter.sol";
import {MockTokenMessengerV2} from "../mocks/MockTokenMessengerV2.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {RouterHandler} from "./RouterHandler.sol";

/// @dev The router is a direct target, so the fuzzer also calls every state-changing function in its ABI from
/// random senders. A flush of an empty router reverts by design, hence fail-on-revert is off for this suite.
/// forge-config: default.invariant.fail-on-revert = false
contract CharityRouterInvariantTest is Test {
    RouterHandler internal handler;
    CharityRouter internal router;
    MockTokenMessengerV2 internal messenger;
    MockUSDC internal usdc;

    function setUp() public {
        handler = new RouterHandler();
        router = handler.router();
        messenger = handler.messenger();
        usdc = handler.usdc();
        targetContract(address(handler));
        targetContract(address(router));
    }

    function invariant_1_usdcLeavesOnlyToTheFundThroughCctp() public view {
        uint256 burned;
        for (uint256 i; i < messenger.burnCount(); ++i) {
            MockTokenMessengerV2.Burn memory burn = messenger.burnAt(i);
            assertEq(burn.sender, address(router), "burn not made by the router");
            assertEq(burn.destinationDomain, 6, "another domain");
            assertEq(burn.mintRecipient, handler.FUND(), "another recipient");
            assertEq(burn.burnToken, address(usdc), "another token");
            assertEq(burn.destinationCaller, bytes32(0), "a restricted relayer");
            assertEq(burn.maxFee, 0, "a fee");
            assertEq(burn.minFinalityThreshold, 2000, "not a Standard Transfer");
            burned += burn.amount;
        }
        assertEq(usdc.balanceOf(address(messenger)), burned, "USDC reached CCTP outside a recorded burn");
        assertEq(usdc.balanceOf(address(router)) + burned, handler.totalForfeited(), "USDC left another way");
        assertEq(usdc.totalSupply(), handler.totalForfeited(), "USDC appeared from nowhere");
    }

    function invariant_2_eachFlushSendsTheWholeBalance() public view {
        assertFalse(handler.partialFlush());
    }

    function invariant_3_noAllowanceIsLeft() public view {
        assertEq(usdc.allowance(address(router), address(messenger)), 0);
    }

    function invariant_4_anyoneCanFlushExactlyWhenThereIsABalance() public view {
        assertFalse(handler.emptyFlushSucceeded(), "an empty router flushed");
        assertFalse(handler.flushWithBalanceFailed(), "a flush with a balance reverted");
    }

    function afterInvariant() public view {
        RouterHandler.Stats memory s = handler.statsSnapshot();
        console.log("forfeits/handler flushes/empty flush attempts", s.forfeits, s.flushes, s.emptyFlushAttempts);
        console.log("successful pokes/burns recorded", s.pokes, messenger.burnCount());
    }
}
