import type { Address } from "viem";
import { expect, test } from "vitest";
import { bountyMarkers } from "../src/bounties/bounties.ts";
import { createBountyNotices } from "../src/bounties/posted.ts";
import { BOUNTY_ISSUE, BOUNTY_PAGE, OWNER, TEN_USDC } from "./support/bounties.ts";
import { FakeChain } from "./support/fake-chain.ts";
import { FakeGitHub } from "./support/fake-github.ts";
import { FakeBountyWallets, type Limits } from "./support/fake-wallets.ts";
import { HELLO_WORLD, NEWCOMER, REPO } from "./support/webhooks.ts";

// A Bounty posted on an issue gets one note there, so Contributors see it where they work. The
// notes read the wallets' logs on a timer; GitHub, the escrow and the wallets are faked.

const REPO_LINK = "https://bonafide.example/repo.html?repo=Codertocat%2FHello-World";
const STRANGER: Address = "0x000000000000000000000000000000000000dEaD";

interface Options {
  /** The text of .github/bona-fide.yml, or null for none. */
  config?: string | null;
  /** Whether a model can confirm a PR resolves its issue. */
  withModel?: boolean;
  limits?: Limits;
  /** Whether the repo has an active Binding, whose Maintainer owns the wallet. */
  bound?: boolean;
}

// The repo is bound, its Maintainer has a wallet, and issue #42 is open. Nothing is posted yet.
function noting({ config = "", withModel = true, limits, bound = true }: Options = {}) {
  const github = new FakeGitHub();
  github.addRepo(REPO);
  if (config !== null) github.setFile(REPO, ".github/bona-fide.yml", config);
  github.addItem({
    repo: HELLO_WORLD,
    kind: "issue",
    number: BOUNTY_ISSUE,
    author: NEWCOMER,
    createdAt: new Date(0),
    labels: [],
  });
  const chain = new FakeChain();
  if (bound) chain.bind(REPO);
  const wallets = new FakeBountyWallets();
  const wallet = wallets.create(REPO, OWNER, limits);
  const start = (fromBlock = 0n) =>
    createBountyNotices({ github, chain, wallets, withModel, bountyPageUrl: BOUNTY_PAGE, fromBlock });
  const notices = start();
  const notes = (issue = BOUNTY_ISSUE) => github.markedNotesOn(REPO, issue);
  return { github, chain, wallets, wallet, notices, start, notes };
}

test("a Bounty posted on an open issue gets one note there, which tells Contributors how it is paid and links the repo page", async () => {
  const { wallets, wallet, notices, notes } = noting();
  const serial = wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);

  await notices.tick();

  expect(notes()).toEqual([
    [
      bountyMarkers(BOUNTY_ISSUE, serial).posted,
      "**Bounty: 10 USDC**",
      "",
      "This issue has a Bounty of **10 USDC**, reserved in the repo's Bounty wallet.",
      "",
      "To receive it:",
      "",
      "1. Open a PR that closes this issue, such as with `Fixes #42` in its description.",
      "2. Add a line with your wallet to the PR description, or to a comment of your own on the PR:",
      "   `Bounty wallet: 0xYourWalletAddress`",
      "3. The first merged PR that closes this issue gets the Bounty, in full. The Keeper pays it once the PR's checks are green and an automated reviewer agrees it resolves the issue, within the Maintainer's limits. Otherwise the Maintainer can pay it by signing the Payout.",
      "",
      `[See the Bounty](${REPO_LINK})`,
    ].join("\n"),
  ]);
});

test("a Bounty is noted once: not again on later ticks, nor after a restart that reads the logs again", async () => {
  const { wallets, wallet, notices, start, notes } = noting();
  wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);

  await notices.tick();
  await notices.tick();
  await start().tick();

  expect(notes()).toHaveLength(1);
});

test("a Bounty posted after the last tick is noted on the next, and each tick reads only the blocks since", async () => {
  const { wallets, wallet, notices, notes } = noting();
  await notices.tick();
  expect(notes()).toEqual([]);

  wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);
  await notices.tick();

  expect(notes()).toHaveLength(1);
  expect(notices.position).toBe(3n);
  // The first read found the wallet; the next asks for its Bounties.
  expect(wallets.reads).toEqual([[], [wallet]]);
});

