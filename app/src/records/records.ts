import type { Kind } from "@bona-fide/sdk";
import type { Hex } from "viem";
import { createAcceptance } from "../acceptance.ts";
import { createBlockScanner } from "../blocks.ts";
import { CLOCK_SKEW_SECONDS } from "../config.ts";
import { fullName, type Chain, type ContributorRecord, type ContributorRecords, type GitHub } from "../ports.ts";

/** Most Deposits looked up on GitHub per tick, so catching up on a long history stays under GitHub's rate limit. */
export const LOOKUPS_PER_TICK = 5;
/** Longest wait between lookups that keep failing: about 17 minutes at one tick a second. */
const MAX_WAIT_TICKS = 1024;

/**
 * What the index learned of one Deposit on GitHub: whose PR or issue it was for, and how it ended.
 * Saved, so a restart doesn't look it up again.
 */
export interface RecordLink {
  key: Hex;
  /** The Deposit's Serial, as a decimal string. */
  serial: string;
  /** owner/name, in GitHub's case. */
  repo: string;
  /** Whether the repo was private. Unknown counts as private. */
  private: boolean;
  /** The author's login when it was looked up. */
  author: string;
  /** GitHub's id of the author's account. A link saved without one is looked up again. */
  authorId?: number;
  /**
   * "accepted": refunded on work someone else accepted while the Deposit was on it. "refunded":
   * refunded otherwise, such as at the Timeout.
   */
  outcome: "active" | "accepted" | "refunded" | "forfeited";
}

export interface RecordIndexDeps {
  chain: Chain;
  github: GitHub;
  /** First block to read: the escrow's deploy block, so the record covers every Deposit. */
  fromBlock?: bigint;
  /** Links saved before, such as read back from a file. A later link of the same Deposit wins. */
  links?: RecordLink[];
  /** Keeps each new link, such as by appending it to a file. */
  save?(link: RecordLink): void;
}

export interface RecordIndex extends ContributorRecords {
  /**
   * Reads the escrow's new Deposits, Refunds and Forfeits and links a few more of them to their
   * Contributors. Rejects if a lookup failed; later ticks try it again. The host calls it on a timer.
   */
  tick(): Promise<void>;
  /** The next block to read. */
  readonly position: bigint | undefined;
}

type Status = "active" | "refunded" | "forfeited";

interface Tracked {
  repoId: Hex;
  kind: Kind;
  number: number;
  key: Hex;
  serial: bigint;
  status: Status;
  madeAt: Date;
}

interface Lookup {
  /** Ticks to wait after the next failure. */
  wait: number;
  dueTick: number;
}

