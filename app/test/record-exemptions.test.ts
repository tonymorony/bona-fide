import type { Kind } from "@bona-fide/sdk";
import { expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { openDecisionFile } from "../src/decisions/file.ts";
import type { Advice, AdviceRequest, DecisionLog, GitHubProfile } from "../src/ports.ts";
import { ASK_AGAIN_MS, createRecordExemptions, FLAG_MARKER } from "../src/records/exemption.ts";
import { createRecordIndex } from "../src/records/records.ts";
import { ModelFailed } from "../src/model/model.ts";
import { createWebhookHandler } from "../src/webhook.ts";
import { advice, FakeModel } from "./support/fake-model.ts";
import { DEPOSIT_PAGE, harness, scratchDecisionsPath, SETUP_PAGE } from "./support/harness.ts";
import {
  HEAD_SHA,
  HELLO_WORLD,
  ISSUE,
  NEWCOMER,
  payload,
  PR,
  REPO,
  rerun,
  SECRET,
  signed,
} from "./support/webhooks.ts";

// A Record Exemption: a Contributor whose Bona Fide record is good enough needs no Deposit. The
// App's own witnesses must hold, and the model must agree; the model can hold a waiver back but
// never grant one alone. The model is faked: no test calls the network.

const DEPOSITOR = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const PR_OPENED_AT = new Date("2019-05-15T15:20:33Z");
const ISSUE_OPENED_AT = new Date("2019-05-15T15:20:18Z");
const NOW = new Date("2026-09-30T12:00:00Z");
const PROFILE: GitHubProfile = {
  createdAt: new Date("2021-09-30T12:00:00Z"),
  publicRepos: 12,
  followers: 30,
  mergedElsewhere: 0,
};

type End = "accepted" | "refunded" | "forfeited";

interface Options {
  now?: () => Date;
  /** The text of .github/bona-fide.yml. */
  config?: string;
  /** Deposits of the newcomer's in other repos, each ended as told. By default four accepted in three repos. */
  history?: [repo: string, end: End][];
  /** Repos in `history` that are private. */
  privateRepos?: string[];
  profile?: Partial<GitHubProfile> | null;
  /** Without a model, as on a host without ANTHROPIC_API_KEY. */
  noModel?: boolean;
  log?: DecisionLog;
}

const GOOD: [string, End][] = [
  ["acme/widgets", "accepted"],
  ["acme/widgets", "accepted"],
  ["acme/gadgets", "accepted"],
  ["octo/tools", "accepted"],
];

/** A harness whose newcomer has a Bona Fide record elsewhere, with PR #2 and issue #1 of theirs here. */
async function recorded({
  config = "",
  history = GOOD,
  privateRepos = [],
  profile = {},
  noModel,
  log,
  now = () => NOW,
}: Options = {}) {
  const model = new FakeModel<AdviceRequest>();
  const setup = harness({ config, recordModel: noModel ? undefined : model, now, log });
  const { github, chain, records } = setup;
  let number = 100;
  for (const [repo, end] of history) {
    if (!github.hasRepo(repo)) github.addRepo(repo, 1, privateRepos.includes(repo));
    past(repo, end, number++);
  }
  if (profile) github.setProfile(NEWCOMER, { ...PROFILE, ...profile });
  const pr = { repo: HELLO_WORLD, number: PR, author: NEWCOMER, createdAt: PR_OPENED_AT, labels: [] };
  github.addItem({ ...pr, kind: "pr", headSha: HEAD_SHA });
  github.addItem({ ...pr, number: ISSUE, createdAt: ISSUE_OPENED_AT, kind: "issue" });
  await catchUp();

  /** A Deposit of the newcomer's on an item of theirs in `repo`, ended as told. */
  function past(repo: string, end: End, n: number, kind: Kind = "pr"): void {
    const [owner = "", name = ""] = repo.split("/");
    const fields = {
      repo: { owner, name, installationId: 1, private: privateRepos.includes(repo) },
      number: n,
      author: NEWCOMER,
      createdAt: new Date(0),
      labels: [],
    };
    github.addItem(kind === "pr" ? { ...fields, kind, headSha: "abc" } : { ...fields, kind });
    const event = chain.deposit({ repo, kind, number: n, depositor: DEPOSITOR, at: new Date(60_000) });
    if (end === "accepted") github.accept(repo, kind, n);
    if (end === "forfeited") chain.forfeit(event.key);
    else chain.refund(event.key);
  }

  async function catchUp(): Promise<void> {
    for (let i = 0; i < 10; i++) await records.tick();
  }

  async function open(kind: "pr" | "issue" = "pr", action = "opened", labels: string[] = []) {
    const event = kind === "pr" ? "pull_request" : "issues";
    const response = await setup.deliver(event, payload(event, action, { author: NEWCOMER, labels }));
    await setup.recordExemptions?.idle();
    return response;
  }

  return { ...setup, model, past, catchUp, open };
}

test("a Contributor with a good record passes once the model agrees, and the check names the counts", async () => {
  const { github, model, deliver, recordExemptions } = await recorded();
  let answerNow = () => {};
  model.gate = new Promise((resolve) => (answerNow = resolve));
  model.answers = [advice("waive")];

  const response = await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  expect(response.status).toBe(200);
  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("Deposit needed: 1 USDC, refundable");
  answerNow();
  await recordExemptions!.idle();
  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "success",
    title: "No Deposit needed: 4 Refunds across 3 repos",
    summary: [
      "@newcomer's Bona Fide record: 4 Deposits refunded on accepted work across 3 public repos.",
      "",
      "An automated reviewer read the record and agreed, so this PR needs no Deposit. Forfeits in 2 repos end this. Maintainers can turn it off with `record_exemption: off` in .github/bona-fide.yml.",
    ].join("\n"),
  });
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
});

