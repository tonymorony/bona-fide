import { expect, test } from "vitest";
import { bountyMarkers, createBounties } from "../src/bounties/bounties.ts";
import { createDecisionLog } from "../src/decisions/log.ts";
import type { CommitCheck, PullRequestFacts } from "../src/ports.ts";
import { ReviewFailed } from "../src/triage/triage.ts";
import {
  BOUNTY_ISSUE,
  BOUNTY_PAGE,
  BOUNTY_PR,
  bountyHarness,
  closedIssue,
  closedPr,
  mergedPr,
  MERGED_AT,
  OWNER,
  PAYEE,
  prComment,
  TEN_USDC,
  text,
  type BountyHarnessOptions,
} from "./support/bounties.ts";
import { resolution } from "./support/fake-resolver.ts";
import { KEEPER } from "./support/fake-wallets.ts";
import { NEWCOMER, REPO } from "./support/webhooks.ts";

// Bounties: a merged PR that closes an issue with a Bounty is paid by the Keeper only when every
// witness holds and the model says it resolves the issue. The model can hold a Payout back, never
// make one alone. The wallet, GitHub and the model are faked: no test calls the network.

const SIGN_LINK = `${BOUNTY_PAGE}?repo=Codertocat%2FHello-World&issue=42&payee=${PAYEE}`;
const TX_LINK = `https://explorer.arc.io/tx/0x${"0".repeat(63)}1`;

/** A harness whose model says the PR resolves the issue. */
function resolving(options: BountyHarnessOptions = {}) {
  const setup = bountyHarness(options);
  setup.resolver.answers = [resolution("resolves")];
  return setup;
}

function heldNote(setup: ReturnType<typeof bountyHarness>, pr = BOUNTY_PR): string | undefined {
  const marker = bountyMarkers(BOUNTY_ISSUE, setup.serial).held;
  return setup.github.markedNotesOn(REPO, pr).find((note) => note.startsWith(marker));
}

test("a merged PR that closes an issue with a Bounty pays its author's wallet, and both get a note that links the Payout", async () => {
  const setup = resolving();

  const response = await setup.merge();

  expect(response.status).toBe(200);
  expect(setup.wallets.sent).toEqual([
    { method: "keeper", wallet: setup.wallet, issue: BOUNTY_ISSUE, payee: PAYEE, txHash: expect.any(String) },
  ]);
  expect(setup.wallets.bountyOf(setup.wallet, BOUNTY_ISSUE)?.status).toBe("paid");
  const marker = bountyMarkers(BOUNTY_ISSUE, setup.serial).paid;
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toEqual([
    [
      marker,
      "**Bounty paid: 10 USDC**",
      "",
      `The Bounty on #42, **10 USDC**, was paid in full to ${PAYEE}. The Keeper paid it: the PR was merged and closes the issue, its checks passed, it was within the Maintainer's limits, and an automated reviewer agreed it resolves the issue.`,
      "",
      `[View the Payout on Arc](${TX_LINK})`,
    ].join("\n"),
  ]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_ISSUE)).toEqual([
    expect.stringContaining(`This issue's Bounty, **10 USDC**, was paid in full for #7 to ${PAYEE}.`),
  ]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_ISSUE)[0]).toContain(`(${TX_LINK})`);
});

