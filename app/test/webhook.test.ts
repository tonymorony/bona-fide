import { expect, test } from "vitest";
import { harness } from "./support/harness.ts";
import { fixture, HEAD_SHA, payload, REPO, signed } from "./support/webhooks.ts";

test("a delivery signed with another secret is rejected and changes nothing", async () => {
  const { github, handle } = harness();
  github.setFile(REPO, ".github/bona-fide.yml", "");

  const res = await handle(signed("pull_request", payload("pull_request", "opened"), "not-the-secret"));

  expect(res.status).toBe(401);
  expect(github.checkOn(REPO, HEAD_SHA)).toBeUndefined();
});

test("a delivery without a signature is rejected", async () => {
  const { handle } = harness();
  const unsigned = new Request("https://app.example/webhook", {
    method: "POST",
    headers: { "x-github-event": "ping" },
    body: JSON.stringify(fixture("ping")),
  });

  expect((await handle(unsigned)).status).toBe(401);
});

test("a signed ping is accepted", async () => {
  const { deliver } = harness();

  expect((await deliver("ping", fixture("ping"))).status).toBe(200);
});
