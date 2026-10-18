import { expect, test } from "vitest";
import { keyOf, repoIdOf } from "../src/index.ts";

// Expected values come from Foundry's cast, not from this code:
//   cast keccak "github:codertocat/hello-world"
//   cast keccak $(cast abi-encode 'f(bytes32,uint8,uint64)' <repoId> <kind> <number>)
const HELLO_WORLD_ID = "0x23b3a11b77c09ead2e5a3dcca5235e387d898621d8a67dd11e76976e627a8a42";

test("a repoId hashes 'github:' and the lowercased owner/repo", () => {
  expect(repoIdOf("Codertocat/Hello-World")).toBe(HELLO_WORLD_ID);
});

test("a key encodes the repoId, the kind and the number like the escrow", () => {
  expect(keyOf(HELLO_WORLD_ID, "pr", 2)).toBe("0xd450d8855c118c0473e6c547987e879dc415d1c7486118864711970d76d7b61c");
  expect(keyOf(HELLO_WORLD_ID, "issue", 1)).toBe("0x052067ed48fd9c1bed6df260af72960a13332daac033521ec08cd1b0a8789770");
});