// Deposits are keyed by (repo, kind, number) and paid from any address, so a Deposit joins a
// Contributor's record through the author of its PR or issue. The index reads the escrow's events
// from its deploy block on each start, and looks each Deposit up on GitHub when it is made and
// again when it ends: whether its item was accepted is read then.
export function createRecordIndex({ chain, github, fromBlock, links = [], save }: RecordIndexDeps): RecordIndex {
  const acceptance = createAcceptance(github);
  const blocks = createBlockScanner(fromBlock);
  const tracked = new Map<string, Tracked>();
  const linked = new Map<string, RecordLink>();
  /** Each author's linked Deposits, by account id, and by lowercase login as it was when looked up. */
  const byId = new Map<number, Map<string, RecordLink>>();
  const byLogin = new Map<string, Map<string, RecordLink>>();
  const lookups = new Map<string, Lookup>();
  /** Deposits whose item couldn't be found, with the status they had then: a new status looks again. */
  const unlinkable = new Map<string, Status>();
  let ticks = 0;
  let scanned = false;

  for (const link of links) keep(link);

  function keep(link: RecordLink): void {
    const id = `${link.key}:${link.serial}`;
    const before = linked.get(id);
    if (before) {
      byLogin.get(before.author.toLowerCase())?.delete(id);
      if (before.authorId !== undefined) byId.get(before.authorId)?.delete(id);
    }
    linked.set(id, link);
    add(byLogin, link.author.toLowerCase(), id, link);
    if (link.authorId !== undefined) add(byId, link.authorId, id, link);
  }

  function add<K>(index: Map<K, Map<string, RecordLink>>, author: K, id: string, link: RecordLink): void {
    if (!index.has(author)) index.set(author, new Map());
    index.get(author)!.set(id, link);
  }

  // A Deposit needs a lookup until its link says how it ended. A saved link from before a restart
  // needs none, unless it was saved before links named the author's account id.
  function needsLookup(id: string, deposit: Tracked): boolean {
    if (unlinkable.get(id) === deposit.status) return false;
    const link = linked.get(id);
    return !link || link.authorId === undefined || (deposit.status !== "active" && link.outcome === "active");
  }

  function follow(id: string): void {
    const deposit = tracked.get(id);
    if (deposit && needsLookup(id, deposit) && !lookups.has(id)) lookups.set(id, { wait: 1, dueTick: ticks });
  }

  async function lookUp(id: string, deposit: Tracked): Promise<void> {
    const repo = await github.findRepo(deposit.repoId);
    const facts = repo && (await github.itemFacts(repo, deposit.kind, deposit.number));
    const accepted = repo !== null && facts !== null && (await acceptance.forRecord(repo, deposit.number, facts));
    lookups.delete(id);
    // Not a repo the App can see, or no such item, such as a Deposit made before its item opened.
    if (!repo || !facts) return void unlinkable.set(id, deposit.status);
    unlinkable.delete(id);
    // Work accepted before the Deposit was made put nothing at risk.
    const atRisk =
      facts.closedAt === null || deposit.madeAt.getTime() <= facts.closedAt.getTime() + CLOCK_SKEW_SECONDS * 1000;
    const refunded = accepted && atRisk ? "accepted" : "refunded";
    const ended = { active: "active", forfeited: "forfeited", refunded };
    const link: RecordLink = {
      key: deposit.key,
      serial: String(deposit.serial),
      repo: fullName(repo),
      private: repo.private !== false,
      author: facts.author,
      authorId: facts.authorId,
      outcome: ended[deposit.status] as RecordLink["outcome"],
    };
    keep(link);
    try {
      save?.(link);
    } catch (error) {
      // Kept in memory all the same; after a restart it is looked up again.
      console.error(`contributor records: could not save the link of Deposit ${id}:`, error);
    }
  }

  // Forfeits first: an unlinked Forfeit holds back every Record Exemption.
  function due(): string[] {
    const ready = [...lookups].filter(([, lookup]) => lookup.dueTick <= ticks).map(([id]) => id);
    const forfeited = (id: string) => (tracked.get(id)?.status === "forfeited" ? 0 : 1);
    return ready.sort((a, b) => forfeited(a) - forfeited(b)).slice(0, LOOKUPS_PER_TICK);
  }

  return {
    get position() {
      return blocks.position;
    },

    async tick() {
      ticks += 1;
      await blocks.scan(await chain.latestBlock(), async (from, to) => {
        for (const event of await chain.escrowEvents(from, to)) {
          if (event.type === "deposited") {
            const { key, serial, repoId, kind, number, blockTime } = event.deposit;
            const id = `${key}:${serial}`;
            tracked.set(id, { repoId, kind, number, key, serial, status: "active", madeAt: blockTime });
            follow(id);
          } else if (event.type === "refunded" || event.type === "forfeited") {
            const id = `${event.key}:${event.serial}`;
            const deposit = tracked.get(id);
            if (!deposit) continue;
            deposit.status = event.type;
            follow(id);
          }
        }
      });
      scanned = true;

      const failures: unknown[] = [];
      for (const id of due()) {
        try {
          await lookUp(id, tracked.get(id)!);
        } catch (error) {
          failures.push(error);
          const lookup = lookups.get(id)!;
          lookup.dueTick = ticks + lookup.wait;
          lookup.wait = Math.min(lookup.wait * 2, MAX_WAIT_TICKS);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} Deposit(s) not linked to their Contributor yet.`);
      }
    },

    // Counts of public repos only: a record shown to anyone never says who contributes to a private
    // repo. Forfeits anywhere count in forfeitsAnywhere and forfeitReposAnywhere, which are never shown.
    recordOf(login, authorId) {
      const links = authorId === undefined ? byLogin.get(login.toLowerCase()) : byId.get(authorId);
      const record: ContributorRecord = {
        refunds: 0,
        repos: 0,
        otherRefunds: 0,
        forfeits: 0,
        active: 0,
        forfeitsAnywhere: 0,
        forfeitReposAnywhere: 0,
        complete: scanned && ![...lookups.keys()].some((id) => tracked.get(id)?.status === "forfeited"),
      };
      const accepted = new Set<Hex>();
      const repos = new Set<string>();
      const forfeitRepos = new Set<string>();
      for (const link of links?.values() ?? []) {
        if (link.outcome === "forfeited") {
          record.forfeitsAnywhere += 1;
          forfeitRepos.add(link.repo.toLowerCase());
        }
        if (link.private) continue;
        // In their own repo a Contributor can accept their own work. And one item counts once,
        // however many Deposits were made on it.
        const own = link.repo.split("/")[0]!.toLowerCase() === link.author.toLowerCase();
        if (link.outcome === "accepted" && !own && !accepted.has(link.key)) {
          accepted.add(link.key);
          record.refunds += 1;
          repos.add(link.repo.toLowerCase());
        } else if (link.outcome === "accepted" || link.outcome === "refunded") record.otherRefunds += 1;
        else if (link.outcome === "forfeited") record.forfeits += 1;
        else record.active += 1;
      }
      record.repos = repos.size;
      record.forfeitReposAnywhere = forfeitRepos.size;
      return record;
    },
  };
}
