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
