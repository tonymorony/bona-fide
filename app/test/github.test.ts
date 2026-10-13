import { Octokit } from "@octokit/rest";
import { expect, test, vi } from "vitest";
import { createGitHub, quietLog } from "../src/github.ts";
import { repoIdOf } from "../src/keys.ts";
import type { Item } from "../src/ports.ts";
import { fixture } from "./support/webhooks.ts";

// The Octokit adapter against a fake api.github.com: what GitHub receives, and how its answers map back.

const APP_ID = 1234;
const REPO = { owner: "Codertocat", name: "Hello-World", installationId: 1 };
const API = "/repos/Codertocat/Hello-World";

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  accept: string;
}

type Reply = { status: number; body?: unknown };

/** Whether the request asked for a diff, as Octokit does with its Accept header. */
function isDiff(sent: Sent): boolean {
  return sent.accept.includes("diff");
}

function itemOf(kind: "pr" | "issue", number: number): Item {
  const fields = { repo: REPO, number, author: "newcomer", createdAt: new Date(0), labels: [] };
  return kind === "pr" ? { ...fields, kind, headSha: "abc" } : { ...fields, kind };
}

function fakeApi(routes: Record<string, Reply | ((sent: Sent) => Reply)>) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const request: Sent = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      accept: new Headers(init?.headers).get("accept") ?? "",
    };
    sent.push(request);
    const route = routes[`${request.method} ${request.path}`];
    const reply =
      typeof route === "function" ? route(request) : (route ?? { status: 404, body: { message: "Not Found" } });
    const isText = typeof reply.body === "string";
    const response = new Response(
      reply.status === 204 ? null : isText ? (reply.body as string) : JSON.stringify(reply.body ?? {}),
      {
        status: reply.status,
        headers: { "content-type": isText ? "text/plain" : "application/json" },
      },
    );
    return Object.defineProperty(response, "url", { value: url.toString() });
  };
  const octokit = new Octokit({
    auth: "test",
    request: { fetch },
    log: quietLog({ warn() {} }),
  });
  const github = createGitHub({ appId: APP_ID, app: octokit, installation: () => octokit });
  return { github, sent };
}

test("a file is read raw from the default branch, and a missing one is null", async () => {
  const { github, sent } = fakeApi({
    [`GET ${API}/contents/.github/bona-fide.yml`]: { status: 200, body: "amount: 2\n" },
  });

  expect(await github.readFile(REPO, ".github/bona-fide.yml")).toBe("amount: 2\n");
  expect(await github.readFile(REPO, "VOUCHED.td")).toBeNull();
  expect(sent[0]?.query.has("ref")).toBe(false);
});

test("a permission comes from the collaborator endpoint, and an unknown user has none", async () => {
  const { github } = fakeApi({
    [`GET ${API}/collaborators/mo/permission`]: { status: 200, body: { permission: "write", role_name: "maintain" } },
  });

  expect(await github.permissionOf(REPO, "mo")).toBe("write");
  expect(await github.permissionOf(REPO, "ghost")).toBe("none");
});

test("a prior merged PR is found through search", async () => {
  const { github, sent } = fakeApi({
    "GET /search/issues": (s) => ({
      status: 200,
      body: { total_count: s.query.get("q")!.includes("author:mo") ? 3 : 0, items: [] },
    }),
  });

  expect(await github.hasMergedPullRequest(REPO, "mo")).toBe(true);
  expect(await github.hasMergedPullRequest(REPO, "newcomer")).toBe(false);
  expect(sent[0]?.query.get("q")).toBe("repo:Codertocat/Hello-World is:pr is:merged author:mo");
});

test("a login that search refuses, such as the Copilot agent's, has no merged PR", async () => {
  const { github } = fakeApi({
    "GET /search/issues": {
      status: 422,
      body: {
        message: "Validation Failed",
        errors: [
          {
            message:
              "The listed users cannot be searched either because the users do not exist or you do not have permission to view the users.",
            resource: "Search",
            field: "q",
            code: "invalid",
          },
        ],
      },
    },
  });

  expect(await github.hasMergedPullRequest(REPO, "Copilot")).toBe(false);
});