test("an issue's comment says no Deposit is needed, and its label comes off", async () => {
  const { github, model, open } = await recorded({ history: GOOD.slice(0, 1), config: "record_threshold: 1\n" });
  model.answers = [advice("waive")];

  await open("issue");

  expect(github.commentsOn(REPO, ISSUE)).toEqual([
    expect.stringMatching(
      /^\*\*No Deposit needed: 1 Refund across 1 repo\*\*\n\n@newcomer's Bona Fide record: 1 Deposit refunded/,
    ),
  ]);
  expect(github.labelsOn(REPO, ISSUE)).toEqual([]);
});

test("the model reads the record and profile as numbers, never the threshold or the witnesses", async () => {
  const { model, open } = await recorded({
    history: [...GOOD, ["acme/widgets", "refunded"]],
    profile: { mergedElsewhere: 57 },
  });

  await open();

  expect(model.requests).toEqual([
    {
      repo: REPO,
      kind: "pr",
      number: PR,
      login: NEWCOMER,
      record: { refunds: 4, repos: 3, otherRefunds: 1, forfeits: 0, active: 0 },
      profile: { accountAgeDays: 1826, publicRepos: 12, followers: 30, mergedElsewhere: 57 },
    },
  ]);
});

test.each([
  ["the score is below the threshold", { history: GOOD.slice(0, 2) }],
  [
    "Deposits were forfeited in two repos, even a private one",
    {
      history: [...GOOD, ["acme/secret", "forfeited"], ["octo/spam", "forfeited"]],
      privateRepos: ["acme/secret"],
    },
  ],
  ["the threshold is higher than the score", { config: "record_threshold: 5\n", profile: { mergedElsewhere: 0 } }],
] as [string, Options][])("no waiver and no model when %s, even if the model would say waive", async (_, options) => {
  const { github, model, logged, open } = await recorded(options);
  model.answers = [advice("waive")];

  await open();

  expect(model.requests).toEqual([]);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
  expect(logged).toEqual([]);
});

// One Maintainer can deposit on anyone's item in their repo and forfeit it.
test("a Forfeit in one repo doesn't keep a good record from a waiver", async () => {
  const { github, model, open } = await recorded({
    history: [...GOOD, ["acme/secret", "forfeited"], ["acme/secret", "forfeited"]],
    privateRepos: ["acme/secret"],
  });
  model.answers = [advice("waive")];

  await open();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});

test("a denounced Contributor gets no waiver and no model, whatever their record", async () => {
  const { github, model, logged, open } = await recorded();
  github.setFile(REPO, "VOUCHED.td", "-newcomer\n");
  model.answers = [advice("waive")];

  await open();

  expect(model.requests).toEqual([]);
  expect(github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    conclusion: "failure",
    title: "No Deposit accepted: contact the Maintainers",
  });
  expect(logged).toEqual([]);
});

