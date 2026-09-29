// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";

contract CharityRouter {
    using SafeERC20 for IERC20;

    bytes32 public constant DESTINATION_CALLER = bytes32(0);
    uint256 public constant MAX_FEE = 0;
    uint32 public constant MIN_FINALITY_THRESHOLD = 2000;

    IERC20 public immutable usdc;
    ITokenMessengerV2 public immutable messenger;
    uint32 public immutable destinationDomain;
    bytes32 public immutable mintRecipient;

    event Flushed(address indexed caller, uint256 amount);

    error ZeroAddress();
    error ZeroMintRecipient();
    error UnsupportedDomain();
    error NothingToFlush();

    constructor(IERC20 usdc_, ITokenMessengerV2 messenger_, uint32 destinationDomain_, bytes32 mintRecipient_) {
        if (address(usdc_) == address(0) || address(messenger_) == address(0)) revert ZeroAddress();
        if (mintRecipient_ == bytes32(0)) revert ZeroMintRecipient();
        if (messenger_.remoteTokenMessengers(destinationDomain_) == bytes32(0)) revert UnsupportedDomain();
        usdc = usdc_;
        messenger = messenger_;
        destinationDomain = destinationDomain_;
        mintRecipient = mintRecipient_;
    }

    function flush() external returns (uint256 amount) {
        amount = usdc.balanceOf(address(this));
        if (amount == 0) revert NothingToFlush();
        emit Flushed(msg.sender, amount);
        usdc.forceApprove(address(messenger), amount);
        messenger.depositForBurn(
            amount, destinationDomain, mintRecipient, address(usdc), DESTINATION_CALLER, MAX_FEE, MIN_FINALITY_THRESHOLD
        );
    }
}