test("the first check on a commit is created, completed, with its link", async () => {
  const { github, sent } = fakeApi({
    [`GET ${API}/commits/abc123/check-runs`]: { status: 200, body: { total_count: 0, check_runs: [] } },
    [`POST ${API}/check-runs`]: { status: 201, body: { id: 9 } },
  });

  await github.setCheck(REPO, "abc123", {
    conclusion: "action_required",
    title: "T",
    summary: "S",
    detailsUrl: "https://x.example/d",
  });

  const lookup = sent[0]!;
  expect(Object.fromEntries(lookup.query)).toMatchObject({ check_name: "Bona Fide", app_id: String(APP_ID) });
  expect(sent[1]?.body).toMatchObject({
    name: "Bona Fide",
    head_sha: "abc123",
    status: "completed",
    conclusion: "action_required",
    details_url: "https://x.example/d",
    output: { title: "T", summary: "S" },
  });
});

test("a later check on the same commit updates the App's run", async () => {
  const { github, sent } = fakeApi({
    [`GET ${API}/commits/abc123/check-runs`]: {
      status: 200,
      body: { total_count: 1, check_runs: [{ id: 77, name: "Bona Fide" }] },
    },
    [`PATCH ${API}/check-runs/77`]: { status: 200, body: { id: 77 } },
  });

  await github.setCheck(REPO, "abc123", { conclusion: "success", title: "T2", summary: "S2" });

  expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
    `GET ${API}/commits/abc123/check-runs`,
    `PATCH ${API}/check-runs/77`,
  ]);
  expect(sent[1]?.body).toMatchObject({
    status: "completed",
    conclusion: "success",
    output: { title: "T2", summary: "S2" },
  });
});

// GitHub can't clear a run's link, and a run created without one links to the App's homepage.
test.each([
  [
    "the App's homepage, as a check that never asked does",
    { external_url: "https://bonafide.example" },
    "https://bonafide.example",
  ],
  ["the run's own page, if GitHub names no homepage", null, "https://github.com/Codertocat/Hello-World/runs/77"],
])("a check that stops asking for a Deposit links to %s", async (_, app, link) => {
  const { github, sent } = fakeApi({
    [`GET ${API}/commits/abc123/check-runs`]: {
      status: 200,
      body: {
        total_count: 1,
        check_runs: [
          {
            id: 77,
            name: "Bona Fide",
            details_url: "https://bonafide.example/deposit?repo=Codertocat%2FHello-World&kind=pr&number=2",
            html_url: "https://github.com/Codertocat/Hello-World/runs/77",
            app,
          },
        ],
      },
    },
    [`PATCH ${API}/check-runs/77`]: { status: 200, body: { id: 77 } },
  });

  await github.setCheck(REPO, "abc123", { conclusion: "success", title: "T2", summary: "S2" });

  expect(sent[1]?.body.details_url).toBe(link);
});

test("a check's external id is stored on the run, when it is created and when it is updated", async () => {
  let runs: { id: number; name: string }[] = [];
  const { github, sent } = fakeApi({
    [`GET ${API}/commits/abc123/check-runs`]: () => ({
      status: 200,
      body: { total_count: runs.length, check_runs: runs },
    }),
    [`POST ${API}/check-runs`]: () => {
      runs = [{ id: 9, name: "Bona Fide" }];
      return { status: 201, body: { id: 9 } };
    },
    [`PATCH ${API}/check-runs/9`]: { status: 200, body: { id: 9 } },
  });

  await github.setCheck(REPO, "abc123", { conclusion: "action_required", title: "T", summary: "S", externalId: "2" });
  await github.setCheck(REPO, "abc123", { conclusion: "success", title: "T2", summary: "S2", externalId: "2" });

  expect(sent.filter((s) => s.method !== "GET").map((s) => [s.method, s.body.external_id])).toEqual([
    ["POST", "2"],
    ["PATCH", "2"],
  ]);
});

