import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer, type ServerOptions } from "../../src/server.ts";

/** A real MCP client connected in-process to the server, as a host such as Claude Code would use it. */
export async function connect(options: ServerOptions) {
  const handler = createMcpHandler(() => createServer(options));
  const client = new Client({ name: "test-host", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://agent.test/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return {
    client,
    call: (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }),
    async close() {
      await client.close();
      await handler.close();
    },
  };
}

/** The text a tool result shows the model. */
export function textOf(result: { content?: unknown }): string {
  const content = (result.content ?? []) as { type: string; text?: string }[];
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
