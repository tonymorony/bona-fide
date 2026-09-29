// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The part of Circle's CCTP V2 TokenMessengerV2 that the Charity router uses.
/// Checked read-only against the deployed messenger on Arc testnet and mainnet.
interface ITokenMessengerV2 {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    function remoteTokenMessengers(uint32 domain) external view returns (bytes32);
}
