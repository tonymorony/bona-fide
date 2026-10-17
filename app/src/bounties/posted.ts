import { isAddressEqual, type Address, type Hex } from "viem";
import { createBlockScanner } from "../blocks.ts";
import { CONFIG_PATH, parseConfig } from "../config.ts";
import type { Chain, GitHub } from "../ports.ts";
import { bountyMarkers } from "./bounties.ts";
import { bountyPostedNote, repoPageLink } from "./copy.ts";
import type { BountyWallets, WalletEvent } from "./wallet.ts";

/** How often the host looks for new Bounties: a note a minute late is soon enough, and each look is a log query. */
export const BOUNTY_NOTE_MS = 60_000;
/** Tries per Bounty. Waits double between tries: 1, 2, 4 … 256 ticks, about 4 hours at one tick a minute. */
const MAX_ATTEMPTS = 10;

export interface BountyNoticeDeps {
  github: GitHub;
  /** The escrow, for each repo's active Binding: only its Maintainer's wallet is the repo's. */
  chain: Pick<Chain, "bindingOf">;
  wallets: BountyWallets;
  /** Whether a model can confirm a PR resolves its issue. Without one, every Bounty waits for the Maintainer. */
  withModel: boolean;
  /** The Bounty page. The note links the repo page beside it. */
  bountyPageUrl: string;
  /** First block to read: the factory's deploy block, so no wallet or open Bounty is missed. */
  fromBlock?: bigint;
}

export interface BountyNotices {
  /**
   * Notes each Bounty posted since the last tick on its issue, once. Rejects if a note failed; later
   * ticks try it again, less and less often. The host calls it on a timer.
   */
  tick(): Promise<void>;
  /** The next block to read. */
  readonly position: bigint | undefined;
}

type Posted = Extract<WalletEvent, { type: "posted" }>;

interface Retry {
  posted: Posted;
  attempts: number;
  dueTick: number;
}

// A Contributor works on the issue, not on the repo page, so a Bounty is announced there. Only a
// Bounty from the wallet the repo's active Binding's Maintainer created, still open under the same
// Serial, on an open issue: a wallet anyone else made for the repo is ignored.
export function createBountyNotices({
  github,
  chain,
  wallets,
  withModel,
  bountyPageUrl,
  fromBlock,
}: BountyNoticeDeps): BountyNotices {
  const blocks = createBlockScanner(fromBlock);
  /** Every wallet the factory created, by address: whose it is, and for which repo. */
  const created = new Map<Address, { repoId: Hex; owner: Address }>();
  let ticks = 0;
  let retries: Retry[] = [];

  async function announce(posted: Posted): Promise<void> {
    const made = created.get(posted.wallet);
    if (!made) return;
    const repo = await github.findRepo(made.repoId);
    if (!repo) return;
    const { active } = await chain.bindingOf(made.repoId);
    if (!active || !isAddressEqual(active.maintainer, made.owner)) return;
    const state = await wallets.stateOf(posted.wallet, posted.issueNumber);
    const { bounty } = state;
    if (bounty.status !== "open" || bounty.serial !== posted.serial) return;
    // Without the file the App does nothing in the repo, and with a file it can't read it pauses.
    const text = await github.readFile(repo, CONFIG_PATH);
    const parsed = text === null ? null : parseConfig(text);
    if (!parsed?.ok) return;
    if (!(await github.isOpenIssue(repo, posted.issueNumber))) return;
    const marker = bountyMarkers(posted.issueNumber, bounty.serial).posted;
    if (await github.hasNote(repo, posted.issueNumber, marker)) return;

    const aboveLimit = bounty.amount > state.perPayoutLimit;
    const keeperPays = parsed.config.bounties && withModel && state.keeperEnabled && !aboveLimit;
    const body = bountyPostedNote({
      issue: posted.issueNumber,
      amount: bounty.amount,
      payer: keeperPays ? "keeper" : "maintainer",
      aboveLimit: aboveLimit ? state.perPayoutLimit : null,
      repoLink: repoPageLink(bountyPageUrl, repo),
    });
    await github.addNote(repo, posted.issueNumber, marker, body);
  }

  // One failing Bounty, such as one on an issue in an archived repo, must not hold up the others.
  async function attempt(posted: Posted, attempts: number, failures: unknown[]): Promise<void> {
    try {
      await announce(posted);
    } catch (error) {
      failures.push(error);
      if (attempts + 1 < MAX_ATTEMPTS) retries.push({ posted, attempts: attempts + 1, dueTick: ticks + 2 ** attempts });
    }
  }

  return {
    get position() {
      return blocks.position;
    },

    async tick() {
      ticks += 1;
      const failures: unknown[] = [];
      const due = retries.filter((retry) => retry.dueTick <= ticks);
      retries = retries.filter((retry) => retry.dueTick > ticks);
      for (const retry of due) await attempt(retry.posted, retry.attempts, failures);

      await blocks.scan(await wallets.latestBlock(), async (from, to) => {
        for (const event of await wallets.walletEvents([...created.keys()], from, to)) {
          if (event.type === "created") created.set(event.wallet, { repoId: event.repoId, owner: event.owner });
          else await attempt(event, 0, failures);
        }
      });
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} Bounty note(s) not posted yet; later ticks retry them.`);
      }
    },
  };
}
