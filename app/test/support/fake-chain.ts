import { keyOf, repoIdOf, type Kind } from "@bona-fide/sdk";
import { pad, toHex, type Address, type Hex } from "viem";
import type { Binding, Chain, Deposit, DepositedEvent, EscrowEvent, RepoBinding } from "../../src/ports.ts";

/** The terms `bind` and `propose` use unless told otherwise: 1 USDC, 50% and 7 days. */
const TERMS: Binding = {
  maintainer: "0x00000000000000000000000000000000000bEEF1",
  amount: 1_000_000n,
  forfeitBps: 5000,
  timeoutSeconds: 604_800,
};

// An in-memory escrow: one block per Deposit or activation, in the order the test makes them.
export class FakeChain implements Chain {
  private readonly events: DepositedEvent[] = [];
  private readonly log: { blockNumber: bigint; event: EscrowEvent }[] = [];
  private blocks = 0n;
  /** Refunded or forfeited Deposits, by `key:serial`. */
  private readonly resolved = new Set<string>();
  private readonly bindings = new Map<Hex, RepoBinding>();
  private readonly starts = new Map<Hex, Date>();
  /** Runs after each depositSince read, to model a Deposit landing right after it. */
  afterRead?: () => Promise<void>;

  /**
   * Makes a Binding active for the repo at once. Unless it had one before, Bona Fide started there
   * at `startedAt`: by default long before any PR or issue.
   */
  bind(repo: string, terms: Partial<Binding> = {}, startedAt = new Date(0)): void {
    this.bindings.set(repoIdOf(repo), { ...this.bindingFor(repo), active: { ...TERMS, ...terms } });
    this.start(repo, startedAt);
  }

  /** Proposes a Binding for the repo that takes effect at `effectiveAt`. */
  propose(repo: string, effectiveAt: Date, terms: Partial<Binding> = {}): void {
    this.bindings.set(repoIdOf(repo), { ...this.bindingFor(repo), pending: { ...TERMS, ...terms, effectiveAt } });
  }

  /** Activates the repo's Binding in a new block stamped `at`, as anyone may once its delay has passed. */
  activate(repo: string, terms: Partial<Binding> = {}, at = new Date()): void {
    const { pending } = this.bindingFor(repo);
    this.bindings.set(repoIdOf(repo), { active: pending ?? { ...TERMS, ...terms }, pending: null });
    this.start(repo, at);
    this.log.push({ blockNumber: ++this.blocks, event: { type: "activated", repoId: repoIdOf(repo) } });
  }

  deposit(d: {
    repo: string;
    kind: Kind;
    number: number;
    depositor: Address;
    at: Date;
    amount?: bigint;
  }): DepositedEvent {
    const repoId = repoIdOf(d.repo);
    const serial = BigInt(this.events.length + 1);
    const event: DepositedEvent = {
      key: keyOf(repoId, d.kind, d.number),
      serial,
      repoId,
      kind: d.kind,
      number: d.number,
      depositor: d.depositor,
      amount: d.amount ?? 1_000_000n,
      txHash: pad(toHex(serial), { size: 32 }),
      blockNumber: ++this.blocks,
      blockTime: d.at,
    };
    this.events.push(event);
    this.log.push({ blockNumber: event.blockNumber, event: { type: "deposited", deposit: event } });
    return event;
  }

  /** Forfeits the key's latest Deposit in a new block. */
  forfeit(key: Hex): void {
    this.resolve("forfeited", key);
  }

  /** Refunds the key's latest Deposit in a new block. */
  refund(key: Hex): void {
    this.resolve("refunded", key);
  }

  async depositSince(key: Hex, since: Date, seen?: DepositedEvent): Promise<Deposit | null> {
    const latest = this.events.filter((e) => e.key === key).at(-1);
    await this.afterRead?.();
    if (!latest || this.resolved.has(`${key}:${latest.serial}`)) return null;
    const madeAt = seen?.serial === latest.serial ? seen.blockTime : latest.blockTime;
    return madeAt >= since ? latest : null;
  }

  async latestBlock(): Promise<bigint> {
    return this.blocks;
  }

  async escrowEvents(fromBlock: bigint, toBlock: bigint): Promise<EscrowEvent[]> {
    return this.log
      .filter(({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= toBlock)
      .map(({ event }) => event);
  }

  async bindingOf(repoId: Hex): Promise<RepoBinding> {
    return this.bindings.get(repoId) ?? { active: null, pending: null };
  }

  async startedAt(repoId: Hex): Promise<Date | null> {
    return this.starts.get(repoId) ?? null;
  }

  private resolve(type: "refunded" | "forfeited", key: Hex): void {
    const serial = this.events.filter((e) => e.key === key).at(-1)?.serial ?? 0n;
    this.resolved.add(`${key}:${serial}`);
    this.log.push({ blockNumber: ++this.blocks, event: { type, key, serial } });
  }

  private bindingFor(repo: string): RepoBinding {
    return this.bindings.get(repoIdOf(repo)) ?? { active: null, pending: null };
  }

  /** Only the first Binding to take effect starts Bona Fide in the repo. */
  private start(repo: string, at: Date): void {
    if (!this.starts.has(repoIdOf(repo))) this.starts.set(repoIdOf(repo), at);
  }
}
