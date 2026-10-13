// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {BountyWallet} from "./BountyWallet.sol";
import {IBountyWalletDeployer} from "./interfaces/IBountyWalletDeployer.sol";

/// @notice Deploys one BountyWallet per (repo, owner) at a CREATE2 address that depends only on `(repoId, owner)`, so
/// the App and the pages find a repo's wallet from its Binding's Maintainer. Immutable: no owner or admin.
contract BountyWalletFactory is IBountyWalletDeployer {
    IERC20 public immutable usdc;
    address public immutable keeper;
    bytes32 public immutable walletInitCodeHash;

    mapping(bytes32 repoId => mapping(address owner => address wallet)) public walletOf;

    bytes32 private transient _repoId;
    address private transient _owner;
    uint256 private transient _perPayoutLimit;
    uint256 private transient _periodLimit;
    uint32 private transient _periodLength;

    event WalletCreated(bytes32 indexed repoId, address indexed owner, address wallet);

    error ZeroAddress();
    error WalletExists();

    constructor(IERC20 usdc_, address keeper_) {
        if (address(usdc_) == address(0) || keeper_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        keeper = keeper_;
        walletInitCodeHash = keccak256(type(BountyWallet).creationCode);
    }

    /// @notice Creates the caller's wallet for `repoId`, owned by the caller, with its first limits.
    function create(bytes32 repoId, uint256 perPayoutLimit, uint256 periodLimit, uint32 periodLength)
        external
        returns (BountyWallet wallet)
    {
        if (walletOf[repoId][msg.sender] != address(0)) revert WalletExists();
        _repoId = repoId;
        _owner = msg.sender;
        _perPayoutLimit = perPayoutLimit;
        _periodLimit = periodLimit;
        _periodLength = periodLength;
        wallet = new BountyWallet{salt: saltOf(repoId, msg.sender)}();
        walletOf[repoId][msg.sender] = address(wallet);
        emit WalletCreated(repoId, msg.sender, address(wallet));
    }

    function parameters()
        external
        view
        returns (bytes32 repoId, address owner, uint256 perPayoutLimit, uint256 periodLimit, uint32 periodLength)
    {
        return (_repoId, _owner, _perPayoutLimit, _periodLimit, _periodLength);
    }

    /// @notice The address `owner`'s wallet for `repoId` has, or will have once created.
    function predict(bytes32 repoId, address owner) external view returns (address) {
        return Create2.computeAddress(saltOf(repoId, owner), walletInitCodeHash);
    }

    function saltOf(bytes32 repoId, address owner) public pure returns (bytes32) {
        return keccak256(abi.encode(repoId, owner));
    }
}
