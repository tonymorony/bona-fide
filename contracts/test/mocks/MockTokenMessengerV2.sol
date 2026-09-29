// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenMessengerV2} from "../../src/interfaces/ITokenMessengerV2.sol";

/// @dev Records every depositForBurn and pulls the amount like CCTP does before burning it.
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    using SafeERC20 for IERC20;

    struct Burn {
        address sender;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        uint256 allowanceAtCall;
    }

    mapping(uint32 domain => bytes32 tokenMessenger) public remoteTokenMessengers;
    Burn[] private _burns;

    function addRemoteTokenMessenger(uint32 domain, bytes32 tokenMessenger) external {
        remoteTokenMessengers[domain] = tokenMessenger;
    }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        _burns.push(
            Burn(
                msg.sender,
                amount,
                destinationDomain,
                mintRecipient,
                burnToken,
                destinationCaller,
                maxFee,
                minFinalityThreshold,
                IERC20(burnToken).allowance(msg.sender, address(this))
            )
        );
        IERC20(burnToken).safeTransferFrom(msg.sender, address(this), amount);
    }

    function burnCount() external view returns (uint256) {
        return _burns.length;
    }

    function burnAt(uint256 index) external view returns (Burn memory) {
        return _burns[index];
    }
}
