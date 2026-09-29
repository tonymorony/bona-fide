import { createApp } from "../../src/app.ts";
import type { Binding } from "../../src/ports.ts";
import { createWebhookHandler } from "../../src/webhook.ts";
import { FakeChain } from "./fake-chain.ts";
import { FakeGitHub } from "./fake-github.ts";
import { REPO, SECRET, signed } from "./webhooks.ts";

export const DEPOSIT_PAGE = "https://bonafide.example/deposit";
export const SETUP_PAGE = "https://bonafide.example/setup";

export interface HarnessOptions {
  /** The text of .github/bona-fide.yml; without it the repo has no config. */
  config?: string;
  /** The repo's active Binding: 1 USDC, 50% and 7 days unless given other terms. `null` leaves the repo unbound. */
  binding?: Partial<Binding> | null;
  /** When the Binding took effect: by default long before any PR or issue was opened. */
  startedAt?: Date;
  /** The App's clock. */
  now?: Date;
  /** The block explorer the App links Deposits to, if not Arc mainnet's. */
  explorerUrl?: string;
}

export function harness({ config, binding = {}, startedAt, now, explorerUrl }: HarnessOptions = {}) {
  const github = new FakeGitHub();
  const chain = new FakeChain();
  github.addRepo(REPO);
  if (config !== undefined) github.setFile(REPO, ".github/bona-fide.yml", config);
  if (binding !== null) chain.bind(REPO, binding, startedAt);
  const app = createApp({
    github,
    chain,
    depositPageUrl: DEPOSIT_PAGE,
    setupPageUrl: SETUP_PAGE,
    explorerUrl,
    ...(now ? { now: () => now } : {}),
  });
  const handle = createWebhookHandler({ secret: SECRET, app });
  const deliver = (event: string, body: unknown) => handle(signed(event, body));
  return { github, chain, app, handle, deliver };
}
