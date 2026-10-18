import { expect, test } from "vitest";
import { DEFAULTS } from "../src/config.ts";
import type { DepositedEvent, Item } from "../src/ports.ts";
import { createTriage, decisionLine, DIFF_BUDGET, ReviewFailed, type TriageDecision } from "../src/triage/triage.ts";
import { answer, FakeReviewer } from "./support/fake-reviewer.ts";
import { harness, SIGN_PAGE } from "./support/harness.ts";
import { HEAD_SHA, HELLO_WORLD, ISSUE, NEWCOMER, payload, PR, REPO } from "./support/webhooks.ts";

// Triage reads each PR or issue whose check counts a Deposit and suggests a verdict to the
// Maintainer in a note. The model is faked: no test calls the network.

const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PR_OPENED_AT = Date.parse("2019-05-15T15:20:33Z");
const ISSUE_OPENED_AT = Date.parse("2019-05-15T15:20:18Z");
const SIGN_LINK = `${SIGN_PAGE}?repo=Codertocat%2FHello-World&kind=pr&number=2`;

/** A harness whose PR #2 (or issue #1) holds Deposit 1, and a model that answers what the test says. */
function deposited(kind: "pr" | "issue" = "pr", config = "", { private: isPrivate = false } = {}) {
  const reviewer = new FakeReviewer();
  const setup = harness({ config, reviewer });
  const number = kind === "pr" ? PR : ISSUE;
  const openedAt = kind === "pr" ? PR_OPENED_AT : ISSUE_OPENED_AT;
  setup.chain.deposit({ repo: REPO, kind, number, depositor: DEPOSITOR, at: new Date(openedAt + 60_000) });
  const fields = { repo: HELLO_WORLD, number, author: NEWCOMER, createdAt: new Date(openedAt), labels: [] };
  setup.github.addItem(kind === "pr" ? { ...fields, kind, headSha: HEAD_SHA } : { ...fields, kind });
  const open = (overrides: { labels?: string[]; action?: string } = {}) =>
    setup.deliver(
      kind === "pr" ? "pull_request" : "issues",
      payload(kind === "pr" ? "pull_request" : "issues", overrides.action ?? "opened", {
        author: NEWCOMER,
        labels: overrides.labels ?? [],
        private: isPrivate,
      }),
    );
  const settled = async (overrides?: { labels?: string[]; action?: string }) => {
    const response = await open(overrides);
    await setup.triage!.idle();
    return response;
  };
  return { ...setup, reviewer, number, settled };
}

test("good-faith work gets a note suggesting acceptance, and approving refunds the Deposit now", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  reviewer.answers = [answer("accept", ["It fixes the typo it names.", "The change is one line in the README."])];

  await settled();

  expect(github.markedNotesOn(REPO, PR)).toEqual([
    [
      "<!-- bona-fide:triage serial=1 -->",
      "**Suggestion: this looks like good-faith work**",
      "",
      "An automated reviewer read this PR. This is only a suggestion: the Maintainer decides.",
      "",
      "- It fixes the typo it names.",
      "- The change is one line in the README.",
      "",
      "A Maintainer who agrees can approve the PR or add the `bona-fide:ok` label, and the Deposit is refunded in full now.",
    ].join("\n"),
  ]);
  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("Deposit received from 0x5aAe…eAed");
  expect(github.labelsOn(REPO, PR)).toEqual([]);
  expect(decisions.map((d) => d.action)).toEqual(["noted-accept"]);
});

test("likely bad faith gets a draft verdict that forfeits nothing and links the Maintainer to the sign page", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  reviewer.answers = [answer("bad-faith", ["The diff only adds an advertisement."])];

  await settled();

  expect(github.markedNotesOn(REPO, PR)).toEqual([
    [
      "<!-- bona-fide:triage serial=1 -->",
      "**Draft verdict: this may be bad faith**",
      "",
      "An automated reviewer read this PR and drafted a verdict for the Maintainer. This is only a suggestion: the Maintainer decides.",
      "Nothing has been forfeited: only the Maintainer's signature can forfeit the Deposit.",
      "",
      "- The diff only adds an advertisement.",
      "",
      `- **If the Maintainer agrees:** add the \`bona-fide:bad-faith\` label, then [sign the Forfeit](${SIGN_LINK}) with the Maintainer's wallet.`,
      "- **If not:** do nothing. The Deposit is refunded in full when the PR is merged or accepted, or at the Timeout.",
    ].join("\n"),
  ]);
  expect(github.labelsOn(REPO, PR)).toEqual([]);
  expect(github.noteOn(REPO, PR)).toBeUndefined();
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
  expect(decisions.map((d) => d.action)).toEqual(["drafted-verdict"]);
});

