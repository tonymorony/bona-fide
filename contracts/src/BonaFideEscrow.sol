// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IReceiveWithAuthorization {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

contract BonaFideEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Kind {
        PullRequest,
        Issue
    }

    enum Status {
        None,
        Active,
        Refunded,
        Forfeited
    }

    struct RepoConfig {
        address maintainer;
        uint16 forfeitBps;
        uint32 timeout;
        uint256 amount;
    }

    struct PendingConfig {
        RepoConfig config;
        uint64 effectiveAt;
    }

    struct Deposit {
        address depositor;
        uint64 deadline;
        Status status;
        address maintainer;
        uint16 forfeitBps;
        uint64 serial;
        uint256 amount;
    }

    uint16 public constant MAX_FORFEIT_BPS = 5000;
    uint32 public constant MIN_TIMEOUT = 1 days;
    uint32 public constant MAX_TIMEOUT = 60 days;
    uint64 public constant MIN_BINDING_DELAY = 1 hours;
    bytes32 public constant FORFEIT_TYPEHASH = keccak256("Forfeit(bytes32 key,uint256 serial,uint256 sigDeadline)");

    IERC20 public immutable usdc;
    address public immutable keeper;
    address public immutable forfeitSink;
    uint64 public immutable bindingDelay;
    uint256 public immutable maxAmount;

    uint64 public lastSerial;
    mapping(bytes32 repoId => RepoConfig) private _active;
    mapping(bytes32 repoId => PendingConfig) private _pending;
    mapping(bytes32 key => Deposit) private _deposits;

    event RepoProposed(
        bytes32 indexed repoId,
        address indexed maintainer,
        uint16 forfeitBps,
        uint32 timeout,
        uint256 amount,
        uint64 effectiveAt
    );
    event RepoActivated(
        bytes32 indexed repoId, address indexed maintainer, uint16 forfeitBps, uint32 timeout, uint256 amount
    );
    event Deposited(
        bytes32 indexed key,
        uint64 serial,
        bytes32 indexed repoId,
        Kind kind,
        uint64 number,
        address indexed depositor,
        uint256 amount,
        uint64 deadline
    );
    event Refunded(bytes32 indexed key, uint64 serial, address indexed depositor, uint256 amount, bool byKeeper);
    event Forfeited(bytes32 indexed key, uint64 serial, uint256 forfeited, uint256 refunded);

    error ZeroAddress();
    error ForfeitSinkIsKeeper();
    error ForfeitSinkIsEscrow();
    error BindingDelayTooShort();
    error InvalidAmount();
    error NotKeeper();
    error InvalidForfeitBps();
    error InvalidTimeout();
    error NoPendingConfig();
    error NotYetEffective();
    error RepoNotActive();
    error DepositAlreadyActive();
    error DeadlineNotReached();
    error DepositNotActive();
    error InvalidSignature();
    error DeadlinePassed();
    error SignatureExpired();

    constructor(IERC20 usdc_, address keeper_, address forfeitSink_, uint64 bindingDelay_, uint256 maxAmount_)
        EIP712("BonaFide", "1")
    {
        if (address(usdc_) == address(0) || keeper_ == address(0) || forfeitSink_ == address(0)) revert ZeroAddress();
        if (forfeitSink_ == keeper_) revert ForfeitSinkIsKeeper();
        if (forfeitSink_ == address(this)) revert ForfeitSinkIsEscrow();
        if (bindingDelay_ < MIN_BINDING_DELAY) revert BindingDelayTooShort();
        if (maxAmount_ == 0) revert InvalidAmount();
        usdc = usdc_;
        keeper = keeper_;
        forfeitSink = forfeitSink_;
        bindingDelay = bindingDelay_;
        maxAmount = maxAmount_;
    }

    function proposeRepo(bytes32 repoId, address maintainer, uint16 forfeitBps, uint32 timeout, uint256 amount)
        external
    {
        if (msg.sender != keeper) revert NotKeeper();
        if (maintainer == address(0)) revert ZeroAddress();
        if (forfeitBps > MAX_FORFEIT_BPS) revert InvalidForfeitBps();
        if (timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) revert InvalidTimeout();
        if (amount == 0 || amount > maxAmount) revert InvalidAmount();
        uint64 effectiveAt = uint64(block.timestamp) + bindingDelay;
        _pending[repoId] = PendingConfig(RepoConfig(maintainer, forfeitBps, timeout, amount), effectiveAt);
        emit RepoProposed(repoId, maintainer, forfeitBps, timeout, amount, effectiveAt);
    }

    function activateRepo(bytes32 repoId) external {
        PendingConfig memory p = _pending[repoId];
        if (p.config.maintainer == address(0)) revert NoPendingConfig();
        if (block.timestamp < p.effectiveAt) revert NotYetEffective();
        _active[repoId] = p.config;
        delete _pending[repoId];
        emit RepoActivated(repoId, p.config.maintainer, p.config.forfeitBps, p.config.timeout, p.config.amount);
    }

    function deposit(bytes32 repoId, Kind kind, uint64 number) external nonReentrant {
        (, uint256 amount) = _record(repoId, kind, number, msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    function depositWithAuthorization(
        bytes32 repoId,
        Kind kind,
        uint64 number,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 salt,
        bytes calldata signature
    ) external nonReentrant {
        (bytes32 key, uint256 amount) = _record(repoId, kind, number, from);
        IReceiveWithAuthorization(address(usdc)).receiveWithAuthorization(
            from, address(this), amount, validAfter, validBefore, authorizationNonce(key, salt), signature
        );
    }

    function refund(bytes32 key) external nonReentrant {
        Deposit storage d = _deposits[key];
        if (d.status != Status.Active) revert DepositNotActive();
        bool byKeeper = msg.sender == keeper;
        if (!byKeeper && block.timestamp < d.deadline) revert DeadlineNotReached();

        d.status = Status.Refunded;
        emit Refunded(key, d.serial, d.depositor, d.amount, byKeeper);
        usdc.safeTransfer(d.depositor, d.amount);
    }

    function forfeit(bytes32 key, uint256 sigDeadline, bytes calldata signature) external nonReentrant {
        Deposit storage d = _deposits[key];
        if (d.status != Status.Active) revert DepositNotActive();
        if (block.timestamp >= d.deadline) revert DeadlinePassed();
        if (block.timestamp > sigDeadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(FORFEIT_TYPEHASH, key, uint256(d.serial), sigDeadline)));
        if (!SignatureChecker.isValidSignatureNowCalldata(d.maintainer, digest, signature)) revert InvalidSignature();

        d.status = Status.Forfeited;
        address depositor = d.depositor;
        uint256 forfeited = d.amount * d.forfeitBps / 10_000;
        uint256 refunded = d.amount - forfeited;
        emit Forfeited(key, d.serial, forfeited, refunded);
        usdc.safeTransfer(forfeitSink, forfeited);
        usdc.safeTransfer(depositor, refunded);
    }

    function depositOf(bytes32 key) external view returns (Deposit memory) {
        return _deposits[key];
    }

    function activeConfig(bytes32 repoId) external view returns (RepoConfig memory) {
        return _active[repoId];
    }

    function pendingConfig(bytes32 repoId) external view returns (RepoConfig memory config, uint64 effectiveAt) {
        PendingConfig storage p = _pending[repoId];
        return (p.config, p.effectiveAt);
    }

    function keyOf(bytes32 repoId, Kind kind, uint64 number) public pure returns (bytes32) {
        return keccak256(abi.encode(repoId, kind, number));
    }

    function authorizationNonce(bytes32 key, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(key, salt));
    }

    function _record(bytes32 repoId, Kind kind, uint64 number, address depositor)
        private
        returns (bytes32 key, uint256 amount)
    {
        RepoConfig memory repo = _active[repoId];
        if (repo.maintainer == address(0)) revert RepoNotActive();
        key = keyOf(repoId, kind, number);
        if (_deposits[key].status == Status.Active) revert DepositAlreadyActive();
        uint64 serial = ++lastSerial;
        uint64 deadline = uint64(block.timestamp) + repo.timeout;
        _deposits[key] =
            Deposit(depositor, deadline, Status.Active, repo.maintainer, repo.forfeitBps, serial, repo.amount);
        emit Deposited(key, serial, repoId, kind, number, depositor, repo.amount, deadline);
        return (key, repo.amount);
    }
}