test("the App's runs in a check suite name their PRs by external id, or by the PR GitHub lists", async () => {
  const { github, sent } = fakeApi({
    [`GET ${API}/check-suites/118578147/check-runs`]: {
      status: 200,
      body: {
        total_count: 3,
        check_runs: [
          { id: 1, name: "Bona Fide", external_id: "2", pull_requests: [] },
          { id: 2, name: "Bona Fide", external_id: "", pull_requests: [{ number: 5 }] },
          { id: 3, name: "Bona Fide", external_id: null, pull_requests: [] },
        ],
      },
    },
  });

  expect(await github.suitePullRequests(REPO, 118578147)).toEqual([2, 5]);
  expect(Object.fromEntries(sent[0]!.query)).toMatchObject({ check_name: "Bona Fide" });
});

test("the most recently updated open PRs and issues come from one page of the repo's issues, which include its PRs", async () => {
  const { github, sent } = fakeApi({
    [`GET ${API}/issues`]: {
      status: 200,
      body: [
        { number: 7, pull_request: { url: `https://api.github.com${API}/pulls/7` } },
        { number: 3 },
        { number: 5 },
      ],
    },
  });

  expect(await github.openItems(REPO, 2)).toEqual({
    items: [
      { kind: "pr", number: 7 },
      { kind: "issue", number: 3 },
    ],
    more: true,
  });
  expect(Object.fromEntries(sent[0]!.query)).toEqual({
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: "3",
  });
});

test("the App finds only its own marked comment, and writes the marker", async () => {
  const bot = { performed_via_github_app: { id: APP_ID } };
  const { github, sent } = fakeApi({
    [`GET ${API}/issues/1/comments`]: {
      status: 200,
      body: [
        { id: 1, body: "<!-- bona-fide -->\nI copied the marker", performed_via_github_app: null },
        { id: 2, body: "Another comment from the App", ...bot },
        { id: 3, body: "<!-- bona-fide -->\n**Deposit needed**", ...bot },
      ],
    },
    [`POST ${API}/issues/1/comments`]: { status: 201, body: { id: 4 } },
    [`PATCH ${API}/issues/comments/3`]: { status: 200, body: { id: 3 } },
  });

  expect(await github.findOwnComment(REPO, 1)).toBe(3);
  await github.createComment(REPO, 1, "hello");
  await github.updateComment(REPO, 3, "edited");

  expect(sent[1]?.body).toEqual({ body: "<!-- bona-fide -->\nhello" });
  expect(sent[2]?.body).toEqual({ body: "<!-- bona-fide -->\nedited" });
});

test("the Keeper's note is its own comment: posted once, then edited, and never taken for the App's", async () => {
  const bot = { performed_via_github_app: { id: APP_ID } };
  const { github, sent } = fakeApi({
    [`GET ${API}/issues/1/comments`]: {
      status: 200,
      body: [{ id: 3, body: "<!-- bona-fide -->\n**Deposit needed**", ...bot }],
    },
    [`GET ${API}/issues/2/comments`]: {
      status: 200,
      body: [
        { id: 5, body: "<!-- bona-fide:keeper -->\nI copied the marker", performed_via_github_app: null },
        { id: 6, body: "<!-- bona-fide:keeper -->\nThe first note", ...bot },
      ],
    },
    [`POST ${API}/issues/1/comments`]: { status: 201, body: { id: 4 } },
    [`PATCH ${API}/issues/comments/6`]: { status: 200, body: { id: 6 } },
  });

  await github.postNote(REPO, 1, "A note");
  await github.postNote(REPO, 2, "A newer note");

  expect(sent.filter((s) => s.method !== "GET").map((s) => [`${s.method} ${s.path}`, s.body])).toEqual([
    [`POST ${API}/issues/1/comments`, { body: "<!-- bona-fide:keeper -->\nA note" }],
    [`PATCH ${API}/issues/comments/6`, { body: "<!-- bona-fide:keeper -->\nA newer note" }],
  ]);
  expect(await github.findOwnComment(REPO, 2)).toBeNull();
});