test("a Bounty above the wallet's per-payout limit says the Keeper won't pay it on its own, and the Maintainer signs the Payout", async () => {
  const { wallets, wallet, notices, notes } = noting({ limits: { perPayoutLimit: 5_000_000n } });
  wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);

  await notices.tick();

  expect(notes()[0]).toContain(
    [
      "This issue has a Bounty of **10 USDC**, reserved in the repo's Bounty wallet. It is above the wallet's per-payout limit of 5 USDC, so the Keeper won't pay it on its own.",
      "",
      "To receive it:",
      "",
      "1. Open a PR that closes this issue, such as with `Fixes #42` in its description.",
      "2. Add a line with your wallet to the PR description, or to a comment of your own on the PR:",
      "   `Bounty wallet: 0xYourWalletAddress`",
      "3. Once your PR is merged, the Maintainer can pay the Bounty to you in full by signing the Payout.",
    ].join("\n"),
  );
});

test.each([
  ["the repo has bounties: off", { config: "bounties: off\n" }],
  ["the Maintainer turned the Keeper's payouts off", { limits: { keeperEnabled: false } }],
  ["no model can confirm a PR resolves the issue", { withModel: false }],
])("when %s, the note says the Maintainer pays, and names no limit", async (_, options: Options) => {
  const { wallets, wallet, notices, notes } = noting(options);
  wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);

  await notices.tick();

  expect(notes()).toHaveLength(1);
  expect(notes()[0]).toContain("reserved in the repo's Bounty wallet.\n\nTo receive it:\n\n");
  expect(notes()[0]).toContain(
    "3. Once your PR is merged, the Maintainer can pay the Bounty to you in full by signing the Payout.",
  );
  expect(notes()[0]).not.toContain("automated reviewer");
});

test("a Bounty cancelled or paid before the tick gets no note, and one posted again gets a note of its own", async () => {
  const { github, wallets, wallet, notices, notes } = noting();
  github.addItem({
    repo: HELLO_WORLD,
    kind: "issue",
    number: 43,
    author: NEWCOMER,
    createdAt: new Date(0),
    labels: [],
  });
  wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);
  wallets.cancel(wallet, BOUNTY_ISSUE);
  wallets.post(wallet, 43, TEN_USDC);
  wallets.ownerPay(wallet, 43, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");

  await notices.tick();
  expect(notes()).toEqual([]);
  expect(notes(43)).toEqual([]);

  const again = wallets.post(wallet, BOUNTY_ISSUE, 2_000_000n);
  await notices.tick();

  expect(notes()).toEqual([expect.stringContaining("**Bounty: 2 USDC**")]);
  expect(notes()[0]?.startsWith(bountyMarkers(BOUNTY_ISSUE, again).posted)).toBe(true);
});

test("a Bounty on a closed issue, on a PR, or on a number with neither gets no note", async () => {
  const { github, wallets, wallet, notices } = noting();
  github.close(REPO, BOUNTY_ISSUE);
  github.addItem({
    repo: HELLO_WORLD,
    kind: "pr",
    number: 7,
    author: NEWCOMER,
    createdAt: new Date(0),
    labels: [],
    headSha: "7".repeat(40),
  });
  wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);
  wallets.post(wallet, 7, TEN_USDC);
  wallets.post(wallet, 99, TEN_USDC);

  await notices.tick();

  for (const number of [BOUNTY_ISSUE, 7, 99]) expect(github.markedNotesOn(REPO, number)).toEqual([]);
});

test("a wallet anyone but the active Binding's Maintainer made for the repo is ignored", async () => {
  const { wallets, notices, notes } = noting();
  const theirs = wallets.create(REPO, STRANGER);
  wallets.post(theirs, BOUNTY_ISSUE, TEN_USDC);

  await notices.tick();

  expect(notes()).toEqual([]);
});

test("a Bounty in a repo without an active Binding, without bona-fide.yml, or with one the App can't read gets no note", async () => {
  for (const setup of [noting({ bound: false }), noting({ config: null }), noting({ config: "amount: lots\n" })]) {
    setup.wallets.post(setup.wallet, BOUNTY_ISSUE, TEN_USDC);
    await setup.notices.tick();
    expect(setup.notes()).toEqual([]);
  }
});

test("a note GitHub refuses is tried again on later ticks, and the scan moves on meanwhile", async () => {
  const { github, wallets, wallet, notices, notes } = noting();
  wallets.post(wallet, BOUNTY_ISSUE, TEN_USDC);
  github.breakItem("issue", BOUNTY_ISSUE, 1);

  await expect(notices.tick()).rejects.toThrow("1 Bounty note(s) not posted yet; later ticks retry them.");
  expect(notes()).toEqual([]);
  expect(notices.position).toBe(3n);

  await notices.tick();

  expect(notes()).toHaveLength(1);
});
