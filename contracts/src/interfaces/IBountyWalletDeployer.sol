// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice What a BountyWallet reads from the factory that deploys it. The wallet takes no constructor arguments,
/// so its init code is the same for every repo and owner, and its CREATE2 address depends only on `(repoId, owner)`.
interface IBountyWalletDeployer {
    function usdc() external view returns (IERC20);

    function keeper() external view returns (address);

    /// @notice The wallet being deployed, valid only during `create`.
    function parameters()
        external
        view
        returns (bytes32 repoId, address owner, uint256 perPayoutLimit, uint256 periodLimit, uint32 periodLength);
}