test("a triage note is a new comment of the App's, found by its marker, and never taken for another note", async () => {
  const bot = { performed_via_github_app: { id: APP_ID } };
  const marker = "<!-- bona-fide:triage serial=3 -->";
  const { github, sent } = fakeApi({
    [`GET ${API}/issues/1/comments`]: {
      status: 200,
      body: [
        { id: 3, body: "<!-- bona-fide -->\n**Deposit needed**", ...bot },
        { id: 5, body: "<!-- bona-fide:keeper -->\nThe Keeper's note", ...bot },
        { id: 6, body: "<!-- bona-fide:triage serial=31 -->\nAnother Deposit's", ...bot },
      ],
    },
    [`GET ${API}/issues/2/comments`]: {
      status: 200,
      body: [
        { id: 7, body: `${marker}\nI copied the marker`, performed_via_github_app: null },
        { id: 8, body: `${marker}\nThe suggestion`, ...bot },
      ],
    },
    [`POST ${API}/issues/1/comments`]: { status: 201, body: { id: 9 } },
  });

  expect(await github.hasNote(REPO, 1, marker)).toBe(false);
  expect(await github.hasNote(REPO, 2, marker)).toBe(true);
  await github.addNote(REPO, 1, marker, "A suggestion");

  expect(sent.filter((s) => s.method !== "GET").map((s) => [`${s.method} ${s.path}`, s.body])).toEqual([
    [`POST ${API}/issues/1/comments`, { body: `${marker}\nA suggestion` }],
  ]);
});

test("a PR's approvers are those whose latest standing review approves it", async () => {
  const review = (login: string, state: string) => ({ id: 1, user: { login }, state });
  const { github, sent } = fakeApi({
    [`GET ${API}/pulls/2/reviews`]: {
      status: 200,
      body: [
        review("mo", "APPROVED"),
        review("mo", "COMMENTED"),
        review("ann", "APPROVED"),
        review("ann", "CHANGES_REQUESTED"),
        review("bo", "APPROVED"),
        review("bo", "DISMISSED"),
        review("cy", "CHANGES_REQUESTED"),
        review("cy", "APPROVED"),
        review("dee", "PENDING"),
      ],
    },
  });

  expect(await github.approvers(REPO, 2)).toEqual(["mo", "cy"]);
  expect(sent[0]?.query.get("per_page")).toBe("100");
});

test("an issue's content is its title, body and the repo's description", async () => {
  const issue = fixture("issues.opened").issue;
  const { github } = fakeApi({
    [`GET ${API}`]: { status: 200, body: { description: "My first repo" } },
    [`GET ${API}/issues/1`]: { status: 200, body: { ...issue, title: "Spelling", body: null } },
  });

  expect(await github.contentOf(itemOf("issue", 1))).toEqual({
    title: "Spelling",
    body: "",
    repoDescription: "My first repo",
  });
});

test("a PR's content adds its first page of files, how many it changes, and its diff", async () => {
  const pr = fixture("pull_request.opened").pull_request;
  const diff = "diff --git a/README.md b/README.md\n-teh\n+the\n";
  const { github, sent } = fakeApi({
    [`GET ${API}`]: { status: 200, body: { description: null } },
    [`GET ${API}/pulls/2`]: (s) =>
      isDiff(s)
        ? { status: 200, body: diff }
        : { status: 200, body: { ...pr, title: "Fix", body: "Please", changed_files: 150 } },
    [`GET ${API}/pulls/2/files`]: {
      status: 200,
      body: [{ filename: "README.md", additions: 1, deletions: 1, status: "modified", patch: "-teh\n+the" }],
    },
  });

  expect(await github.contentOf(itemOf("pr", 2))).toEqual({
    title: "Fix",
    body: "Please",
    repoDescription: null,
    files: { listed: [{ path: "README.md", additions: 1, deletions: 1 }], total: 150 },
    diff,
  });
  expect(sent.find((s) => s.path.endsWith("/files"))?.query.get("per_page")).toBe("100");
});