test("an issue's notes name the ways an issue is accepted", async () => {
  const { github, reviewer, settled } = deposited("issue");
  reviewer.answers = [answer("accept")];

  await settled();

  const [note] = github.markedNotesOn(REPO, ISSUE);
  expect(note).toContain("An automated reviewer read this issue.");
  expect(note).toContain("can add the `bona-fide:ok` label or close the issue as completed");
  expect(reviewer.requests[0]).not.toHaveProperty("diff");
  expect(reviewer.requests[0]).not.toHaveProperty("files");
});

test("an unsure model posts nothing", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  reviewer.answers = [answer("unsure", ["Hard to tell."])];

  await settled();

  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(decisions).toMatchObject([{ verdict: "unsure", action: "silent" }]);
});

test("a model that declines posts nothing", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  reviewer.answers = [
    { suggestion: null, silence: "refusal", model: "claude-opus-5", inputTokens: 900, outputTokens: 3 },
  ];

  await settled();

  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(decisions).toMatchObject([{ verdict: null, action: "silent", usage: { inputTokens: 900, outputTokens: 3 } }]);
});

test("a model that fails posts nothing and changes neither the webhook's answer nor the check", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  reviewer.answers = [new ReviewFailed("rate limited")];

  const response = await settled();

  expect(response.status).toBe(200);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(decisions).toMatchObject([{ action: "failed: rate limited", model: null, usage: null }]);
});

test("a model that throws something unexpected is logged without its message", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  reviewer.answers = [new Error("sk-ant-secret in a message")];

  await settled();

  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(decisionLine(decisions[0]!)).not.toContain("sk-ant");
  expect(decisions[0]?.action).toBe("failed: unexpected error");
});

test("the webhook doesn't wait for the model", async () => {
  const { github, reviewer, triage, deliver } = deposited();
  let answerNow = () => {};
  reviewer.gate = new Promise((resolve) => (answerNow = resolve));
  reviewer.answers = [answer("accept")];

  const response = await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(response.status).toBe(200);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  answerNow();
  await triage!.idle();
  expect(github.markedNotesOn(REPO, PR)).toHaveLength(1);
});

test("each Deposit is triaged once, however often its item is checked", async () => {
  const { github, reviewer, settled, deliver, triage } = deposited();
  reviewer.answers = [answer("accept"), answer("accept")];

  await settled();
  await settled({ action: "synchronize" });
  await Promise.all([
    deliver("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER })),
    deliver("pull_request", payload("pull_request", "reopened", { author: NEWCOMER })),
  ]);
  await triage!.idle();

  expect(reviewer.requests).toHaveLength(1);
  expect(github.markedNotesOn(REPO, PR)).toHaveLength(1);
});

test("two checks at once ask the model once", async () => {
  const { reviewer, deliver, triage } = deposited();
  reviewer.answers = [answer("accept"), answer("accept")];

  await Promise.all([
    deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER })),
    deliver("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER })),
  ]);
  await triage!.idle();

  expect(reviewer.requests).toHaveLength(1);
});

test("after a restart, the note's marker keeps the Deposit from being triaged again", async () => {
  const { github, chain, reviewer, settled } = deposited();
  reviewer.answers = [answer("accept")];
  await settled();
  const restarted = new FakeReviewer();
  const decisions: TriageDecision[] = [];
  const triage = createTriage({
    github,
    reviewer: restarted,
    signPageUrl: SIGN_PAGE,
    record: (d) => decisions.push(d),
  });
  const [event] = await chain.escrowEvents(0n, await chain.latestBlock());

  await triage.afterVerdict(
    prItem(),
    { kind: "deposited", deposit: (event as { deposit: DepositedEvent }).deposit },
    DEFAULTS,
  );
  await triage.idle();

  expect(restarted.requests).toEqual([]);
  expect(decisions.map((d) => d.action)).toEqual(["skipped: triaged before"]);
  expect(github.markedNotesOn(REPO, PR)).toHaveLength(1);
});

test("a note for an earlier Deposit doesn't stop triage of a later one", async () => {
  const { github, reviewer, triage } = deposited();
  await github.addNote(HELLO_WORLD, PR, "<!-- bona-fide:triage serial=1 -->", "An earlier note");
  reviewer.answers = [answer("accept")];
  const deposit = { depositor: DEPOSITOR, amount: 1_000_000n, txHash: HEAD_SHA, serial: 12n } as const;

  await triage!.afterVerdict(
    prItem(),
    { kind: "deposited", deposit: { ...deposit, txHash: `0x${"1".repeat(64)}` } },
    DEFAULTS,
  );
  await triage!.idle();

  expect(reviewer.requests).toHaveLength(1);
  expect(github.markedNotesOn(REPO, PR)[1]).toMatch(/^<!-- bona-fide:triage serial=12 -->\n/);
});

