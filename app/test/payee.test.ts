import { expect, test } from "vitest";
import { payeeOf, payeeProblem } from "../src/bounties/payee.ts";
import { KEEPER } from "./support/fake-wallets.ts";
import { mergedPr, PAYEE, text } from "./support/bounties.ts";
import { NEWCOMER } from "./support/webhooks.ts";

// Who a Bounty is paid to: the wallet the merged PR's author named, in their own words.

const OTHER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const LATER = new Date("2026-09-30T13:00:00Z");

test("the author names their wallet on a line of its own in the PR description", () => {
  expect(payeeOf(mergedPr())).toEqual({ kind: "declared", address: PAYEE, source: "body" });
});

test.each([
  ["any case for the label", `bounty WALLET: ${PAYEE}`],
  ["backticks around the address", `Bounty wallet: \`${PAYEE}\``],
  ["an all-lowercase address", `Bounty wallet: ${PAYEE.toLowerCase()}`],
  ["spaces and a CRLF line end", `  Bounty wallet:   ${PAYEE}  \r\nThanks!`],
])("a declaration may use %s", (_, line) => {
  expect(payeeOf(mergedPr({ body: text(line) }))).toEqual({ kind: "declared", address: PAYEE, source: "body" });
});

test("a comment of the author's outranks the description, and their latest comment wins", () => {
  const facts = mergedPr({
    comments: [text(`Bounty wallet: ${PAYEE}`, NEWCOMER, LATER), text(`Bounty wallet: ${OTHER}`)],
  });

  expect(payeeOf(facts)).toEqual({ kind: "declared", address: PAYEE, source: "comment" });
});

test("in one text, the last declaration wins", () => {
  const facts = mergedPr({ body: text(`Bounty wallet: ${OTHER}\nOops, that's old.\nBounty wallet: ${PAYEE}`) });

  expect(payeeOf(facts)).toMatchObject({ address: PAYEE });
});

test("anyone else's words are ignored, even a Maintainer's", () => {
  const facts = mergedPr({ comments: [text(`Bounty wallet: ${OTHER}`, "maintainer", LATER)] });

  expect(payeeOf(facts)).toEqual({ kind: "declared", address: PAYEE, source: "body" });
});

test("a description or comment someone else edited last doesn't count", () => {
  const edited = { ...text(`Bounty wallet: ${OTHER}`), editor: "maintainer" };
  const ownEdit = { ...text(`Bounty wallet: ${PAYEE}`, NEWCOMER, LATER), editor: NEWCOMER };

  expect(payeeOf(mergedPr({ body: edited }))).toEqual({ kind: "none" });
  expect(payeeOf(mergedPr({ body: edited, comments: [ownEdit] }))).toMatchObject({ address: PAYEE });
});

test.each([
  ["no declaration", "Fixes #42.", { kind: "none" }],
  ["the words mid-line", "Is there a bounty wallet: 0x…?", { kind: "none" }],
  ["a declaration line without an address", "Bounty wallet: soon", { kind: "invalid", written: null, source: "body" }],
  [
    "a mixed-case address with a bad checksum",
    `Bounty wallet: ${PAYEE.replace("a", "A")}`,
    { kind: "invalid", written: PAYEE.replace("a", "A"), source: "body" },
  ],
  ["an ENS name", "Bounty wallet: newcomer.eth", { kind: "invalid", written: null, source: "body" }],
  [
    "an address one digit short",
    `Bounty wallet: ${PAYEE.slice(0, -1)}`,
    { kind: "invalid", written: null, source: "body" },
  ],
])("%s names no payee", (_, body, payee) => {
  expect(payeeOf(mergedPr({ body: text(body) }))).toEqual(payee);
});

test("a PR whose author's account is gone has no payee", () => {
  expect(payeeOf(mergedPr({ author: null }))).toEqual({ kind: "none" });
});

test("the wallet can't pay the zero address, itself or the Keeper", () => {
  const wallet = "0x0000000000000000000000000000000000000001";

  expect(payeeProblem("0x0000000000000000000000000000000000000000", wallet, KEEPER)).toBe("it is the zero address");
  expect(payeeProblem(wallet, wallet, KEEPER)).toBe("it is the Bounty wallet itself");
  expect(payeeProblem(KEEPER, wallet, KEEPER)).toBe("it is the Keeper's address");
  expect(payeeProblem(PAYEE, wallet, KEEPER)).toBeNull();
});