test("a PR too large for GitHub to diff has no diff", async () => {
  const pr = fixture("pull_request.opened").pull_request;
  const { github } = fakeApi({
    [`GET ${API}`]: { status: 200, body: { description: null } },
    [`GET ${API}/pulls/2`]: (s) =>
      isDiff(s)
        ? { status: 406, body: { message: "Sorry, the diff exceeded the maximum number of files (300)." } }
        : { status: 200, body: { ...pr, changed_files: 3000 } },
    [`GET ${API}/pulls/2/files`]: { status: 200, body: [] },
  });

  expect((await github.contentOf(itemOf("pr", 2))).diff).toBeNull();
});

test("labels are added, and removing one that is gone is fine", async () => {
  const { github, sent } = fakeApi({ [`POST ${API}/issues/1/labels`]: { status: 200, body: [] } });

  await github.addLabel(REPO, 1, "bona-fide:deposit-required");
  await expect(github.removeLabel(REPO, 1, "bona-fide:deposit-required")).resolves.toBeUndefined();

  expect(sent[0]?.body).toEqual({ labels: ["bona-fide:deposit-required"] });
});

test("a repoId is traced to an installed repo, with whether it is private", async () => {
  const { github } = fakeApi({
    "GET /app/installations": { status: 200, body: [{ id: 1 }] },
    "GET /installation/repositories": {
      status: 200,
      body: {
        total_count: 1,
        repositories: [
          { name: "Hello-World", full_name: "Codertocat/Hello-World", owner: { login: "Codertocat" }, private: true },
        ],
      },
    },
  });

  expect(await github.findRepo(repoIdOf("codertocat/hello-world"))).toEqual({ ...REPO, private: true });
  expect(await github.findRepo(repoIdOf("someone/else"))).toBeNull();
});

test("a PR and an issue are read with their author, creation time, labels and head", async () => {
  const pr = fixture("pull_request.opened").pull_request;
  const issue = fixture("issues.opened").issue;
  const { github } = fakeApi({
    [`GET ${API}/pulls/2`]: { status: 200, body: pr },
    [`GET ${API}/issues/1`]: { status: 200, body: issue },
    [`GET ${API}/issues/2`]: { status: 200, body: { ...issue, number: 2, pull_request: { url: pr.url } } },
  });

  expect(await github.getItem(REPO, "pr", 2)).toEqual({
    repo: REPO,
    kind: "pr",
    number: 2,
    author: "Codertocat",
    createdAt: new Date("2019-05-15T15:20:33Z"),
    labels: ["bug"],
    headSha: "ec26c3e57ca3a959ca5aad62de7213c562f8c821",
  });
  expect(await github.getItem(REPO, "issue", 1)).toEqual({
    repo: REPO,
    kind: "issue",
    number: 1,
    author: "Codertocat",
    createdAt: new Date("2019-05-15T15:20:18Z"),
    labels: ["bug"],
  });
  expect(await github.getItem(REPO, "issue", 2)).toBeNull();
  expect(await github.getItem(REPO, "pr", 1)).toBeNull();
});

test("the App's Octokit logger drops expected 404s and keeps warnings", async () => {
  const sink = { warn: vi.fn() };
  const fetch = async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  const octokit = new Octokit({ auth: "test", request: { fetch }, log: quietLog(sink) });
  const github = createGitHub({ appId: APP_ID, app: octokit, installation: () => octokit });

  expect(await github.readFile(REPO, "VOUCHED.td")).toBeNull();
  octokit.log.warn("a deprecated endpoint");

  expect(sink.warn.mock.calls).toEqual([["a deprecated endpoint"]]);
});