test.each([
  ["a Maintainer waived it", "bona-fide:waive"],
  ["a Maintainer accepted it", "bona-fide:ok"],
  ["a Maintainer marked it bad faith", "bona-fide:bad-faith"],
])("nothing is triaged once %s", async (_, label) => {
  const { github, reviewer, settled } = deposited();
  reviewer.answers = [answer("accept")];

  await settled({ labels: [label] });

  expect(reviewer.requests).toEqual([]);
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
});

test("an exempt Contributor's Deposit isn't triaged", async () => {
  const { github, reviewer, settled } = deposited();
  github.setPermission(REPO, NEWCOMER, "write");

  await settled();

  expect(reviewer.requests).toEqual([]);
});

test("a denounced Contributor's Deposit isn't triaged", async () => {
  const { github, reviewer, settled } = deposited();
  github.setFile(REPO, "VOUCHED.td", "-newcomer\n");

  await settled();

  expect(reviewer.requests).toEqual([]);
});

test("an item without a Deposit isn't triaged", async () => {
  const reviewer = new FakeReviewer();
  const { deliver, triage } = harness({ config: "", reviewer });

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await triage!.idle();

  expect(reviewer.requests).toEqual([]);
});

test.each(["off", "false"])("`triage: %s` in bona-fide.yml turns triage off for the repo", async (value) => {
  const { github, reviewer, decisions, settled } = deposited("pr", `triage: ${value}\n`);

  await settled();

  expect(reviewer.requests).toEqual([]);
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(decisions.map((d) => d.action)).toEqual(["skipped: off in bona-fide.yml"]);
});

test("a label a Maintainer adds while the model reads wins over its suggestion", async () => {
  const { github, reviewer, triage, deliver } = deposited();
  let answerNow = () => {};
  reviewer.gate = new Promise((resolve) => (answerNow = resolve));
  reviewer.answers = [answer("bad-faith")];

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await github.addLabel(HELLO_WORLD, PR, "bona-fide:ok");
  answerNow();
  await triage!.idle();

  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
});

test("the model's reasons can't ping anyone, link anywhere or carry HTML, and at most four are shown", async () => {
  const { github, reviewer, settled } = deposited();
  reviewer.answers = [
    answer("bad-faith", [
      "Ask @alice or @org/team\nabout it.",
      "See [the proof](https://evil.example/x), www.evil.example, v2_https://evil.example/a and 3www.evil.example/b",
      "An ![image](https://evil.example/i.png) and [a bracket] (kept).",
      '<img src=x onerror="alert(1)"> & more',
      "x".repeat(1_000),
      "Fifth reason.",
      "   ",
    ]),
  ];

  await settled();

  const [note] = github.markedNotesOn(REPO, PR);
  const reasons = note!.split("\n").filter((line) => line.startsWith("- ") && !line.startsWith("- **"));
  expect(reasons).toEqual([
    "- Ask @\u200balice or @\u200borg/team about it.",
    "- See the proof, (link removed) v2_(link removed) and 3(link removed)",
    "- An image and \\[a bracket\\] (kept).",
    '- &lt;img src=x onerror="alert(1)"&gt; &amp; more',
  ]);
  expect(note).not.toContain("evil.example");
});

test("a long reason is cut short", async () => {
  const { github, reviewer, settled } = deposited();
  reviewer.answers = [answer("accept", ["x".repeat(1_000)])];

  await settled();

  expect(github.markedNotesOn(REPO, PR)[0]).toContain(`\n- ${"x".repeat(299)}…\n`);
});

test("the model reads the item's text and files, and a long diff is cut with how much was left out", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  const diff = "+a line of the change\n".repeat(5_000);
  github.setContent(REPO, "pr", PR, {
    title: "Add a feature",
    body: "b".repeat(30_000),
    repoDescription: "My first repo",
    files: { listed: [{ path: "src/a.ts", additions: 5_000, deletions: 0 }], total: 120 },
    diff,
  });

  await settled();

  const request = reviewer.requests[0]!;
  expect(request).toMatchObject({
    repo: REPO,
    repoDescription: "My first repo",
    kind: "pr",
    number: PR,
    author: NEWCOMER,
    title: "Add a feature",
    files: { listed: [{ path: "src/a.ts", additions: 5_000, deletions: 0 }], leftOut: 119 },
  });
  expect(request.body).toEqual({ text: "b".repeat(20_000), leftOut: 10_000 });
  expect(request.diff!.text.length).toBeLessThanOrEqual(DIFF_BUDGET);
  expect(request.diff!.text.endsWith("\n")).toBe(true);
  expect(request.diff!.text.length + request.diff!.leftOut).toBe(diff.length);
  expect(decisions[0]?.inputs).toEqual({
    titleChars: 13,
    bodyChars: 20_000,
    bodyLeftOut: 10_000,
    files: 1,
    filesLeftOut: 119,
    diffChars: request.diff!.text.length,
    diffLeftOut: request.diff!.leftOut,
  });
});