test("merged PRs in other people's repos count, but at most two", async () => {
  const one = await recorded({ history: GOOD.slice(0, 1), profile: { mergedElsewhere: 57 } });
  one.model.answers = [advice("waive")];
  await one.open();
  const none = await recorded({ history: [], profile: { mergedElsewhere: 57 } });
  await none.open();

  expect(one.github.checkOn(REPO, HEAD_SHA)).toMatchObject({
    title: "No Deposit needed: 1 Refund across 1 repo",
    summary: expect.stringContaining("They also have 57 merged PRs in other people's repos."),
  });
  expect(one.logged[0]?.witnesses[0]).toEqual({
    name: "Score",
    value: "3, threshold 3: 1 Refund on accepted work, and 2 merged PRs elsewhere (at most 2 count)",
  });
  // Two merged PRs can't reach the threshold of 3 alone, so the profile isn't even read.
  expect(none.model.requests).toEqual([]);
  expect(none.github.profileReads).toEqual([]);
});

test("with a lower threshold, merged PRs alone can do it, and the check says so", async () => {
  const { github, model, open } = await recorded({
    history: [],
    config: "record_threshold: 2\n",
    profile: { mergedElsewhere: 5 },
  });
  model.answers = [advice("waive")];

  await open();

  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: 5 merged PRs elsewhere");
});

test("a private repo's Deposits count toward nothing the check shows", async () => {
  const { github, model, open } = await recorded({
    config: "record_threshold: 2\n",
    history: [
      ["acme/widgets", "accepted"],
      ["acme/gadgets", "accepted"],
      ["acme/secret", "accepted"],
      ["acme/secret", "accepted"],
      ["acme/hidden", "accepted"],
    ],
    privateRepos: ["acme/secret", "acme/hidden"],
  });
  model.answers = [advice("waive")];

  await open();

  expect(model.requests[0]?.record).toMatchObject({ refunds: 2, repos: 2 });
  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: 2 Refunds across 2 repos");
});

test("a model that says require keeps the Deposit ask and posts nothing", async () => {
  const { github, model, logged, open } = await recorded();
  model.answers = [advice("require", ["The account is new."])];

  await open();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(logged).toMatchObject([
    { type: "waive", action: "required", outcome: "escalated", suggestion: { verdict: "require" } },
  ]);
});

test("a model that flags the record keeps the Deposit ask and posts a note for the Maintainer", async () => {
  const { github, model, logged, open } = await recorded();
  model.answers = [
    advice("flag", [
      "Ask @alice about\nthe burst.",
      "See https://evil.example/x and <b>this</b>.",
      "Three.",
      "Four is one too many.",
    ]),
  ];

  await open();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
  expect(github.markedNotesOn(REPO, PR)).toEqual([
    [
      FLAG_MARKER,
      "**Flagged for the Maintainer: the Contributor's record**",
      "",
      "An automated reviewer read the Contributor's Bona Fide record and public GitHub profile, and suggests a Maintainer look at it before this PR goes ahead without a Deposit. This is only a suggestion: the Maintainer decides.",
      "",
      "- Ask @​alice about the burst.",
      "- See (link removed) and &lt;b&gt;this&lt;/b&gt;.",
      "- Three.",
      "",
      "The Deposit is still needed. A Maintainer who trusts the Contributor can add the `bona-fide:waive` label.",
    ].join("\n"),
  ]);
  expect(logged).toMatchObject([
    {
      action: "flagged",
      outcome: "escalated",
      suggestion: {
        verdict: "flag",
        reasons: ["Ask @alice about the burst.", "See (link removed) and <b>this</b>.", "Three."],
      },
    },
  ]);
});

// As for triage: a suggestion with nothing for the Maintainer to check is no suggestion.
test.each([
  ["waive", []],
  ["waive", [" ", "\n"]],
  ["flag", []],
] as [Advice, string[]][])("a %s with no reasons %j grants nothing and posts nothing", async (verdict, reasons) => {
  const { github, model, logged, open } = await recorded();
  model.answers = [advice(verdict, reasons)];

  await open();

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(logged).toMatchObject([{ action: "silent", outcome: "escalated", suggestion: { verdict, reasons: [] } }]);
});

