import { ACCEPTED, BAD_FAITH } from "./labels.ts";
import type { Closing, GitHub, Item, ItemFacts, Permission, PullRequest, Repo, Witness } from "./ports.ts";

// Whether a Maintainer accepted a PR or issue: for its check, for the Keeper's early Refund, and for
// its Contributor's record. A Maintainer acts through GitHub, so the rule is who did what: someone
// who can push merged it, closed it as completed, added bona-fide:ok or approved it. The three uses
// ask that of different facts, and where they differ, each says why.

/** Write, maintain or admin access: what it takes to merge. GitHub reports maintain as write, and triage as read. */
export function canPush(permission: Permission): permission is "admin" | "write" {
  return permission === "admin" || permission === "write";
}

/**
 * Whether the item is marked bad faith. Its Deposit then waits for the Maintainer's signature or the
 * Timeout: nothing but a merge refunds it early.
 */
export function markedBadFaith(item: Pick<Item, "labels">): boolean {
  return item.labels.includes(BAD_FAITH);
}

/** Something done to a PR or issue that can accept it: how it was closed, or a label someone added. */
export type Act = Closing | { type: "labelled"; label: string; by: string | null };

/** A Maintainer's Acceptance, with the facts behind it for the decision log. */
export interface Accepted {
  witnesses: Witness[];
  /** Who approved the PR, with the access they have, when an approval accepted it. */
  approver?: string;
  access?: "admin" | "write";
}

export interface Acceptance {
  /**
   * The check's first question: the bona-fide:ok label, added by someone who can push. It counts even
   * on an item marked bad faith: the check passes, and the Keeper still holds the Deposit.
   */
  ofLabel(item: Item): Promise<Accepted | null>;
  /** The check's last question: an approving review by someone who can push. Never while marked bad faith. */
  ofApproval(pr: PullRequest): Promise<Accepted | null>;
  /** Whether what a delivery says someone did accepts the item, so the Keeper refunds its Deposit now. */
  ofAct(item: Item, act: Act): Promise<Accepted | null>;
  /** Whether a Contributor's record counts the PR or issue `number` as work someone else accepted. */
  forRecord(repo: Repo, number: number, facts: ItemFacts): Promise<boolean>;
  /**
   * Whether the last to add `label` to the item can push. Triage access is enough to add a label, so
   * the label alone isn't a Maintainer's word. Reads GitHub only when the item has the label.
   */
  maintainerAdded(item: Item, label: string): Promise<boolean>;
}

/** Where an early Refund and a Contributor's record count an act differently, on purpose. */
interface Use {
  /**
   * Whether a merge by the PR's own author counts. It refunds: only someone who can push can merge.
   * A record doesn't count it: that is work nobody else accepted.
   */
  ownMerge: boolean;
  /**
   * Whether bona-fide:bad-faith holds back a completion or the label. It holds a Refund back, since
   * closing as completed is GitHub's default, but never a merge. A record doesn't look: whether the
   * Deposit was refunded or forfeited, it reads from the escrow.
   */
  heldInBadFaith: boolean;
}

const REFUND: Use = { ownMerge: true, heldInBadFaith: true };
const RECORD: Use = { ownMerge: false, heldInBadFaith: false };

export function createAcceptance(github: Pick<GitHub, "permissionOf" | "labeledBy" | "approvers">): Acceptance {
  async function byMaintainer(repo: Repo, login: string | null): Promise<boolean> {
    return login !== null && canPush(await github.permissionOf(repo, login));
  }

  // Closing an issue counts only when someone else did it: anyone can close their own issue. A PR
  // closed unmerged was never accepted. Permission is read last, and only when the rest holds.
  async function accepts(repo: Repo, item: Pick<Item, "author" | "labels">, act: Act, use: Use): Promise<boolean> {
    if (act.type === "merged") return use.ownMerge || act.by === null || !sameLogin(act.by, item.author);
    if (use.heldInBadFaith && markedBadFaith(item)) return false;
    if (act.type === "closed") {
      if (act.reason !== "completed" || act.by === null || sameLogin(act.by, item.author)) return false;
    } else if (act.label !== ACCEPTED) return false;
    return byMaintainer(repo, act.by);
  }

  async function maintainerAdded(item: Item, label: string): Promise<boolean> {
    return (
      item.labels.includes(label) && byMaintainer(item.repo, await github.labeledBy(item.repo, item.number, label))
    );
  }

  return {
    async ofLabel(item) {
      if (!(await maintainerAdded(item, ACCEPTED))) return null;
      return { witnesses: [{ name: "Label", value: ACCEPTED }, badFaithWitness(item)] };
    },

    async ofApproval(pr) {
      if (markedBadFaith(pr)) return null;
      for (const login of await github.approvers(pr.repo, pr.number)) {
        const access = await github.permissionOf(pr.repo, login);
        if (!canPush(access)) continue;
        const approved = { name: "Approved by", value: `@${login}, with ${access} access` };
        return { approver: login, access, witnesses: [approved, badFaithWitness(pr)] };
      }
      return null;
    },

    async ofAct(item, act) {
      return (await accepts(item.repo, item, act, REFUND)) ? { witnesses: witnessesOf(act) } : null;
    },

    // Access is read now, not as it was then. Work in a repo its author can push to, such as an org of
    // their own, they could accept themselves. An approval alone doesn't count: the record reads how
    // the work was closed, and the label.
    async forRecord(repo, number, facts) {
      const labelled = async () => {
        const by = await github.labeledBy(repo, number, ACCEPTED);
        return accepts(repo, facts, { type: "labelled", label: ACCEPTED, by }, RECORD);
      };
      const accepted =
        (facts.closing !== null && (await accepts(repo, facts, facts.closing, RECORD))) ||
        (facts.labels.includes(ACCEPTED) && (await labelled()));
      return accepted && !canPush(await github.permissionOf(repo, facts.author));
    },

    maintainerAdded,
  };
}

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function badFaithWitness(item: Pick<Item, "labels">): Witness {
  return { name: "Marked bad faith", value: markedBadFaith(item) ? "yes" : "no" };
}

function witnessesOf(act: Act): Witness[] {
  const by = act.by === null ? "unknown" : `@${act.by}`;
  if (act.type === "merged") {
    return [
      { name: "Merged", value: "yes" },
      { name: "Merged by", value: by },
    ];
  }
  if (act.type === "closed") {
    return [
      { name: "Closed as", value: "completed" },
      { name: "Closed by", value: `${by}, not the author` },
    ];
  }
  return [
    { name: "Label", value: ACCEPTED },
    { name: "Labelled by", value: by },
  ];
}
