import { parseAbi } from "viem";

// The parts of the contracts the pages use. test/abi.test.ts holds them to the Foundry artifacts.

export const escrowAbi = parseAbi([
  "struct RepoConfig { address maintainer; uint16 forfeitBps; uint32 timeout; uint256 amount; }",
  "struct Deposit { address depositor; uint64 deadline; uint8 status; address maintainer; uint16 forfeitBps; uint64 serial; uint256 amount; }",
  "function activeConfig(bytes32 repoId) view returns (RepoConfig)",
  "function pendingConfig(bytes32 repoId) view returns (RepoConfig config, uint64 effectiveAt)",
  "function depositOf(bytes32 key) view returns (Deposit)",
  "function bindingDelay() view returns (uint64)",
  "function deposit(bytes32 repoId, uint8 kind, uint64 number)",
  "function refund(bytes32 key)",
  "event Deposited(bytes32 indexed key, uint64 serial, bytes32 indexed repoId, uint8 kind, uint64 number, address indexed depositor, uint256 amount, uint64 deadline)",
  "event Refunded(bytes32 indexed key, uint64 serial, address indexed depositor, uint256 amount, bool byKeeper)",
  "event Forfeited(bytes32 indexed key, uint64 serial, uint256 forfeited, uint256 refunded)",
  "event RepoActivated(bytes32 indexed repoId, address indexed maintainer, uint16 forfeitBps, uint32 timeout, uint256 amount)",
  "error RepoNotActive()",
  "error DepositAlreadyActive()",
  "error DeadlineNotReached()",
  "error DepositNotActive()",
]);

export const routerAbi = parseAbi([
  "function flush() returns (uint256 amount)",
  "event Flushed(address indexed caller, uint256 amount)",
  "error NothingToFlush()",
]);

export const usdcAbi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

/** The escrow's Status enum in order. */
export const STATUSES = ["none", "active", "refunded", "forfeited"] as const;
export type Status = (typeof STATUSES)[number];

export const bountyFactoryAbi = parseAbi([
  "function walletOf(bytes32 repoId, address owner) view returns (address)",
  "function create(bytes32 repoId, uint256 perPayoutLimit, uint256 periodLimit, uint32 periodLength) returns (address wallet)",
  "event WalletCreated(bytes32 indexed repoId, address indexed owner, address wallet)",
  "error WalletExists()",
]);

export const bountyWalletAbi = parseAbi([
  "struct Bounty { uint256 amount; uint64 serial; uint8 status; address payee; }",
  "function owner() view returns (address)",
  "function keeper() view returns (address)",
  "function perPayoutLimit() view returns (uint256)",
  "function periodLimit() view returns (uint256)",
  "function periodLength() view returns (uint32)",
  "function periodStart() view returns (uint64)",
  "function spentInPeriod() view returns (uint256)",
  "function keeperEnabled() view returns (bool)",
  "function reserved() view returns (uint256)",
  "function available() view returns (uint256)",
  "function keeperAllowance() view returns (uint256)",
  "function bountyOf(uint64 issueNumber) view returns (Bounty)",
  "function fund(uint256 amount)",
  "function fundWithAuthorization(address from, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
  "function postBounty(uint64 issueNumber, uint256 amount)",
  "function cancelBounty(uint64 issueNumber)",
  "function payWithSignature(uint64 issueNumber, address payee, uint256 deadline, bytes signature)",
  "function ownerPay(uint64 issueNumber, address payee)",
  "function withdraw(address to, uint256 amount)",
  "function setLimits(uint256 perPayoutLimit_, uint256 periodLimit_, uint32 periodLength_)",
  "function setKeeperEnabled(bool enabled)",
  "event Funded(address indexed from, uint256 amount)",
  "event BountyPosted(uint64 indexed issueNumber, uint64 serial, uint256 amount)",
  "event BountyCancelled(uint64 indexed issueNumber, uint64 serial, uint256 amount)",
  "event Paid(uint64 indexed issueNumber, uint64 serial, address indexed payee, uint256 amount, uint8 method)",
  "event Withdrawn(address indexed to, uint256 amount)",
  "event LimitsSet(uint256 perPayoutLimit, uint256 periodLimit, uint32 periodLength)",
  "event KeeperEnabled(bool enabled)",
  "error NotOwner()",
  "error KeeperDisabled()",
  "error InvalidAmount()",
  "error InvalidPeriodLength()",
  "error InsufficientFunds()",
  "error BountyAlreadyPosted()",
  "error BountyAlreadyPaid()",
  "error BountyNotOpen()",
  "error InvalidRecipient()",
  "error InvalidSignature()",
  "error SignatureExpired()",
]);

/** The Bounty wallet's Status enum in order. */
export const BOUNTY_STATUSES = ["none", "open", "paid", "cancelled"] as const;
export type BountyStatus = (typeof BOUNTY_STATUSES)[number];

/** The Bounty wallet's Method enum in order: who paid a Payout. */
export const PAYOUT_METHODS = ["keeper", "signature", "owner"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
