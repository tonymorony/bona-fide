import { getAddress, isAddressEqual, pad, toHex, zeroAddress, type Address, type Hex } from "viem";
import {
  BountyRejection,
  type BountyWallets,
  type WalletBounty,
  type WalletEvent,
  type WalletState,
} from "../../src/bounties/wallet.ts";
import { repoIdOf } from "../../src/keys.ts";

export const KEEPER: Address = getAddress("0x000000000000000000000000000000000000cafe");

interface FakeWallet {
  owner: Address;
  perPayoutLimit: bigint;
  /** What the Keeper may still pay in this period. */
  keeperAllowance: bigint;
  keeperEnabled: boolean;
  lastSerial: bigint;
  bounties: Map<number, WalletBounty>;
  /** Each Payout's transaction, by `issue:serial`. */
  paid: Map<string, Hex>;
}

export interface Limits {
  perPayoutLimit?: bigint;
  keeperAllowance?: bigint;
  keeperEnabled?: boolean;
}

// In-memory Bounty wallets that refuse what the real one refuses. Transactions get made-up hashes.
// Creating a wallet and posting a Bounty each take a block of their own, in the order the test makes them.
export class FakeBountyWallets implements BountyWallets {
  readonly keeper = KEEPER;
  private readonly wallets = new Map<Address, FakeWallet>();
  private readonly byOwner = new Map<string, Address>();
  private readonly log: { blockNumber: bigint; event: WalletEvent }[] = [];
  private transactions = 0;
  /** The `known` wallets each walletEvents read was given. */
  readonly reads: Address[][] = [];
  /** Every Payout sent, in order. */
  readonly sent: { method: "keeper" | "signature"; wallet: Address; issue: number; payee: Address; txHash: Hex }[] = [];
  /** Runs inside keeperPay before it reads the Bounty, such as to pay it some other way first. */
  beforeKeeperPay?: () => void;

  /** Creates `owner`'s wallet for the repo, 100 USDC per payout and per period unless told otherwise. */
  create(repo: string, owner: Address, limits: Limits = {}): Address {
    const wallet = pad(toHex(this.wallets.size + 1), { size: 20 });
    this.wallets.set(wallet, {
      owner,
      perPayoutLimit: limits.perPayoutLimit ?? 100_000_000n,
      keeperAllowance: limits.keeperAllowance ?? 100_000_000n,
      keeperEnabled: limits.keeperEnabled ?? true,
      lastSerial: 0n,
      bounties: new Map(),
      paid: new Map(),
    });
    this.byOwner.set(`${repoIdOf(repo)}:${owner.toLowerCase()}`, wallet);
    this.emit({ type: "created", wallet, repoId: repoIdOf(repo), owner });
    return wallet;
  }

  /** Posts a Bounty on the issue and returns its serial. */
  post(wallet: Address, issue: number, amount: bigint): bigint {
    const w = this.wallet(wallet);
    const serial = ++w.lastSerial;
    w.bounties.set(issue, { status: "open", amount, serial, payee: zeroAddress });
    this.emit({ type: "posted", wallet, issueNumber: issue, serial, amount });
    return serial;
  }

  cancel(wallet: Address, issue: number): void {
    const bounty = this.wallet(wallet).bounties.get(issue)!;
    bounty.status = "cancelled";
  }

  /** Changes the wallet's limits, as its owner may at any time. */
  setLimits(wallet: Address, limits: Limits): void {
    Object.assign(this.wallet(wallet), limits);
  }

  /** Pays the Bounty as the owner would, directly, outside the App. */
  ownerPay(wallet: Address, issue: number, payee: Address): Hex {
    return this.pay(wallet, issue, payee, "signature");
  }

  bountyOf(wallet: Address, issue: number): WalletBounty | undefined {
    return this.wallet(wallet).bounties.get(issue);
  }

  async chainId(): Promise<number> {
    return 31337;
  }

  async now(): Promise<bigint> {
    return 1_800_000_000n;
  }

  async isValidSignature(): Promise<boolean> {
    return false;
  }

  async walletOf(repoId: Hex, owner: Address): Promise<Address | null> {
    return this.byOwner.get(`${repoId}:${owner.toLowerCase()}`) ?? null;
  }

  async stateOf(wallet: Address, issue: number): Promise<WalletState> {
    const w = this.wallet(wallet);
    const bounty = w.bounties.get(issue) ?? { status: "none", amount: 0n, serial: 0n, payee: zeroAddress };
    return {
      owner: w.owner,
      bounty: { ...bounty },
      perPayoutLimit: w.perPayoutLimit,
      keeperAllowance: w.keeperAllowance,
      keeperEnabled: w.keeperEnabled,
    };
  }

  async keeperPay(wallet: Address, issue: number, payee: Address, serial: bigint): Promise<Hex | null> {
    this.beforeKeeperPay?.();
    const w = this.wallet(wallet);
    const bounty = w.bounties.get(issue);
    if (bounty?.status !== "open" || bounty.serial !== serial) return null;
    if (!w.keeperEnabled) throw new BountyRejection("KeeperDisabled");
    if (bounty.amount > w.perPayoutLimit) throw new BountyRejection("AbovePayoutLimit");
    if (bounty.amount > w.keeperAllowance) throw new BountyRejection("AbovePeriodLimit");
    w.keeperAllowance -= bounty.amount;
    return this.pay(wallet, issue, payee, "keeper");
  }

  async payWithSignature(): Promise<Hex> {
    throw new BountyRejection("InvalidSignature");
  }

  async paidTransaction(wallet: Address, issue: number, serial: bigint): Promise<Hex | null> {
    return this.wallet(wallet).paid.get(`${issue}:${serial}`) ?? null;
  }

  async latestBlock(): Promise<bigint> {
    return BigInt(this.log.length);
  }

  /** As the real ones: every wallet created, and the Bounties of the known ones or of one created in the range. */
  async walletEvents(known: Address[], fromBlock: bigint, toBlock: bigint): Promise<WalletEvent[]> {
    this.reads.push([...known]);
    const events = this.log
      .filter(({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= toBlock)
      .map(({ event }) => event);
    const created = events.flatMap((event) => (event.type === "created" ? [event.wallet] : []));
    return events.filter((event) => event.type === "created" || [...known, ...created].includes(event.wallet));
  }

  private emit(event: WalletEvent): void {
    this.log.push({ blockNumber: BigInt(this.log.length + 1), event });
  }

  private pay(wallet: Address, issue: number, payee: Address, method: "keeper" | "signature"): Hex {
    const w = this.wallet(wallet);
    const bounty = w.bounties.get(issue);
    if (bounty?.status !== "open") throw new BountyRejection("BountyNotOpen");
    if ([zeroAddress, wallet, KEEPER].some((no) => isAddressEqual(no, payee))) {
      throw new BountyRejection("InvalidRecipient");
    }
    bounty.status = "paid";
    bounty.payee = payee;
    const txHash = pad(toHex(++this.transactions), { size: 32 });
    w.paid.set(`${issue}:${bounty.serial}`, txHash);
    this.sent.push({ method, wallet, issue, payee, txHash });
    return txHash;
  }

  private wallet(wallet: Address): FakeWallet {
    const w = this.wallets.get(wallet);
    if (!w) throw new Error(`no wallet ${wallet}`);
    return w;
  }
}