test.each([
  ["fails", new ModelFailed("rate limited"), "failed: rate limited", null],
  ["throws something unexpected", new Error("sk-ant-secret in a message"), "failed: unexpected error", null],
  [
    "declines",
    { suggestion: null, silence: "refusal", model: "claude-opus-5", inputTokens: 500, outputTokens: 2 },
    "silent",
    { model: "claude-opus-5", inputTokens: 500, outputTokens: 2, usd: 0.00255 },
  ],
] as const)("a model that %s grants nothing and posts nothing", async (_, answer, action, cost) => {
  const { github, model, logged, open } = await recorded();
  model.answers = [answer];

  const response = await open();

  expect(response.status).toBe(200);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
  expect(github.markedNotesOn(REPO, PR)).toEqual([]);
  expect(logged).toMatchObject([{ action, outcome: "escalated", suggestion: null, cost }]);
  expect(JSON.stringify(logged)).not.toContain("sk-ant");
});

test("a waiver is logged as decided, with the record's numbers, the witnesses and the model's cost", async () => {
  const { model, logged, open } = await recorded({ profile: { mergedElsewhere: 1 } });
  model.answers = [advice("waive", ["Four accepted Deposits in three repos."])];

  await open();

  expect(logged).toEqual([
    {
      id: expect.any(String),
      at: NOW.toISOString(),
      repo: REPO,
      private: false,
      item: { kind: "pr", number: PR },
      serial: null,
      type: "waive",
      inputs: {
        login: NEWCOMER,
        refunds: 4,
        repos: 3,
        otherRefunds: 0,
        forfeits: 0,
        active: 0,
        accountAgeDays: 1826,
        publicRepos: 12,
        followers: 30,
        mergedElsewhere: 1,
      },
      suggestion: { verdict: "waive", reasons: ["Four accepted Deposits in three repos."] },
      witnesses: [
        {
          name: "Score",
          value: "5, threshold 3: 4 Refunds on accepted work, and 1 merged PR elsewhere (at most 2 count)",
        },
        { name: "Forfeits", value: "in fewer than 2 repos" },
        { name: "Denounced in VOUCHED.td", value: "no" },
        { name: "Record Exemption in bona-fide.yml", value: "on" },
      ],
      action: "waived",
      txHash: null,
      outcome: "decided",
      cost: { model: "claude-opus-5", inputTokens: 600, outputTokens: 40, usd: 0.004 },
    },
  ]);
});

test("a waiver in a private repo is logged as private, so it is never published", async () => {
  const { model, logged, log, deliver, recordExemptions } = await recorded();
  model.answers = [advice("waive")];

  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER, private: true }));
  await recordExemptions!.idle();

  expect(logged).toMatchObject([{ type: "waive", private: true }]);
  expect(log.latest(REPO, 50)).toEqual([]);
});

test("the model is asked once per item, whatever events follow; reopening it or re-running its check asks again", async () => {
  let time = NOW.getTime();
  const { github, model, open, deliver, recordExemptions } = await recorded({ now: () => new Date(time) });
  model.answers = [advice("require"), advice("require"), advice("waive")];

  await open();
  await open("pr", "synchronize");
  await open("pr", "labeled", ["bona-fide:deposit-required"]);
  await Promise.all([open("pr", "synchronize"), open("pr", "synchronize")]);
  expect(model.requests).toHaveLength(1);

  time += ASK_AGAIN_MS;
  await open("pr", "reopened");
  expect(model.requests).toHaveLength(2);

  time += ASK_AGAIN_MS;
  await deliver("check_run", rerun({ externalId: String(PR) }));
  await recordExemptions!.idle();
  expect(model.requests).toHaveLength(3);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});

// Each answer is paid for, and anyone who can reopen the item, or re-run its check, can ask again.
test("reopening or re-running within ASK_AGAIN_MS of the last answer doesn't ask the model again", async () => {
  let time = NOW.getTime();
  const { model, open, deliver, recordExemptions } = await recorded({ now: () => new Date(time) });
  model.answers = [advice("require"), advice("require")];
  await open();

  for (let i = 0; i < 5; i++) {
    time += 60_000;
    await open("pr", "reopened");
    await deliver("check_run", rerun({ externalId: String(PR) }));
    await recordExemptions!.idle();
  }

  expect(model.requests).toHaveLength(1);
});

test("two checks at once ask the model once", async () => {
  const { model, deliver, recordExemptions } = await recorded();

  await Promise.all([
    deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER })),
    deliver("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER })),
  ]);
  await recordExemptions!.idle();

  expect(model.requests).toHaveLength(1);
});

