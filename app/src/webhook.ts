import type { App } from "./app.ts";
import type { Bounties } from "./bounties/bounties.ts";
import { CHECK_NAME } from "./github.ts";
import type { Keeper } from "./keeper/keeper.ts";
import { ACCEPTED, WAIVER } from "./labels.ts";
import type { Item, ItemFields, Repo } from "./ports.ts";

export interface WebhookDeps {
  secret: string;
  app: App;
  /** Hears every verified delivery, to refund on merges, completions and labels. */
  keeper?: Pick<Keeper, "onWebhook">;
  /** Hears every verified delivery, to pay a Bounty when a PR that closes its issue is merged. */
  bounties?: Pick<Bounties, "onWebhook">;
}

export function createWebhookHandler({
  secret,
  app,
  keeper,
  bounties,
}: WebhookDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const body = new Uint8Array(await request.arrayBuffer());
    if (!(await isSignedBy(secret, body, request.headers.get("x-hub-signature-256")))) {
      return new Response("Bad signature", { status: 401 });
    }
    const event = request.headers.get("x-github-event");
    const payload = JSON.parse(new TextDecoder().decode(body));
    const item = itemFrom(event, payload);
    // Reopening an item, like re-running its check, weighs its Contributor's record again.
    if (item) await app.settle(item, undefined, { askAgain: payload.action === "reopened" });
    const rerun = rerunFrom(event, payload);
    if (rerun) await app.recheck(rerun.repo, "pr", rerun.number, { askAgain: true });
    if (event === "check_suite" && payload.action === "rerequested") {
      await app.recheckSuite(repoOf(payload), payload.check_suite.id);
    }
    await keeper?.onWebhook(event, payload);
    await bounties?.onWebhook(event, payload);
    return new Response("OK", { status: 200 });
  };
}

// GitHub's webhook JSON; only the fields read below are relied on.
type Payload = any;

function itemFrom(event: string | null, payload: Payload): Item | null {
  const pr = payload.pull_request;
  if (event === "pull_request_review") {
    return approves(payload) ? { ...itemFields(payload, pr), kind: "pr", headSha: pr.head.sha } : null;
  }
  if (!concerns(payload)) return null;
  if (event === "pull_request") return { ...itemFields(payload, pr), kind: "pr", headSha: pr.head.sha };
  if (event === "issues") return { ...itemFields(payload, payload.issue), kind: "issue" };
  return null;
}

export function itemFields(payload: Payload, item: Payload): ItemFields {
  return {
    repo: repoOf(payload),
    number: item.number,
    author: item.user.login,
    authorId: item.user.id,
    createdAt: new Date(item.created_at),
    labels: item.labels.map((label: { name: string }) => label.name),
  };
}

// Someone pressed "Re-run" on the Bona Fide check. The App keeps the PR's number in the run's
// external_id, since GitHub lists no pull requests on the runs of a fork's commits.
function rerunFrom(event: string | null, payload: Payload): { repo: Repo; number: number } | null {
  const run = payload.check_run;
  if (event !== "check_run" || payload.action !== "rerequested" || run?.name !== CHECK_NAME) return null;
  const number = Number(run.external_id || run.pull_requests?.[0]?.number);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { repo: repoOf(payload), number };
}

export function repoOf(payload: Payload): Repo {
  return {
    owner: payload.repository.owner.login,
    name: payload.repository.name,
    installationId: payload.installation.id,
    private: payload.repository.private,
  };
}

function concerns(payload: Payload): boolean {
  if (["opened", "reopened", "synchronize"].includes(payload.action)) return true;
  const label = payload.label?.name;
  return (payload.action === "labeled" || payload.action === "unlabeled") && (label === WAIVER || label === ACCEPTED);
}

// An approval may accept the PR: the check reads who approved and whether they can push.
function approves(payload: Payload): boolean {
  return payload.action === "submitted" && String(payload.review?.state).toLowerCase() === "approved";
}

async function isSignedBy(secret: string, body: Uint8Array, header: string | null): Promise<boolean> {
  const hex = header?.match(/^sha256=([0-9a-f]{64})$/)?.[1];
  if (!hex) return false;
  const signature = new Uint8Array(hex.match(/../g)!.map((byte) => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature, body);
}