test("a PR GitHub makes no diff for is triaged from its text and files", async () => {
  const { github, reviewer, settled } = deposited();
  github.setContent(REPO, "pr", PR, {
    title: "Huge",
    body: "",
    repoDescription: null,
    files: { listed: [], total: 3_000 },
    diff: null,
  });

  await settled();

  expect(reviewer.requests[0]).toMatchObject({ diff: null, files: { listed: [], leftOut: 3_000 } });
});

test("each decision is one JSON log line with the item, the Serial, the model's answer, the action and the tokens", async () => {
  const { reviewer, decisions, settled } = deposited();
  reviewer.answers = [answer("bad-faith", ["The diff only adds an advertisement."])];

  await settled();

  const line = decisionLine(decisions[0]!);
  expect(line).not.toContain("\n");
  expect(JSON.parse(line)).toEqual({
    event: "triage",
    repo: REPO,
    kind: "pr",
    number: PR,
    serial: "1",
    author: NEWCOMER,
    inputs: {
      titleChars: 24,
      bodyChars: 12,
      bodyLeftOut: 0,
      files: 1,
      filesLeftOut: 0,
      diffChars: 54,
      diffLeftOut: 0,
    },
    model: "claude-opus-5",
    verdict: "bad-faith",
    reasons: ["The diff only adds an advertisement."],
    action: "drafted-verdict",
    usage: { inputTokens: 1200, outputTokens: 80 },
    at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
  });
});

test("a GitHub failure during triage is logged, and the next check tries again", async () => {
  const { github, reviewer, decisions, settled } = deposited();
  reviewer.answers = [answer("accept")];
  const contentOf = github.contentOf.bind(github);
  github.contentOf = async () => {
    github.contentOf = contentOf;
    throw new Error("Server Error");
  };

  await settled();
  await settled({ action: "synchronize" });

  expect(decisions.map((d) => d.action)).toEqual(["failed: GitHub: Server Error", "noted-accept"]);
});

// The decision log keeps each decision triage made after asking the model, for anyone to check on
// the repo page.

const DEPOSIT_WITNESS = { name: "Deposit", value: `Serial 1: 1 USDC from ${DEPOSITOR}, counted by the check` };

test("a suggestion to accept is logged as decided, with the model's reasons, the facts checked and its cost", async () => {
  const { reviewer, logged, settled } = deposited();
  reviewer.answers = [answer("accept", ["It fixes the typo it names."])];

  await settled();

  expect(logged).toEqual([
    {
      id: expect.any(String),
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      repo: REPO,
      private: false,
      item: { kind: "pr", number: PR },
      serial: "1",
      type: "triage",
      inputs: {
        titleChars: 24,
        bodyChars: 12,
        bodyLeftOut: 0,
        files: 1,
        filesLeftOut: 0,
        diffChars: 54,
        diffLeftOut: 0,
      },
      suggestion: { verdict: "accept", reasons: ["It fixes the typo it names."] },
      witnesses: [
        DEPOSIT_WITNESS,
        { name: "Exemption", value: "none" },
        { name: "Labels", value: "none" },
        { name: "Triage in bona-fide.yml", value: "on" },
        { name: "Labels after the model answered", value: "none" },
      ],
      action: "noted-accept",
      txHash: null,
      outcome: "decided",
      cost: { model: "claude-opus-5", inputTokens: 1_200, outputTokens: 80, usd: 0.008 },
    },
  ]);
});

test.each([
  [
    "a draft bad-faith verdict",
    answer("bad-faith", ["Spam."]),
    "drafted-verdict",
    { verdict: "bad-faith", reasons: ["Spam."] },
  ],
  ["an unsure model", answer("unsure", ["Hard to tell."]), "silent", { verdict: "unsure", reasons: ["Hard to tell."] }],
  [
    "a model that declines",
    { suggestion: null, silence: "refusal", model: "claude-opus-5", inputTokens: 900, outputTokens: 3 },
    "silent",
    null,
  ],
] as const)("%s is logged as left to the Maintainer", async (_, review, action, suggestion) => {
  const { reviewer, logged, settled } = deposited();
  reviewer.answers = [review];

  await settled();

  expect(logged).toMatchObject([{ type: "triage", action, suggestion, outcome: "escalated", txHash: null }]);
  expect(logged[0]?.cost).toMatchObject({ model: "claude-opus-5", inputTokens: review.inputTokens });
});