test("the model reads the issue and the PR, cut to triage's budgets, and nothing of the witnesses", async () => {
  const setup = resolving();
  setup.github.setContent(REPO, "issue", BOUNTY_ISSUE, {
    title: "Support dark mode",
    body: "x".repeat(25_000),
    repoDescription: "My first repo",
  });

  await setup.merge();

  expect(setup.resolver.requests).toEqual([
    {
      repo: REPO,
      repoDescription: "My first repo",
      issue: { number: BOUNTY_ISSUE, title: "Support dark mode", body: { text: "x".repeat(20_000), leftOut: 5_000 } },
      pr: {
        number: BOUNTY_PR,
        author: NEWCOMER,
        title: "Fix a typo in the README",
        body: { text: "It said teh.", leftOut: 0 },
        files: { listed: [{ path: "README.md", additions: 1, deletions: 1 }], leftOut: 0 },
        diff: { text: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-teh\n+the\n", leftOut: 0 },
      },
    },
  ]);
});

test("a Payout is recorded as a pay decision with each witness, the model's suggestion, the transaction and the cost", async () => {
  const setup = resolving();

  await setup.merge();

  expect(setup.logged).toEqual([
    {
      id: expect.any(String),
      at: "2026-09-30T12:05:00.000Z",
      repo: REPO,
      private: false,
      item: { kind: "issue", number: BOUNTY_ISSUE },
      serial: "1",
      type: "pay",
      inputs: {
        source: "webhook pull_request closed",
        pr: BOUNTY_PR,
        method: "keeper",
        issueTitleChars: 24,
        issueBodyChars: 12,
        issueBodyLeftOut: 0,
        titleChars: 24,
        bodyChars: 12,
        bodyLeftOut: 0,
        files: 1,
        filesLeftOut: 0,
        diffChars: 54,
        diffLeftOut: 0,
      },
      suggestion: { verdict: "resolves", reasons: ["The PR makes the change the issue asks for."] },
      witnesses: [
        { name: "Merged", value: "yes, by @maintainer" },
        { name: "Repo created", value: "before its Binding took effect" },
        { name: "Closes the issue", value: "yes, #42" },
        { name: "First merged PR that closes it", value: "yes" },
        { name: "Closed by its merge", value: "yes" },
        { name: "Checks on 7777777", value: "all 1 green" },
        { name: "Payee wallet", value: `${PAYEE}, from @newcomer's PR description` },
        { name: "Bounty", value: "Serial 1: 10 USDC, open" },
        { name: "Keeper payouts", value: "on" },
        { name: "Per-payout limit", value: "100 USDC" },
        { name: "Keeper allowance this period", value: "100 USDC left" },
        { name: "Bounties in bona-fide.yml", value: "on" },
      ],
      action: "paid",
      txHash: `0x${"0".repeat(63)}1`,
      outcome: "decided",
      cost: { model: "claude-opus-5", inputTokens: 2400, outputTokens: 90, usd: 0.01425 },
    },
  ]);
});

const FAILING: CommitCheck[] = [
  { name: "test", state: "success" },
  { name: "lint", state: "failure" },
];
const PENDING: CommitCheck[] = [{ name: "test", state: "pending" }];

test.each([
  [
    "a check failed",
    {},
    () => ({ checks: FAILING }),
    "its checks didn't all pass: lint didn't",
    "held: checks not green",
    { name: "Checks on 7777777", value: "1 of 2 not green: lint" },
  ],
  [
    "a check is still running",
    {},
    () => ({ checks: PENDING }),
    "its checks hadn't finished: test still running",
    "held: checks not green",
    { name: "Checks on 7777777", value: "1 of 1 still running: test" },
  ],
  [
    "the Keeper's payouts are off",
    { limits: { keeperEnabled: false } },
    () => ({}),
    "the Maintainer turned the Keeper's payouts off for this wallet",
    "held: Keeper payouts off",
    { name: "Keeper payouts", value: "off" },
  ],
  [
    "the Bounty is above the per-payout limit",
    { limits: { perPayoutLimit: 5_000_000n } },
    () => ({}),
    "10 USDC is above the wallet's per-payout limit of 5 USDC",
    "held: above the per-payout limit",
    { name: "Per-payout limit", value: "5 USDC" },
  ],
  [
    "the Keeper's allowance for the period is spent",
    { limits: { keeperAllowance: 9_999_999n } },
    () => ({}),
    "the Keeper has only 9.999999 USDC left to pay in this period",
    "held: above the period limit",
    { name: "Keeper allowance this period", value: "9.999999 USDC left" },
  ],
] as [
  string,
  BountyHarnessOptions,
  () => { checks?: CommitCheck[] },
  string,
  string,
  { name: string; value: string },
][])(
  "when %s, the Bounty waits for the Maintainer even though the model would say it resolves",
  async (_, options, more, why, action, witness) => {
    const setup = resolving(options);

    await setup.merge(mergedPr(), more().checks);

    expect(setup.wallets.sent).toEqual([]);
    expect(setup.resolver.requests).toEqual([]);
    expect(heldNote(setup)).toBe(
      [
        bountyMarkers(BOUNTY_ISSUE, setup.serial).held,
        "**Bounty waiting for the Maintainer: 10 USDC**",
        "",
        `This PR closed #42, which has a Bounty of **10 USDC**. The Keeper won't pay it on its own: ${why}.`,
        "",
        `- **To pay it:** the Maintainer [signs the Payout](${SIGN_LINK}) with ${OWNER}.`,
        "- **If not:** nothing moves. The Bounty stays reserved until the Maintainer pays or cancels it.",
      ].join("\n"),
    );
    expect(setup.logged).toEqual([
      expect.objectContaining({ type: "hold", action, outcome: "escalated", txHash: null, suggestion: null }),
    ]);
    expect(setup.logged[0]?.witnesses).toContainEqual(witness);
  },
);

test("a later merged PR that closes the same issue waits for the Maintainer: only the first merged is paid", async () => {
  const setup = resolving();
  setup.addPr(mergedPr({ number: 5, author: "early", mergedAt: new Date("2026-09-29T00:00:00Z"), body: text("") }));

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(heldNote(setup)).toContain(
    "The Keeper won't pay it on its own: #5 was merged first and also closes the issue.",
  );
  expect(setup.logged[0]).toMatchObject({ type: "hold", action: "held: merged after another" });
  expect(setup.logged[0]?.witnesses).toContainEqual({
    name: "First merged PR that closes it",
    value: "no: #5 was merged first",
  });
});

// GitHub closes a linked issue a moment after the merge, so the merge's delivery can find it open.
test("a merge that finds the issue still open waits, and the issue's close pays", async () => {
  const setup = resolving();
  setup.github.setClosing(REPO, BOUNTY_ISSUE, { open: true, closedBy: null });

  await setup.merge();
  const waited = { sent: [...setup.wallets.sent], asked: setup.resolver.requests.length, logged: setup.logged.length };
  setup.github.setClosing(REPO, BOUNTY_ISSUE, { open: false, closedBy: BOUNTY_PR });
  await setup.deliver("issues", closedIssue());

  expect(waited).toEqual({ sent: [], asked: 0, logged: 0 });
  expect(setup.wallets.sent).toHaveLength(1);
});

// The links a PR shows can be added after its merge, as by its author editing its description. The
// issue's closer is what the merge did.
test("a merged PR linked to an issue its merge left open isn't paid, whatever it says now", async () => {
  const setup = resolving();
  const pr = setup.addPr(mergedPr());
  setup.github.setClosing(REPO, BOUNTY_ISSUE, { open: true, closedBy: null });

  await setup.deliver("pull_request", closedPr(pr));
  await setup.deliver("issue_comment", prComment(pr, `Bounty wallet: ${PAYEE}`));

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.resolver.requests).toEqual([]);
});

