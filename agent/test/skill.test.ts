import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { expect, test } from "vitest";
import { connect } from "./support/mcp.ts";

const SKILL = readFileSync(new URL("../skills/bona-fide/SKILL.md", import.meta.url), "utf8");

// The skill tells an agent which tools to call. A tool renamed or removed on the server would leave
// it calling one that isn't there.
test("the skill names every tool the server has, and no other", async () => {
  // Listing the tools reads no chain.
  const client = createPublicClient({ transport: http("http://127.0.0.1:1") });
  const mcp = await connect({ client, escrow: "0x1111111111111111111111111111111111111111", maxDeposit: 1n });
  const { tools } = await mcp.client.listTools();
  await mcp.close();

  const named = new Set(SKILL.match(/\b(?:get|prepare|submit)_[a-z_]+\b/g));
  expect([...named].sort()).toEqual(tools.map((tool) => tool.name).sort());
});

// The Agent Skills format: a name that matches its folder, and a description agents can match on.
test("the skill's front matter names it and says when to use it", () => {
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(SKILL);
  expect(front?.[1]).toBe("bona-fide");
  expect(front?.[2]).toMatch(/^Make, track and get back a refundable Bona Fide Deposit/);
  expect(front?.[2]!.length).toBeLessThanOrEqual(1024);
});
