// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {CharityRouter} from "../../src/CharityRouter.sol";
import {MockTokenMessengerV2} from "../mocks/MockTokenMessengerV2.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";

contract RouterHandler is Test {
    struct Stats {
        uint256 forfeits;
        uint256 flushes;
        uint256 emptyFlushAttempts;
        uint256 pokes;
    }

    uint32 public constant BASE = 6;
    bytes32 public constant FUND = 0x000000000000000000000000000000000000000000000000000000000000f00d;
    uint256 public constant MAX_FORFEIT = 25e6;

    MockUSDC public immutable usdc;
    MockTokenMessengerV2 public immutable messenger;
    CharityRouter public immutable router;

    uint256 public totalForfeited;
    bool public partialFlush;
    bool public emptyFlushSucceeded;
    bool public flushWithBalanceFailed;

    Stats public stats;

    constructor() {
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        messenger.addRemoteTokenMessenger(BASE, bytes32(uint256(uint160(address(messenger)))));
        router = new CharityRouter(usdc, messenger, BASE, FUND);
    }

    function forfeit(uint256 amount) external {
        amount = _bound(amount, 1, MAX_FORFEIT);
        usdc.mint(address(router), amount);
        totalForfeited += amount;
        stats.forfeits++;
    }

    function flush(uint256 callerSeed) external {
        uint256 balance = usdc.balanceOf(address(router));
        vm.prank(_anyone(callerSeed));
        try router.flush() returns (uint256 flushed) {
            if (balance == 0) emptyFlushSucceeded = true;
            if (flushed != balance || usdc.balanceOf(address(router)) != 0) partialFlush = true;
            stats.flushes++;
        } catch {
            if (balance != 0) flushWithBalanceFailed = true;
            stats.emptyFlushAttempts++;
        }
    }

    function poke(uint256 callerSeed, bytes calldata data) external {
        vm.prank(_anyone(callerSeed));
        (bool ok,) = address(router).call(data);
        if (ok) stats.pokes++;
    }

    function statsSnapshot() external view returns (Stats memory) {
        return stats;
    }

    function _anyone(uint256 seed) internal pure returns (address) {
        return address(uint160(uint256(keccak256(abi.encode("anyone", seed)))));
    }
}
