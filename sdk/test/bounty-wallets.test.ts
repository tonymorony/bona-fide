import type { Address } from "viem";
import { expect, test } from "vitest";
import { keeperLimitFor, payeeDeclaredIn, payeeLine, payeeProblem } from "../src/index.ts";

// What the App, the agent and the pages all read the same way: the Keeper's limits, the payees a
// Bounty wallet refuses, and the line that names a Payee.

const PAYEE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as Address;
const WALLET = "0x0000000000000000000000000000000000000B01" as Address;
const KEEPER = "0x0000000000000000000000000000000000000C01" as Address;

test("the Keeper may pay a Bounty within both limits while it's on, and otherwise says which limit stops it", () => {
  const wallet = { keeperEnabled: true, perPayoutLimit: 50_000_000n, keeperAllowance: 30_000_000n };

  expect(keeperLimitFor(30_000_000n, wallet)).toBeNull();
  expect(keeperLimitFor(30_000_001n, wallet)).toBe("period");
  expect(keeperLimitFor(50_000_001n, wallet)).toBe("per-payout");
  expect(keeperLimitFor(1n, { ...wallet, keeperEnabled: false })).toBe("off");
});

test("the wallet can't pay the zero address, itself or the Keeper, in any case", () => {
  expect(payeeProblem("0x0000000000000000000000000000000000000000", WALLET, KEEPER)).toBe("it is the zero address");
  expect(payeeProblem(WALLET.toLowerCase() as Address, WALLET, KEEPER)).toBe("it is the Bounty wallet itself");
  expect(payeeProblem(KEEPER, WALLET, KEEPER)).toBe("it is the Keeper's address");
  expect(payeeProblem(PAYEE, WALLET, KEEPER)).toBeNull();
});

test("the Payee line names the checksummed address, and reads back as it", () => {
  const line = payeeLine(PAYEE.toLowerCase() as Address);

  expect(line).toBe(`Bounty wallet: ${PAYEE}`);
  expect(payeeDeclaredIn(`Fixes #12.\n\n${line}\n`)).toEqual({ address: PAYEE });
});

test.each([
  ["any case for the label", `bounty WALLET: ${PAYEE}`],
  ["backticks around the address", `Bounty wallet: \`${PAYEE}\``],
  ["an all-lowercase address", `Bounty wallet: ${PAYEE.toLowerCase()}`],
  ["spaces and a CRLF line end", `  Bounty wallet:   ${PAYEE}  \r\nThanks!`],
])("a Payee line may use %s", (_, text) => {
  expect(payeeDeclaredIn(text)).toEqual({ address: PAYEE });
});

test("the last Payee line in a text wins, and words mid-line aren't one", () => {
  const other = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

  expect(payeeDeclaredIn(`Bounty wallet: ${other}\nOops, that's old.\nBounty wallet: ${PAYEE}`)).toEqual({
    address: PAYEE,
  });
  expect(payeeDeclaredIn("Is there a bounty wallet: 0x…?")).toBeNull();
});

test("a Payee line without a valid address quotes back only what looks like one", () => {
  const badChecksum = PAYEE.replace("a", "A");

  expect(payeeDeclaredIn(`Bounty wallet: ${badChecksum}`)).toEqual({ address: null, written: badChecksum });
  expect(payeeDeclaredIn("Bounty wallet: newcomer.eth")).toEqual({ address: null, written: null });
});
