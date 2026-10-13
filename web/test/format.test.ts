import { expect, test } from "vitest";
import {
  delay,
  forfeitSplit,
  localDate,
  localTime,
  parseUsdc,
  percent,
  shortAddress,
  shortDate,
  timeLeft,
  timeout,
  usdc,
  usdcAmount,
  utcTime,
} from "../src/format.ts";

test.each([
  [1_000_000n, "1 USDC"],
  [500_000n, "0.50 USDC"],
  [2_500_000n, "2.50 USDC"],
  [1_230_000n, "1.23 USDC"],
  [1_234_567n, "1.234567 USDC"],
  [1n, "0.000001 USDC"],
  [0n, "0 USDC"],
  [12_400_000n, "12.40 USDC"],
  [1_234_500_000n, "1,234.50 USDC"],
])("%s base units read as %s: exact, and money-like", (amount, text) => {
  expect(usdc(amount)).toBe(text);
});

test("the big amount on the deposit page leaves the unit to the page", () => {
  expect(usdcAmount(1_000_000n)).toBe("1");
  expect(usdcAmount(2_500_000n)).toBe("2.50");
});

test("a forfeit share reads as a percent, and splits a Deposit as the escrow does", () => {
  expect(percent(5000)).toBe("50%");
  expect(percent(2550)).toBe("25.5%");
  expect(percent(0)).toBe("0%");
  expect(forfeitSplit(1_000_000n, 5000)).toEqual({ forfeited: 500_000n, refunded: 500_000n });
  expect(forfeitSplit(1_000_001n, 5000)).toEqual({ forfeited: 500_000n, refunded: 500_001n });
  expect(forfeitSplit(3n, 3333)).toEqual({ forfeited: 0n, refunded: 3n });
});

test("an address is shortened to its first 6 and last 4 characters", () => {
  expect(shortAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBe("0x5aAe…eAed");
});

test("a Timeout reads as the check says it: whole days, or hours rounded up", () => {
  expect(timeout(7 * 86_400)).toBe("7 days");
  expect(timeout(86_400)).toBe("1 day");
  expect(timeout(86_400 + 1)).toBe("25 hours");
});

test("the Binding delay reads in hours", () => {
  expect(delay(86_400)).toBe("24 hours");
  expect(delay(3600)).toBe("1 hour");
  expect(delay(5400)).toBe("2 hours");
});

test.each([
  [5 * 86_400 + 19 * 3600 + 59, "5 days 19 hours"],
  [86_400, "1 day"],
  [3 * 3600 + 4 * 60, "3 hours 4 minutes"],
  [12 * 60 + 30, "12 minutes"],
  [59, "less than a minute"],
])("%i seconds left reads as %s", (seconds, text) => {
  expect(timeLeft(seconds)).toBe(text);
});

const DEADLINE = new Date("2026-10-04T14:03:27Z");

test("times read in the reader's own time zone, and in UTC for the tooltip", () => {
  expect(localTime(DEADLINE, "Asia/Bangkok")).toBe("4 Oct 2026, 21:03 GMT+7");
  expect(localTime(DEADLINE, "UTC")).toBe("4 Oct 2026, 14:03 UTC");
  expect(utcTime(DEADLINE)).toBe("4 Oct 2026, 14:03 UTC");
  expect(shortDate(DEADLINE, "America/Los_Angeles")).toBe("4 Oct");
  expect(shortDate(new Date("2026-10-04T23:30:00Z"), "Asia/Bangkok")).toBe("5 Oct");
});

test("a date without its time reads in the reader's own time zone too", () => {
  expect(localDate(new Date("2026-09-01T20:30:00Z"), "Asia/Bangkok")).toBe("2 Sep 2026");
  expect(localDate(new Date("2026-09-01T20:30:00Z"), "UTC")).toBe("1 Sep 2026");
});

test.each([
  ["50", 50_000_000n],
  ["12.5", 12_500_000n],
  [" 1,000.25 ", 1_000_250_000n],
  ["0.000001", 1n],
  [".5", 500_000n],
  ["7.", 7_000_000n],
  ["0", 0n],
])("%j typed as an amount is %s base units", (text, amount) => {
  expect(parseUsdc(text)).toBe(amount);
});

test.each([[""], ["abc"], ["-1"], ["1.0000001"], ["1e6"], ["1.2.3"], ["0x10"], ["1 000"]])(
  "%j isn't an amount",
  (text) => {
    expect(parseUsdc(text)).toBeNull();
  },
);
