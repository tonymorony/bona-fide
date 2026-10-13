import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Repo } from "../../src/ports.ts";

// Payloads recorded by GitHub, from octokit/webhooks payload-examples/api.github.com
// (commit bc5f6fd). The repo is Codertocat/Hello-World: PR #2 and issue #1.
// App deliveries always carry an installation; older examples lack one, so it is added here.

export const SECRET = "test-webhook-secret";
export const REPO = "Codertocat/Hello-World";
export const PR = 2;
export const ISSUE = 1;
export const HEAD_SHA = "ec26c3e57ca3a959ca5aad62de7213c562f8c821";
export const HELLO_WORLD: Repo = { owner: "Codertocat", name: "Hello-World", installationId: 1, private: false };
export const NEWCOMER = "newcomer";

export interface Overrides {
  author?: string;
  createdAt?: string;
  labels?: string[];
  label?: string;
  headSha?: string;
  /** Another "owner/name" for the repository. */
  repo?: string;
  /** Whether GitHub says the repository is private. The recorded ones are public. */
  private?: boolean;
}

type ItemEvent = "pull_request" | "issues";

export function payload(event: ItemEvent, action: string, o: Overrides = {}) {
  const p = fixture(`${event}.${action}`);
  p.installation ??= { id: 1, node_id: "MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9uMQ==" };
  const item = event === "pull_request" ? p.pull_request : p.issue;
  if (o.author) item.user.login = o.author;
  if (o.createdAt) item.created_at = o.createdAt;
  if (o.labels) item.labels = o.labels.map((name) => ({ id: 1, name, color: "ededed", default: false }));
  if (o.label) p.label = { ...p.label, name: o.label };
  if (o.headSha) item.head.sha = o.headSha;
  if (o.repo) {
    const [owner = "", name = ""] = o.repo.split("/");
    Object.assign(p.repository, { name, full_name: o.repo, owner: { ...p.repository.owner, login: owner } });
  }
  if (o.private !== undefined) p.repository.private = o.private;
  return p;
}

// GitHub's examples have no pull_request_review delivery for PR #2: this is the recorded opened one
// with the review a submission adds.
/** `reviewer` submitted a review of PR #2 in `state`: "approved", "changes_requested" or "commented". */
export function review(state: string, reviewer: string, o: Overrides = {}) {
  const p = payload("pull_request", "opened", o);
  p.action = "submitted";
  p.review = {
    id: 237895671,
    user: { login: reviewer, type: "User" },
    body: null,
    state,
    commit_id: p.pull_request.head.sha,
    submitted_at: "2019-05-15T15:30:00Z",
  };
  p.sender = { ...p.sender, login: reviewer };
  return p;
}

export interface RerunOverrides {
  checkName?: string;
  externalId?: string;
  /** Numbers of the PRs GitHub lists on the run. It lists none for a fork's commits. */
  pullRequests?: number[];
}

/** Someone pressed "Re-run" on a check on HEAD_SHA. The recorded run is in another repo, so it moves to Hello-World. */
export function rerun(o: RerunOverrides = {}) {
  const p = fixture("check_run.rerequested");
  p.repository = fixture("pull_request.opened").repository;
  Object.assign(p.check_run, {
    name: o.checkName ?? "Bona Fide",
    head_sha: HEAD_SHA,
    external_id: o.externalId ?? "",
    pull_requests: (o.pullRequests ?? []).map((number) => ({ number, head: { sha: HEAD_SHA } })),
  });
  return p;
}

/** The check suite of HEAD_SHA in the recorded check_suite deliveries. */
export const SUITE = 118578147;

/** Someone pressed "Re-run all checks" on the App's suite for HEAD_SHA, on a PR from a fork: GitHub lists no PRs. */
export function rerunAll() {
  const p = fixture("check_suite.rerequested");
  p.check_suite.pull_requests = [];
  return p;
}

export function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`../fixtures/webhooks/${name}.json`, import.meta.url), "utf8"));
}

export function signed(event: string, body: unknown, secret = SECRET): Request {
  const raw = JSON.stringify(body);
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  return new Request("https://app.example/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: raw,
  });
}