test.each([
  ["by hand", null, "not by a merged PR"],
  ["by another PR", 5, "by #5"],
])("an issue closed %s isn't paid for this PR by the Keeper", async (_how, closedBy, value) => {
  const setup = resolving();
  setup.github.setClosing(REPO, BOUNTY_ISSUE, { open: false, closedBy });

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(heldNote(setup)).toContain("The Keeper won't pay it on its own: the issue wasn't closed by this PR's merge.");
  expect(setup.logged[0]).toMatchObject({ type: "hold", action: "held: not closed by its merge" });
  expect(setup.logged[0]?.witnesses).toContainEqual({ name: "Closed by its merge", value: `no: closed ${value}` });
});

test("an issue with more linked PRs than the App reads waits for the Maintainer", async () => {
  const setup = resolving();
  setup.github.truncateClosing(REPO, BOUNTY_ISSUE);

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.logged[0]).toMatchObject({ type: "hold", action: "held: too many linked PRs" });
});

// A rename or a deletion frees owner/name, the repo's id, for anyone to take, along with its
// Binding and Bounty wallet.
test("a repo created after its Binding took effect isn't paid from the Bounty wallet by the Keeper", async () => {
  const setup = resolving();
  setup.github.setRepoCreatedAt(REPO, new Date("2026-09-01T00:00:00Z"));

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.logged[0]).toMatchObject({ type: "hold", action: "held: repo newer than its Binding" });
  expect(setup.logged[0]?.witnesses).toContainEqual({ name: "Repo created", value: "after its Binding took effect" });
});

test("a PR GitHub doesn't link as closing the issue isn't paid, even when the issue lists it", async () => {
  const setup = resolving();
  const pr = setup.addPr(mergedPr({ closes: [] }));
  setup.github.linkClosing(REPO, BOUNTY_ISSUE, { number: pr.number, mergedAt: MERGED_AT });

  await setup.deliver("issues", closedIssue());

  expect(setup.wallets.sent).toEqual([]);
  expect(heldNote(setup)).toContain("GitHub doesn't link this PR as closing the issue.");
  expect(setup.logged[0]).toMatchObject({ type: "hold", action: "held: not linked" });
});

