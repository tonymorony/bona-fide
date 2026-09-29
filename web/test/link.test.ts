import { expect, test } from "vitest";
import {
  explorerAddress,
  explorerTx,
  itemName,
  itemUrl,
  readItemLink,
  readRepoLink,
  repoPageUrl,
} from "../src/link.ts";

test("the check's deposit link names the repo in GitHub's case, the kind and the number", () => {
  expect(readItemLink("?repo=Acme/Widgets&kind=pr&number=128")).toEqual({
    repo: "Acme/Widgets",
    kind: "pr",
    number: 128,
  });
  expect(readItemLink("?repo=acme%2Fwidgets&kind=issue&number=7")).toEqual({
    repo: "acme/widgets",
    kind: "issue",
    number: 7,
  });
});

test.each([
  [""],
  ["?repo=acme/widgets&kind=pr"],
  ["?repo=acme&kind=pr&number=1"],
  ["?repo=acme/widgets&kind=discussion&number=1"],
  ["?repo=acme/widgets&kind=pr&number=0"],
  ["?repo=acme/widgets&kind=pr&number=1.5"],
  ["?repo=acme/widgets&kind=pr&number=9007199254740992"],
  ["?repo=acme/wid gets&kind=pr&number=1"],
  ["?repo=../../etc&kind=pr&number=1"],
])("an incomplete or malformed link %j reads as nothing", (search) => {
  expect(readItemLink(search)).toBeNull();
});

test("the repo pages need only the repo", () => {
  expect(readRepoLink("?repo=acme/gizmos")).toBe("acme/gizmos");
  expect(readRepoLink("?repo=acme/gizmos&kind=pr&number=1")).toBe("acme/gizmos");
  expect(readRepoLink("?repo=acme")).toBeNull();
  expect(readRepoLink("")).toBeNull();
});

test("items and repos link to GitHub and to their Bona Fide pages", () => {
  expect(itemUrl({ repo: "acme/widgets", kind: "pr", number: 128 })).toBe("https://github.com/acme/widgets/pull/128");
  expect(itemUrl({ repo: "acme/widgets", kind: "issue", number: 7 })).toBe("https://github.com/acme/widgets/issues/7");
  expect(repoPageUrl("acme/widgets")).toBe("repo.html?repo=acme%2Fwidgets");
  expect(itemName("pr", 128)).toBe("PR #128");
  expect(itemName("issue", 7)).toBe("issue #7");
  expect(itemName("issue", 7, { capital: true })).toBe("Issue #7");
});

test("transactions and addresses link to the network's explorer", () => {
  const network = { explorerUrl: "https://explorer.testnet.arc.io" };
  const hash = `0x${"ab".repeat(32)}` as const;
  expect(explorerTx(network, hash)).toBe(`https://explorer.testnet.arc.io/tx/${hash}`);
  expect(explorerAddress(network, "0x05283F2c7D94D66669227Cecf75abBbd024771A7")).toBe(
    "https://explorer.testnet.arc.io/address/0x05283F2c7D94D66669227Cecf75abBbd024771A7",
  );
});
