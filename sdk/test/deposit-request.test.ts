import { expect, test } from "vitest";
import { arcMainnet, depositRequestBlock, depositRequestIn, type DepositRequest } from "../src/index.ts";

// The Deposit request the App hides under its check's and comment's text, as an agent reads it back.

const request: DepositRequest = {
  chainId: 5042,
  escrow: arcMainnet.escrow,
  repo: "acme/widgets",
  kind: "pr",
  number: 128,
  amount: 1_000_000n,
  depositUrl: "https://bofi.live/deposit?repo=acme%2Fwidgets&kind=pr&number=128",
  llmsTxtUrl: "https://bofi.live/llms.txt",
};

const LINE =
  '<!-- bona-fide:deposit-request {"v":1,"chainId":5042,"escrow":"0xe2fe798427CFb43134FC37F6EE054c2da818fAc9",' +
  '"repo":"acme/widgets","kind":"pr","number":128,"amount":"1000000",' +
  '"depositUrl":"https://bofi.live/deposit?repo=acme%2Fwidgets&kind=pr&number=128",' +
  '"llmsTxtUrl":"https://bofi.live/llms.txt"} -->';

/** A block with these fields as its JSON, whatever they are. */
function block(fields: Record<string, unknown>): string {
  return `<!-- bona-fide:deposit-request ${JSON.stringify(fields)} -->`;
}

const fields = { v: 1, ...request, amount: "1000000" };

test("the request is one HTML comment line, with the amount as a decimal string", () => {
  expect(depositRequestBlock(request)).toBe(LINE);
});

test("an agent reads back what the App wrote", () => {
  expect(depositRequestIn(depositRequestBlock(request))).toEqual(request);
  expect(depositRequestIn(depositRequestBlock({ ...request, kind: "issue", number: 7 }))).toEqual({
    ...request,
    kind: "issue",
    number: 7,
  });
});

test("the block is found in the text around it", () => {
  const summary = ["This repo asks for a refundable Deposit of **1 USDC** on this PR.", "", LINE, ""].join("\n");

  expect(depositRequestIn(`<!-- bona-fide -->\n**Deposit needed**\n\n${summary}`)).toEqual(request);
});

test("an escrow in lowercase is read checksummed", () => {
  expect(depositRequestIn(block({ ...fields, escrow: arcMainnet.escrow.toLowerCase() }))).toEqual(request);
});

test('a "<" or ">" in a URL can\'t end the comment early, and reads back as written', () => {
  const odd = { ...request, depositUrl: "https://bofi.live/deposit#-->x<" };
  const line = depositRequestBlock(odd);

  expect(line.indexOf("-->")).toBe(line.length - 3);
  expect(depositRequestIn(line)).toEqual(odd);
});

test("text with no block, or two, has no request", () => {
  expect(depositRequestIn("Deposit needed: 1 USDC, refundable")).toBeNull();
  expect(depositRequestIn("<!-- bona-fide -->")).toBeNull();
  expect(depositRequestIn(`${LINE}\n${LINE}`)).toBeNull();
  expect(depositRequestIn(`${LINE}\n\n> ${block({ ...fields, escrow: `0x${"66".repeat(20)}` })}`)).toBeNull();
});

test.each([
  ["JSON that doesn't parse", '<!-- bona-fide:deposit-request {"v":1, -->'],
  ["JSON that isn't an object", block([1] as never)],
  ["another version", block({ ...fields, v: 2 })],
  ["no version", block({ ...fields, v: undefined })],
  ["an escrow that isn't an address", block({ ...fields, escrow: "0x1234" })],
  ["a chain id as a string", block({ ...fields, chainId: "5042" })],
  ["a repo that isn't owner/name", block({ ...fields, repo: "acme/widgets/issues" })],
  ["a kind other than pr or issue", block({ ...fields, kind: "discussion" })],
  ["a number below 1", block({ ...fields, number: 0 })],
  ["an amount as a JSON number", block({ ...fields, amount: 1_000_000 })],
  ["an amount with a fraction", block({ ...fields, amount: "1.5" })],
  ["an amount above uint256", block({ ...fields, amount: (2n ** 256n).toString() })],
  ["a deposit page that isn't a web URL", block({ ...fields, depositUrl: "javascript:alert(1)" })],
  ["no llms.txt URL", block({ ...fields, llmsTxtUrl: undefined })],
])("a block with %s is no request", (_, text) => {
  expect(depositRequestIn(text)).toBeNull();
});
