// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IReceiveWithAuthorization} from "./BonaFideEscrow.sol";
import {IBountyWalletDeployer} from "./interfaces/IBountyWalletDeployer.sol";

/// @notice One repo's Bounties, funded and owned by its Maintainer. The owner posts a Bounty per issue; the Keeper
/// pays a posted Bounty in full to one payee, within the owner's per-payout and per-period limits; above them the
/// owner signs. Nobody but the owner can post, cancel, withdraw or change limits. No upgrade, no other admin.
/// @dev Deployed only by BountyWalletFactory, at a CREATE2 address that depends on `(repoId, owner)` alone.
contract BountyWallet is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Paid,
        Cancelled
    }

    enum Method {
        Keeper,
        Signature,
        Owner
    }

    struct Bounty {
        uint256 amount;
        uint64 serial;
        Status status;
        address payee;
    }

    uint32 public constant MIN_PERIOD_LENGTH = 1 hours;
    uint32 public constant MAX_PERIOD_LENGTH = 365 days;
    bytes32 public constant PAYOUT_TYPEHASH =
        keccak256("Payout(uint256 issueNumber,uint256 serial,address payee,uint256 amount,uint256 deadline)");

    address public immutable factory;
    IERC20 public immutable usdc;
    address public immutable keeper;
    bytes32 public immutable repoId;
    address public immutable owner;

    uint256 public perPayoutLimit;
    uint256 public periodLimit;
    uint32 public periodLength;
    /// @notice When the current Keeper period began. A period starts with the first Keeper payout after the last
    /// one ended, and lasts `periodLength`.
    uint64 public periodStart;
    uint256 public spentInPeriod;
    bool public keeperEnabled;
    /// @notice The sum of open Bounties. Never more than the wallet's USDC balance.
    uint256 public reserved;
    uint64 public lastSerial;
    mapping(uint64 issueNumber => Bounty) private _bounties;

    event Funded(address indexed from, uint256 amount);
    event BountyPosted(uint64 indexed issueNumber, uint64 serial, uint256 amount);
    event BountyCancelled(uint64 indexed issueNumber, uint64 serial, uint256 amount);
    event Paid(uint64 indexed issueNumber, uint64 serial, address indexed payee, uint256 amount, Method method);
    event Withdrawn(address indexed to, uint256 amount);
    event LimitsSet(uint256 perPayoutLimit, uint256 periodLimit, uint32 periodLength);
    event KeeperEnabled(bool enabled);

    error ZeroAddress();
    error OwnerIsKeeper();
    error NotOwner();
    error NotKeeper();
    error KeeperDisabled();
    error InvalidAmount();
    error InvalidPeriodLength();
    error InsufficientFunds();
    error BountyAlreadyPosted();
    error BountyAlreadyPaid();
    error BountyNotOpen();
    error InvalidRecipient();
    error AbovePayoutLimit();
    error AbovePeriodLimit();
    error InvalidSignature();
    error SignatureExpired();

    constructor() EIP712("BonaFide Bounty", "1") {
        IBountyWalletDeployer deployer = IBountyWalletDeployer(msg.sender);
        (bytes32 repoId_, address owner_, uint256 perPayoutLimit_, uint256 periodLimit_, uint32 periodLength_) =
            deployer.parameters();
        IERC20 usdc_ = deployer.usdc();
        address keeper_ = deployer.keeper();
        if (address(usdc_) == address(0) || keeper_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        if (owner_ == keeper_) revert OwnerIsKeeper();
        factory = msg.sender;
        usdc = usdc_;
        keeper = keeper_;
        repoId = repoId_;
        owner = owner_;
        _setLimits(perPayoutLimit_, periodLimit_, periodLength_);
        keeperEnabled = true;
        emit KeeperEnabled(true);
    }

    /// @notice Pulls `amount` from the caller after an `approve`. Anyone may fund. USDC sent by plain transfer
    /// funds the wallet too, without a `Funded` event.
    function fund(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        emit Funded(msg.sender, amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Funds with one EIP-3009 `ReceiveWithAuthorization` signature by `from`, with `to` = this wallet.
    /// Anyone may submit it. USDC lets only this wallet redeem it, so it can't be redirected.
    function fundWithAuthorization(
        address from,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        emit Funded(from, amount);
        IReceiveWithAuthorization(address(usdc)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, nonce, signature
        );
    }

    /// @notice Reserves `amount` of the unreserved balance for one issue. An issue has at most one open Bounty, and
    /// none after one was paid. A cancelled Bounty can be posted again, under a new serial.
    function postBounty(uint64 issueNumber, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        Bounty storage b = _bounties[issueNumber];
        if (b.status == Status.Open) revert BountyAlreadyPosted();
        if (b.status == Status.Paid) revert BountyAlreadyPaid();
        if (amount == 0) revert InvalidAmount();
        if (amount > available()) revert InsufficientFunds();
        uint64 serial = ++lastSerial;
        _bounties[issueNumber] = Bounty(amount, serial, Status.Open, address(0));
        reserved += amount;
        emit BountyPosted(issueNumber, serial, amount);
    }

    /// @notice Releases an open Bounty's reservation. Any unused payout signature for it stops working.
    function cancelBounty(uint64 issueNumber) external {
        if (msg.sender != owner) revert NotOwner();
        Bounty storage b = _bounties[issueNumber];
        if (b.status != Status.Open) revert BountyNotOpen();
        b.status = Status.Cancelled;
        reserved -= b.amount;
        emit BountyCancelled(issueNumber, b.serial, b.amount);
    }

    /// @notice The Keeper pays an open Bounty, in full, to `payee`. Only while Keeper payouts are enabled, if the
    /// amount is within `perPayoutLimit` and within what is left of `periodLimit` in the current period.
    function keeperPay(uint64 issueNumber, address payee) external nonReentrant {
        if (msg.sender != keeper) revert NotKeeper();
        if (!keeperEnabled) revert KeeperDisabled();
        Bounty storage b = _bounties[issueNumber];
        if (b.status != Status.Open) revert BountyNotOpen();
        uint256 amount = b.amount;
        if (amount > perPayoutLimit) revert AbovePayoutLimit();
        if (block.timestamp >= uint256(periodStart) + periodLength) {
            periodStart = uint64(block.timestamp);
            spentInPeriod = 0;
        }
        if (spentInPeriod + amount > periodLimit) revert AbovePeriodLimit();
        spentInPeriod += amount;
        _pay(issueNumber, b, payee, Method.Keeper);
    }

    /// @notice Anyone relays the owner's EIP-712 signature over
    /// `Payout(uint256 issueNumber,uint256 serial,address payee,uint256 amount,uint256 deadline)` to pay an open
    /// Bounty. Not subject to the Keeper's limits or switch. The owner may sign with an EOA or an ERC-1271 wallet.
    function payWithSignature(uint64 issueNumber, address payee, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        Bounty storage b = _bounties[issueNumber];
        if (b.status != Status.Open) revert BountyNotOpen();
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(PAYOUT_TYPEHASH, uint256(issueNumber), uint256(b.serial), payee, b.amount, deadline))
        );
        if (!SignatureChecker.isValidSignatureNowCalldata(owner, digest, signature)) revert InvalidSignature();
        _pay(issueNumber, b, payee, Method.Signature);
    }

    /// @notice The owner pays an open Bounty directly, such as from a multisig.
    function ownerPay(uint64 issueNumber, address payee) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        Bounty storage b = _bounties[issueNumber];
        if (b.status != Status.Open) revert BountyNotOpen();
        _pay(issueNumber, b, payee, Method.Owner);
    }

    /// @notice The owner takes back unreserved USDC, at any time.
    function withdraw(address to, uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        _checkRecipient(to);
        if (amount == 0) revert InvalidAmount();
        if (amount > available()) revert InsufficientFunds();
        emit Withdrawn(to, amount);
        usdc.safeTransfer(to, amount);
    }

    /// @notice Takes effect at once, raising or lowering. The current period keeps what it has spent.
    function setLimits(uint256 perPayoutLimit_, uint256 periodLimit_, uint32 periodLength_) external {
        if (msg.sender != owner) revert NotOwner();
        _setLimits(perPayoutLimit_, periodLimit_, periodLength_);
    }

    /// @notice The emergency stop: with Keeper payouts disabled, only the owner's signature or the owner can pay.
    function setKeeperEnabled(bool enabled) external {
        if (msg.sender != owner) revert NotOwner();
        keeperEnabled = enabled;
        emit KeeperEnabled(enabled);
    }

    function bountyOf(uint64 issueNumber) external view returns (Bounty memory) {
        return _bounties[issueNumber];
    }

    /// @notice USDC the owner can post as Bounties or withdraw.
    function available() public view returns (uint256) {
        return usdc.balanceOf(address(this)) - reserved;
    }

    /// @notice What the Keeper could still pay in total if it paid now, before `perPayoutLimit` and the switch.
    function keeperAllowance() external view returns (uint256) {
        if (block.timestamp >= uint256(periodStart) + periodLength) return periodLimit;
        return spentInPeriod >= periodLimit ? 0 : periodLimit - spentInPeriod;
    }

    function _pay(uint64 issueNumber, Bounty storage b, address payee, Method method) private {
        _checkRecipient(payee);
        b.status = Status.Paid;
        b.payee = payee;
        uint256 amount = b.amount;
        reserved -= amount;
        emit Paid(issueNumber, b.serial, payee, amount, method);
        usdc.safeTransfer(payee, amount);
    }

    function _setLimits(uint256 perPayoutLimit_, uint256 periodLimit_, uint32 periodLength_) private {
        if (periodLength_ < MIN_PERIOD_LENGTH || periodLength_ > MAX_PERIOD_LENGTH) revert InvalidPeriodLength();
        perPayoutLimit = perPayoutLimit_;
        periodLimit = periodLimit_;
        periodLength = periodLength_;
        emit LimitsSet(perPayoutLimit_, periodLimit_, periodLength_);
    }

    function _checkRecipient(address to) private view {
        if (to == address(0) || to == address(this) || to == keeper) revert InvalidRecipient();
    }
}
