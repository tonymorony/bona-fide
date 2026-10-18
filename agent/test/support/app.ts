import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { freePort } from "./chain.ts";

const APP = fileURLToPath(new URL("../../../app/", import.meta.url));

/** Runs the Bona Fide App's Node host, with its deposit relay, as a separate process. */
export async function startApp({ rpcUrl, escrow, relayerKey }: { rpcUrl: string; escrow: Address; relayerKey: Hex }) {
  if (!existsSync(`${APP}../node_modules`))
    throw new Error("This test runs the App: run `npm ci` at the repo root first.");
  const port = await freePort();
  const app = spawn(process.execPath, ["src/node.ts"], {
    cwd: APP,
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      RPC_URL: rpcUrl,
      ESCROW_ADDRESS: escrow,
      RELAYER_PRIVATE_KEY: relayerKey,
      WEBHOOK_SECRET: "not used here",
      GITHUB_APP_ID: "1",
      GITHUB_PRIVATE_KEY: "not used here",
      DEPOSIT_PAGE_URL: "https://app.test/deposit",
      SETUP_PAGE_URL: "https://app.test/setup",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  app.stdout.on("data", (chunk) => (output += chunk));
  app.stderr.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 15_000;
  while (!output.includes("listening") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (!output.includes("listening")) throw new Error(`The App didn't start:\n${output}`);
  return {
    url: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: () => app.kill(),
  };
}
