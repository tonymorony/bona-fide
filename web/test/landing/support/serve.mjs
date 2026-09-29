// Serves web/landing/ over HTTP on 127.0.0.1, as Caddy's file_server would. `replace` answers some
// paths with other content, such as a config.js for a local chain.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export const LANDING = fileURLToPath(new URL("../../../landing/", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export async function serveLanding({ replace = {} } = {}) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const file = path.endsWith("/") ? `${path}index.html` : path;
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    try {
      const body =
        file in replace ? replace[file] : await readFile(join(LANDING, normalize(file).replace(/^(\.\.[/\\])+/, "")));
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("Not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