test("a model that fails is logged as left to the Maintainer, with no cost and no error text", async () => {
  const { reviewer, logged, settled } = deposited();
  reviewer.answers = [new Error("sk-ant-secret in a message")];

  await settled();

  expect(logged).toMatchObject([
    { action: "failed: unexpected error", suggestion: null, outcome: "escalated", cost: null },
  ]);
  expect(JSON.stringify(logged)).not.toContain("sk-ant");
});

test("the log keeps reasons as plain text for the page, not escaped for GitHub", async () => {
  const { reviewer, logged, settled } = deposited();
  reviewer.answers = [answer("bad-faith", ["Ask @alice\nabout <b>it</b> & see https://evil.example/x"])];

  await settled();

  expect(logged[0]?.suggestion?.reasons).toEqual(["Ask @alice about <b>it</b> & see (link removed)"]);
});

test("triage that never asked the model logs no decision", async () => {
  const off = deposited("pr", "triage: off\n");
  await off.settled();
  const decided = deposited();
  await decided.settled({ labels: ["bona-fide:ok"] });

  expect(off.logged).toEqual([]);
  expect(decided.logged).toEqual([]);
});

test("a GitHub failure logs no decision; the check that tries again does", async () => {
  const { github, reviewer, logged, settled } = deposited();
  reviewer.answers = [answer("accept")];
  const contentOf = github.contentOf.bind(github);
  github.contentOf = async () => {
    github.contentOf = contentOf;
    throw new Error("Server Error");
  };

  await settled();
  await settled({ action: "synchronize" });

  expect(logged.map((d) => d.action)).toEqual(["noted-accept"]);
});

test("a label a Maintainer adds while the model reads is a witness, and the decision is theirs", async () => {
  const { github, reviewer, triage, deliver, logged } = deposited();
  let answerNow = () => {};
  reviewer.gate = new Promise((resolve) => (answerNow = resolve));
  reviewer.answers = [answer("bad-faith")];

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await github.addLabel(HELLO_WORLD, PR, "bona-fide:ok");
  answerNow();
  await triage!.idle();

  expect(logged).toMatchObject([{ action: "skipped: a Maintainer decided", outcome: "escalated" }]);
  expect(logged[0]?.witnesses).toContainEqual({ name: "Labels after the model answered", value: "bona-fide:ok" });
});

// The label can come and go, and each look after it went would pay for another answer.
test("once the model answered, a Maintainer's label that came meanwhile settles it, even after the label comes off", async () => {
  const { github, reviewer, triage, deliver, settled } = deposited();
  let answerNow = () => {};
  reviewer.gate = new Promise((resolve) => (answerNow = resolve));
  reviewer.answers = [answer("bad-faith"), answer("bad-faith")];

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  await github.addLabel(HELLO_WORLD, PR, "bona-fide:bad-faith");
  answerNow();
  await triage!.idle();
  await github.removeLabel(HELLO_WORLD, PR, "bona-fide:bad-faith");
  await settled({ action: "synchronize", labels: [] });
  await settled({ action: "synchronize", labels: [] });

  expect(reviewer.requests).toHaveLength(1);
});

test("an item in a private repo is logged as private, so it is never published", async () => {
  const { reviewer, logged, log, settled } = deposited("issue", "", { private: true });
  reviewer.answers = [answer("accept")];

  await settled();

  expect(logged).toMatchObject([{ repo: REPO, private: true, action: "noted-accept" }]);
  expect(log.latest(REPO, 50)).toEqual([]);
  expect(log.counts(REPO)).toEqual({ decided: 0, escalated: 0 });
});

test("an item from a repo GitHub didn't say is public is logged as private", async () => {
  const { reviewer, logged, deliver, triage } = deposited();
  reviewer.answers = [answer("accept")];
  const body = payload("pull_request", "opened", { author: NEWCOMER });
  delete body.repository.private;

  await deliver("pull_request", body);
  await triage!.idle();

  expect(logged).toMatchObject([{ private: true }]);
});

function prItem(): Item {
  return {
    repo: HELLO_WORLD,
    kind: "pr",
    number: PR,
    author: NEWCOMER,
    createdAt: new Date(PR_OPENED_AT),
    labels: [],
    headSha: HEAD_SHA,
  };
}