test("a Contributor's GitHub profile is read once an hour, however many of their items are checked", async () => {
  const { github, open } = await recorded();

  await open("pr");
  await open("issue");

  expect(github.profileReads).toEqual([NEWCOMER]);
});

test("a granted Record Exemption stays on later checks without asking the model again", async () => {
  const { github, model, open } = await recorded();
  model.answers = [advice("waive")];
  await open();

  await open("pr", "synchronize");
  await open("pr", "reopened");

  expect(model.requests).toHaveLength(1);
  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: 4 Refunds across 3 repos");
});

test("a Record Exemption survives a restart: the decision log on disk keeps it", async () => {
  const path = scratchDecisionsPath();
  const first = await recorded({ log: (await openDecisionFile(path)).log });
  first.model.answers = [advice("waive")];
  await first.open();

  const { github, chain } = first;
  const restartedModel = new FakeModel<AdviceRequest>();
  const records = createRecordIndex({ chain, github, fromBlock: 0n });
  for (let i = 0; i < 10; i++) await records.tick();
  const app = createApp({
    github,
    chain,
    depositPageUrl: DEPOSIT_PAGE,
    setupPageUrl: SETUP_PAGE,
    recordExemptions: createRecordExemptions({
      github,
      records,
      model: restartedModel,
      decisions: (await openDecisionFile(path)).log,
    }),
  });
  await createWebhookHandler({ secret: SECRET, app })(
    signed("pull_request", payload("pull_request", "synchronize", { author: NEWCOMER })),
  );

  expect(restartedModel.requests).toEqual([]);
  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: 4 Refunds across 3 repos");
});

test("later Forfeits of the Contributor's in two repos, even private ones, end the Record Exemption on the next check", async () => {
  const { github, model, past, catchUp, open } = await recorded();
  model.answers = [advice("waive"), advice("waive")];
  await open();
  github.addRepo("acme/secret", 1, true);
  past("acme/secret", "forfeited", 900);
  past("acme/widgets", "forfeited", 901);
  await catchUp();

  await open("pr", "synchronize");
  await open("pr", "reopened");

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
  expect(model.requests).toHaveLength(1);
});

test("a Deposit made while the model reads is outranked by the Record Exemption it grants", async () => {
  const { github, chain, model, deliver, recordExemptions } = await recorded();
  let answerNow = () => {};
  model.gate = new Promise((resolve) => (answerNow = resolve));
  model.answers = [advice("waive")];
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));

  chain.deposit({
    repo: REPO,
    kind: "pr",
    number: PR,
    depositor: DEPOSITOR,
    at: new Date(PR_OPENED_AT.getTime() + 60_000),
  });
  answerNow();
  await recordExemptions!.idle();

  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: 4 Refunds across 3 repos");
});

test.each(["off", "false"])("`record_exemption: %s` asks no model", async (value) => {
  const { github, model, open } = await recorded({ config: `record_exemption: ${value}\n` });
  model.answers = [advice("waive")];

  await open();

  expect(model.requests).toEqual([]);
  expect(github.profileReads).toEqual([]);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("turning it off ends a Record Exemption granted before", async () => {
  const { github, model, open } = await recorded();
  model.answers = [advice("waive")];
  await open();

  github.setFile(REPO, ".github/bona-fide.yml", "record_exemption: off\n");
  await open("pr", "synchronize");

  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("without a model on the host, nobody's record is weighed", async () => {
  const { github, open } = await recorded({ noModel: true });

  await open();

  expect(github.profileReads).toEqual([]);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("pending");
});

test("an exempt Contributor's record isn't weighed", async () => {
  const { github, model, open } = await recorded();
  github.setPermission(REPO, NEWCOMER, "write");

  await open();

  expect(model.requests).toEqual([]);
  expect(github.checkOn(REPO, HEAD_SHA)?.title).toBe("No Deposit needed: @newcomer is a collaborator");
});

test("a GitHub failure before the model is asked records nothing, and the next check tries again", async () => {
  const { github, model, logged, open } = await recorded();
  const profileOf = github.profileOf.bind(github);
  github.profileOf = async () => {
    github.profileOf = profileOf;
    throw new Error("Server Error");
  };
  model.answers = [advice("waive")];

  await open();
  expect(logged).toEqual([]);
  await open("pr", "synchronize");

  expect(model.requests).toHaveLength(1);
  expect(github.checkOn(REPO, HEAD_SHA)?.conclusion).toBe("success");
});
