import { formatUnits } from "viem";

const USDC_DECIMALS = 6;
const MINUTE = 60;
const HOUR = 3600;
const DAY = 86_400;

/** An amount of USDC base units, exact: "1", "0.50", "1.234567", "1,234.50". */
export function usdcAmount(amount: bigint): string {
  const [whole = "0", fraction = ""] = formatUnits(amount, USDC_DECIMALS).split(".");
  const grouped = BigInt(whole).toLocaleString("en-US");
  return fraction ? `${grouped}.${fraction.padEnd(2, "0")}` : grouped;
}

export function usdc(amount: bigint): string {
  return `${usdcAmount(amount)} USDC`;
}

export function percent(bps: number): string {
  return `${bps / 100}%`;
}

/** How a Forfeit splits a Deposit, rounded as the escrow rounds it. */
export function forfeitSplit(amount: bigint, forfeitBps: number): { forfeited: bigint; refunded: bigint } {
  const forfeited = (amount * BigInt(forfeitBps)) / 10_000n;
  return { forfeited, refunded: amount - forfeited };
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function count(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** A Timeout, as the GitHub check words it: whole days, or hours rounded up so the promise holds. */
export function timeout(seconds: number): string {
  if (seconds % DAY === 0) return count(seconds / DAY, "day");
  return count(Math.ceil(seconds / HOUR), "hour");
}

/** The Binding delay, in hours. */
export function delay(seconds: number): string {
  return count(Math.ceil(seconds / HOUR), "hour");
}

/** Time left until a deadline, to the two largest units. */
export function timeLeft(seconds: number): string {
  const days = Math.floor(seconds / DAY);
  const hours = Math.floor((seconds % DAY) / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${count(days, "day")} ${count(hours, "hour")}` : count(days, "day");
  if (hours > 0) return minutes > 0 ? `${count(hours, "hour")} ${count(minutes, "minute")}` : count(hours, "hour");
  if (minutes > 0) return count(minutes, "minute");
  return "less than a minute";
}

// Built from parts: en-GB now abbreviates September as "Sept".
function partsOf(date: Date, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", options).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

/** "4 Oct 2026, 21:03 GMT+7" in `timeZone`, the reader's own by default. */
export function localTime(date: Date, timeZone?: string): string {
  const p = partsOf(date, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone,
  });
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${p.timeZoneName}`;
}

/** "4 Oct 2026, 14:03 UTC", as the GitHub check shows times. */
export function utcTime(date: Date): string {
  return localTime(date, "UTC");
}

/** "4 Oct 2026" in `timeZone`, the reader's own by default. */
export function localDate(date: Date, timeZone?: string): string {
  const p = partsOf(date, { day: "numeric", month: "short", year: "numeric", timeZone });
  return `${p.day} ${p.month} ${p.year}`;
}

/** "4 Oct" in `timeZone`, the reader's own by default. */
export function shortDate(date: Date, timeZone?: string): string {
  const p = partsOf(date, { day: "numeric", month: "short", timeZone });
  return `${p.day} ${p.month}`;
}