test.each([
  [
    "partial",
    resolution("partial"),
    "an automated reviewer thinks it only partly resolves the issue",
    "held: model said partial",
  ],
  [
    "unrelated",
    resolution("unrelated"),
    "an automated reviewer thinks it doesn't resolve the issue",
    "held: model said unrelated",
  ],
  [
    "no suggestion",
    { suggestion: null, silence: "refusal", model: "claude-opus-5", inputTokens: 900, outputTokens: 5 },
    "the automated reviewer gave no answer",
    "silent",
  ],
  [
    "resolves with no reasons",
    resolution("resolves", [" "]),
    "the automated reviewer gave no reasons for its answer",
    "silent",
  ],
  [
    "a failure",
    new ReviewFailed("rate limited"),
    "the automated reviewer couldn't be asked whether the PR resolves the issue",
    "failed: rate limited",
  ],
] as const)("a model that answers %s holds the Bounty for the Maintainer", async (_, answer, why, action) => {
  const setup = bountyHarness();
  setup.resolver.answers = [answer];

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(heldNote(setup)).toContain(`The Keeper won't pay it on its own: ${why}.`);
  expect(heldNote(setup)).toContain(`[signs the Payout](${SIGN_LINK})`);
  expect(setup.logged).toEqual([expect.objectContaining({ type: "hold", action, outcome: "escalated" })]);
});

test("the model's reasons in a held note are made plain and safe, as triage's are", async () => {
  const setup = bountyHarness();
  setup.resolver.answers = [
    resolution("partial", ["It skips the [docs](https://evil.example), says @octocat.", "<b>Two</b>", "3", "4"]),
  ];

  await setup.merge();

  const note = heldNote(setup)!;
  expect(note).toContain(
    "An automated reviewer read the issue and this PR. This is only a suggestion: the Maintainer decides.\n\n" +
      "- It skips the docs, says @​octocat.\n- &lt;b&gt;Two&lt;/b&gt;\n- 3\n\n",
  );
  expect(setup.logged[0]?.suggestion).toEqual({
    verdict: "partial",
    reasons: ["It skips the docs, says @octocat.", "<b>Two</b>", "3"],
  });
});

test("without a model, every Bounty waits for the Maintainer", async () => {
  const setup = bountyHarness({ resolver: null });

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(heldNote(setup)).toContain(
    "The Keeper won't pay it on its own: no automated reviewer is set up to check that the PR resolves the issue.",
  );
  expect(setup.logged).toEqual([expect.objectContaining({ type: "hold", action: "held: no model", cost: null })]);
});

