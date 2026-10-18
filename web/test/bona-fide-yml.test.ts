import { expect, test } from "vitest";
import { parseConfig } from "../../app/src/config.ts";
import { fetchBonaFideYml, readBonaFideYml } from "../src/bona-fide-yml.ts";
import type { Fetch } from "../src/endpoints.ts";

const WALLET = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";

test.each([
  [""],
  ["amount: 1\nforfeit: 50%\ntimeout: 7 days\n"],
  ["amount: 2.5 USDC\nforfeit: 20%\ntimeout: 14d\n"],
  ["amount: 0.000001\nforfeit: 0\ntimeout: 1 day\n"],
  ["amount: 0.0000001\n"],
  ["amount: 51\n"],
  ["amount: -1\n"],
  ["forfeit: 51%\n"],
  ["forfeit: 12.345%\n"],
  ["timeout: 61 days\n"],
  ["timeout: 1 week\n"],
  ["exempt_bots:\n  - pre-commit-ci[bot]\n"],
  ["exempt_bots: [pre-commit-ci[bot]]\n"],
  ["exempt_bots: nope\n"],
  ["- just a list\n"],
  ["amount: [1\n"],
  [`maintainer: ${WALLET}\namount: 3\n`],
])("the page reads %j as the App does", (text) => {
  const app = parseConfig(text);
  const page = readBonaFideYml(text);

  // The App's parser, not the page's, picks the branch, so neither can be skipped by the code under test.
  /* eslint-disable vitest/no-conditional-expect -- each case expects what the App's parser decided; review-by: 2027-04-18 */
  if (app.ok) {
    expect(page).toMatchObject({
      ok: true,
      terms: {
        amount: app.config.amount,
        forfeitBps: app.config.forfeitBps,
        timeoutSeconds: app.config.timeoutSeconds,
      },
    });
  } else {
    expect(page).toEqual({ ok: false, problems: app.problems });
  }
  /* eslint-enable vitest/no-conditional-expect */
});

test("the Maintainer's wallet is read as the Keeper reads it, and is null when missing or malformed", () => {
  expect(readBonaFideYml(`maintainer: ${WALLET.toLowerCase()}\n`)).toMatchObject({
    ok: true,
    terms: { maintainer: WALLET },
  });
  expect(readBonaFideYml(`maintainer: "  ${WALLET}  "\n`)).toMatchObject({ ok: true, terms: { maintainer: WALLET } });
  expect(readBonaFideYml("amount: 1\n")).toMatchObject({ ok: true, terms: { maintainer: null } });
  expect(readBonaFideYml("maintainer: 0x1234\n")).toMatchObject({ ok: true, terms: { maintainer: null } });
});

function answering(status: number, body: string) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const fetch: Fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response(body, { status });
  };
  return { fetch, sent };
}

test("the file is read from the default branch through GitHub's API, as raw text", async () => {
  const { fetch, sent } = answering(200, `maintainer: ${WALLET}\n`);

  expect(await fetchBonaFideYml("Acme/Gizmos", fetch)).toEqual({ kind: "found", text: `maintainer: ${WALLET}\n` });
  expect(sent[0]!.url).toBe("https://api.github.com/repos/Acme/Gizmos/contents/.github/bona-fide.yml");
  expect(new Headers(sent[0]!.init?.headers).get("accept")).toBe("application/vnd.github.raw+json");
});

test("a missing file, a private repo and an unreachable GitHub read differently", async () => {
  const visibleRepo: Fetch = async (url) => new Response("{}", { status: url.includes("/contents/") ? 404 : 200 });
  const hiddenRepo: Fetch = async () => new Response("{}", { status: 404 });

  expect(await fetchBonaFideYml("acme/gizmos", visibleRepo)).toEqual({ kind: "missing" });
  expect(await fetchBonaFideYml("acme/secret", hiddenRepo)).toEqual({ kind: "unreadable" });
  expect(await fetchBonaFideYml("acme/gizmos", answering(403, "{}").fetch)).toEqual({ kind: "unreadable" });
  const failing: Fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  expect(await fetchBonaFideYml("acme/gizmos", failing)).toEqual({ kind: "unreadable" });
});
