import { expect, test } from "vitest";
import { parseConfig } from "../src/config.ts";
import type { Binding } from "../src/ports.ts";
import { harness } from "./support/harness.ts";
import { HEAD_SHA, ISSUE, NEWCOMER, payload, REPO } from "./support/webhooks.ts";

async function checkWith(config: string, binding: Partial<Binding> = {}) {
  const { github, deliver } = harness({ config, binding });
  await deliver("pull_request", payload("pull_request", "opened", { author: NEWCOMER }));
  return github.checkOn(REPO, HEAD_SHA);
}

// The check shows the active Binding. Here the Binding has the terms the config asks for, so no
// new terms are pending.
test.each([
  [
    "amount: 2.5\nforfeit: 20%\ntimeout: 14 days\n",
    { amount: 2_500_000n, forfeitBps: 2000, timeoutSeconds: 1_209_600 },
    "2.50 USDC",
    "20%",
    "14 days",
  ],
  [
    'amount: "2 USDC"\nforfeit: 20\ntimeout: 1\n',
    { amount: 2_000_000n, forfeitBps: 2000, timeoutSeconds: 86_400 },
    "2 USDC",
    "20%",
    "1 day",
  ],
  [
    "amount: 0.5\nforfeit: 12.5%\ntimeout: 60d\nmaintainer: '0x0000000000000000000000000000000000000001'\n",
    { amount: 500_000n, forfeitBps: 1250, timeoutSeconds: 5_184_000 },
    "0.50 USDC",
    "12.5%",
    "60 days",
  ],
  ["amount: 1.125\n", { amount: 1_125_000n }, "1.125 USDC", "50%", "7 days"],
  ["# Bona Fide\n", {}, "1 USDC", "50%", "7 days"],
])(
  "config %j bound as %o asks for %s, forfeits up to %s, times out after %s",
  async (config, binding, amount, forfeit, timeout) => {
    const check = await checkWith(config, binding);

    expect(check?.title).toBe(`Deposit needed: ${amount}, refundable`);
    expect(check?.summary).toContain(`refundable Deposit of **${amount}**`);
    expect(check?.summary).toContain(`up to ${forfeit} funds open-source maintainers (Protocol Guild)`);
    expect(check?.summary).toContain(`Not merged within ${timeout}`);
    expect(check?.summary).not.toMatch(/new terms|terms change/);
  },
);

test("a forfeit share of 0% leaves out the bad-faith line", async () => {
  const check = await checkWith("forfeit: 0\n", { forfeitBps: 0 });

  expect(check?.conclusion).toBe("pending");
  expect(check?.summary).not.toContain("Bad faith");
});

test.each([
  ["forfeit: 80%\n", "`forfeit` must be from 0% to 50%."],
  ["amount: 0\n", "`amount` must be more than 0 and at most 50 USDC."],
  ["amount: 51\n", "`amount` must be more than 0 and at most 50 USDC."],
  ["amount: 0.0000001\n", "`amount` can have at most 6 decimals."],
  ["timeout: 0\n", "`timeout` must be a whole number of days from 1 to 60."],
  ["timeout: 1.5 days\n", "`timeout` must be a whole number of days from 1 to 60."],
  ["amount: [1\n", "The file isn't valid YAML."],
  ["- amount: 1\n", "The file must hold settings such as `amount: 1`."],
  ["exempt_bots: a[bot], b[bot]\n", "`exempt_bots` must be a list of GitHub logins."],
  ["exempt_bots:\n  - a[bot] b[bot]\n", "`exempt_bots` must be a list of GitHub logins."],
  ["exempt_bots:\n  - '@renovate[bot]'\n", "`exempt_bots` must be a list of GitHub logins."],
  ["exempt_bots:\n  - name: a[bot]\n", "`exempt_bots` must be a list of GitHub logins."],
  ["triage: sometimes\n", "`triage` must be on or off."],
  ["triage:\n  - off\n", "`triage` must be on or off."],
  ["record_exemption: maybe\n", "`record_exemption` must be on or off."],
  ["record_threshold: 0\n", "`record_threshold` must be a whole number from 1 to 100."],
  ["record_threshold: 2.5\n", "`record_threshold` must be a whole number from 1 to 100."],
  ["record_threshold: 101\n", "`record_threshold` must be a whole number from 1 to 100."],
  ["record_threshold: three\n", "`record_threshold` must be a whole number from 1 to 100."],
  ["bounties: later\n", "`bounties` must be on or off."],
])("config %j pauses the App with a neutral check: %s", async (config, problem) => {
  const check = await checkWith(config);

  expect(check).toMatchObject({ conclusion: "neutral", title: "Paused: .github/bona-fide.yml needs a fix" });
  expect(check?.summary).toContain(problem);
});

test.each([
  ["", true],
  ["triage: on\n", true],
  ["triage: true\n", true],
  ["triage: off\n", false],
  ["triage: false\n", false],
  ["triage: Off\n", false],
])("config %j has triage on: %s", (config, on) => {
  expect(parseConfig(config)).toMatchObject({ ok: true, config: { triage: on } });
});

test.each([
  ["", true, 3],
  ["record_exemption: off\n", false, 3],
  ["record_exemption: on\nrecord_threshold: 5\n", true, 5],
  ["record_threshold: 1\n", true, 1],
])("config %j has the Record Exemption on: %s, from a score of %i", (config, on, threshold) => {
  expect(parseConfig(config)).toMatchObject({
    ok: true,
    config: { recordExemption: on, recordThreshold: threshold },
  });
});

test.each([
  ["", true],
  ["bounties: on\n", true],
  ["bounties: off\n", false],
])("config %j has the Keeper's Bounty payouts on: %s", (config, on) => {
  expect(parseConfig(config)).toMatchObject({ ok: true, config: { bounties: on } });
});

test("a config error posts nothing on issues", async () => {
  const { github, deliver } = harness({ config: "forfeit: 80%\n" });

  await deliver("issues", payload("issues", "opened", { author: NEWCOMER, labels: [] }));

  expect(github.commentsOn(REPO, ISSUE)).toEqual([]);
  expect(github.labelsOn(REPO, ISSUE)).toEqual([]);
});