test("a held Bounty stays with the Maintainer: a redelivery asks the model again for nothing", async () => {
  const setup = bountyHarness();
  setup.resolver.answers = [resolution("partial"), resolution("resolves")];
  await setup.merge();

  await setup.deliver("pull_request", closedPr(mergedPr()));
  await setup.deliver("issue_comment", prComment(mergedPr(), `Bounty wallet: ${PAYEE}`));

  expect(setup.resolver.requests).toHaveLength(1);
  expect(setup.wallets.sent).toEqual([]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toHaveLength(1);
  expect(setup.logged).toHaveLength(1);
});

// The note is a comment, which a repo admin can delete, and each answer is paid for.
test("a held Bounty stays with the Maintainer after its note is deleted: the model isn't asked again", async () => {
  const setup = bountyHarness();
  setup.resolver.answers = [resolution("partial"), resolution("partial")];
  const pr = setup.addPr(mergedPr());

  await setup.deliver("pull_request", closedPr(pr));
  setup.github.deleteMarkedNotes(REPO, BOUNTY_PR);
  await setup.deliver("pull_request", closedPr(pr));

  expect(setup.resolver.requests).toHaveLength(1);
  expect(setup.wallets.sent).toEqual([]);
});

test("without a named wallet, the author is asked for one, and the Payout runs once they name it in a comment", async () => {
  const setup = resolving();
  const pr = mergedPr({ body: text("Fixes #42.") });

  await setup.merge(pr);

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.resolver.requests).toEqual([]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toEqual([
    [
      bountyMarkers(BOUNTY_ISSUE, setup.serial).payee,
      "**Bounty: which wallet should it go to?**",
      "",
      "This PR closed #42, which has a Bounty of **10 USDC**. To receive it, @newcomer adds a line like this to the PR description or to a comment of their own:",
      "",
      "```",
      "Bounty wallet: 0xYourWalletAddress",
      "```",
      "",
      "Only @newcomer's own words count, and the latest line wins. The Bounty is checked again as soon as they add it.",
    ].join("\n"),
  ]);
  expect(setup.logged).toEqual([expect.objectContaining({ type: "hold", action: "held: payee wallet needed" })]);
  expect(setup.logged[0]?.witnesses).toContainEqual({ name: "Payee wallet", value: "none named" });

  const comment = `Thanks! Bounty wallet: no\nBounty wallet: ${PAYEE}`;
  pr.comments.push(text(comment, NEWCOMER, new Date("2026-09-30T14:00:00Z")));
  setup.addPr(pr);
  await setup.deliver("issue_comment", prComment(pr, comment));

  expect(setup.wallets.sent).toEqual([expect.objectContaining({ payee: PAYEE })]);
  expect(setup.logged.map((d) => d.action)).toEqual(["held: payee wallet needed", "paid"]);
  expect(setup.logged[1]?.witnesses).toContainEqual({
    name: "Payee wallet",
    value: `${PAYEE}, from a comment of @newcomer`,
  });
});

test("someone else's comment naming a wallet does nothing", async () => {
  const setup = resolving();
  const pr = mergedPr({ body: text("Fixes #42.") });
  await setup.merge(pr);
  pr.comments.push(text(`Bounty wallet: ${OWNER}`, "maintainer", new Date("2026-09-30T14:00:00Z")));
  setup.addPr(pr);

  await setup.deliver("issue_comment", prComment(pr, `Bounty wallet: ${OWNER}`, "maintainer"));

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toHaveLength(1);
});

test.each([
  [
    "isn't a valid address",
    `Bounty wallet: ${PAYEE.replace("a", "A")}`,
    `The wallet named so far, \`${PAYEE.replace("a", "A")}\`, isn't a valid address: a mixed-case address must match its checksum.`,
  ],
  [
    "is the Keeper's",
    `Bounty wallet: ${KEEPER}`,
    `The wallet named so far, ${KEEPER}, can't be paid: it is the Keeper's address.`,
  ],
])("a named wallet that %s isn't paid, and the note says why", async (_, line, problem) => {
  const setup = resolving();

  await setup.merge(mergedPr({ body: text(line) }));

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)[0]).toContain(`\n\n${problem}\n\n`);
});

test("an issue closed by a merge whose PR delivery was missed pays the first merged PR that closes it", async () => {
  const setup = resolving();
  setup.addPr(mergedPr());
  setup.addPr(mergedPr({ number: 9, mergedAt: new Date("2026-09-30T13:00:00Z"), headSha: "9".repeat(40) }));

  await setup.deliver("issues", closedIssue());

  expect(setup.wallets.sent).toEqual([expect.objectContaining({ payee: PAYEE })]);
  expect(setup.logged[0]).toMatchObject({ type: "pay", inputs: expect.objectContaining({ pr: BOUNTY_PR }) });
});

test("a redelivered merge never pays twice, and posts each note once", async () => {
  const setup = resolving();
  await setup.merge();
  setup.resolver.answers = [resolution("resolves")];

  await setup.deliver("pull_request", closedPr(mergedPr()));
  await setup.deliver("issues", closedIssue());

  expect(setup.wallets.sent).toHaveLength(1);
  expect(setup.resolver.requests).toHaveLength(1);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toHaveLength(1);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_ISSUE)).toHaveLength(1);
  expect(setup.logged).toHaveLength(1);
});

test("the merge's pull_request and issues deliveries at once pay once", async () => {
  const setup = resolving();
  setup.addPr(mergedPr());

  await Promise.all([setup.deliver("pull_request", closedPr(mergedPr())), setup.deliver("issues", closedIssue())]);

  expect(setup.wallets.sent).toHaveLength(1);
  expect(setup.resolver.requests).toHaveLength(1);
});

