// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ReentrantToken is ERC20 {
    address public escrow;
    bytes public payload;
    bool public reentered;
    bool public reentrySucceeded;
    bytes public reentryResult;

    constructor() ERC20("Reentrant", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function approveAs(address spender, uint256 amount) external {
        _approve(address(this), spender, amount);
    }

    function arm(address escrow_, bytes calldata payload_) external {
        escrow = escrow_;
        payload = payload_;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256,
        uint256,
        bytes32,
        bytes calldata
    ) external {
        _transfer(from, to, value);
        _reenter();
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from == escrow) _reenter();
    }

    function _reenter() private {
        if (escrow == address(0) || reentered) return;
        reentered = true;
        (reentrySucceeded, reentryResult) = escrow.call(payload);
    }
}
