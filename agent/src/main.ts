// Runs the Bona Fide MCP server over stdio, for hosts such as Claude Code.
// Start it with `node src/main.ts`; Node 24 runs the TypeScript directly. stdout carries the protocol,
// so everything else goes to stderr.

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPublicClient, http } from "viem";
import { loadConfig, type Config } from "./config.ts";
import { createServer } from "./server.ts";

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const client = createPublicClient({ transport: http(config.rpcUrl) });
serveStdio(() => createServer({ client, ...config }));
console.error("Bona Fide MCP server running on stdio");