test("after a restart, a Bounty paid on-chain isn't paid again, and its missing notes link the Payout", async () => {
  const setup = resolving();
  setup.addPr(mergedPr());
  // The Keeper paid, then the App stopped before its notes.
  const txHash = setup.wallets.ownerPay(setup.wallet, BOUNTY_ISSUE, PAYEE);
  const restarted = createBounties({
    github: setup.github,
    chain: setup.chain,
    wallets: setup.wallets,
    resolver: setup.resolver,
    bountyPageUrl: BOUNTY_PAGE,
    decisions: createDecisionLog(),
  });

  await restarted.onWebhook("issues", closedIssue());
  await restarted.idle();

  expect(setup.wallets.sent).toHaveLength(1);
  expect(setup.resolver.requests).toEqual([]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_ISSUE)).toEqual([
    expect.stringContaining(`This issue's Bounty, **10 USDC**, was paid in full for #7 to ${PAYEE}.\n`),
  ]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_ISSUE)[0]).toContain(`/tx/${txHash})`);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toHaveLength(1);
});

test("a Bounty paid while the model read is not paid again", async () => {
  const setup = resolving();
  setup.wallets.beforeKeeperPay = () => setup.wallets.ownerPay(setup.wallet, BOUNTY_ISSUE, OWNER);

  await setup.merge();

  expect(setup.wallets.sent).toEqual([expect.objectContaining({ payee: OWNER, method: "signature" })]);
  expect(setup.logged).toEqual([]);
  // It went to the Maintainer's own wallet, not the one the PR named: only the issue says so.
  expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toEqual([]);
  expect(setup.github.markedNotesOn(REPO, BOUNTY_ISSUE)).toEqual([
    expect.stringContaining(`This issue's Bounty, **10 USDC**, was paid in full to ${OWNER}.\n`),
  ]);
});

test("a wallet that refuses the Keeper's payout at the last moment leaves the Bounty to the Maintainer", async () => {
  const setup = resolving();
  setup.wallets.beforeKeeperPay = () => setup.wallets.setLimits(setup.wallet, { keeperAllowance: 0n });

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(heldNote(setup)).toContain("the Bounty wallet refused the Keeper's payout (AbovePeriodLimit).");
  expect(setup.logged).toEqual([
    expect.objectContaining({ type: "hold", action: "held: wallet refused (AbovePeriodLimit)" }),
  ]);
});

test.each([
  ["bounties: off in bona-fide.yml", { config: "bounties: off\n" }, () => {}],
  ["no Bounty on the issue", { amount: null }, () => {}],
  [
    "a cancelled Bounty",
    {},
    (setup: ReturnType<typeof bountyHarness>) => setup.wallets.cancel(setup.wallet, BOUNTY_ISSUE),
  ],
  ["a repo without bona-fide.yml", {}, (setup: ReturnType<typeof bountyHarness>) => setup.github.addRepo(REPO)],
] as [string, BountyHarnessOptions, (setup: ReturnType<typeof bountyHarness>) => void][])(
  "%s pays nothing and posts nothing",
  async (_, options, arrange) => {
    const setup = resolving(options);
    arrange(setup);

    await setup.merge();

    expect(setup.wallets.sent).toEqual([]);
    expect(setup.resolver.requests).toEqual([]);
    expect(setup.github.markedNotesOn(REPO, BOUNTY_PR)).toEqual([]);
    expect(setup.logged).toEqual([]);
  },
);

test("a repo whose Maintainer has no Bounty wallet pays nothing", async () => {
  const setup = resolving();
  setup.chain.bind(REPO, { maintainer: "0x0000000000000000000000000000000000000Abc" });

  await setup.merge();

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.logged).toEqual([]);
});

test("a PR closed without merging pays nothing", async () => {
  const setup = resolving();
  const pr: PullRequestFacts = { ...mergedPr(), merged: false, mergedAt: null };
  setup.addPr(pr);

  await setup.deliver("pull_request", closedPr(pr, false));

  expect(setup.wallets.sent).toEqual([]);
  expect(setup.resolver.requests).toEqual([]);
});

test("a private repo's Payout is recorded as private", async () => {
  const setup = resolving({ private: true });

  await setup.merge();

  expect(setup.logged).toEqual([expect.objectContaining({ type: "pay", private: true })]);
  expect(setup.log.latest(REPO, 10)).toEqual([]);
});

test("a Bounty exactly at the per-payout limit and the period's allowance is paid", async () => {
  const setup = resolving({ amount: TEN_USDC, limits: { perPayoutLimit: TEN_USDC, keeperAllowance: TEN_USDC } });

  await setup.merge();

  expect(setup.wallets.sent).toHaveLength(1);
  expect(setup.logged[0]?.witnesses).toContainEqual({ name: "Per-payout limit", value: "10 USDC" });
});
