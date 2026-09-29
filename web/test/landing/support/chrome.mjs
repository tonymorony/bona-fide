// Headless Chrome over the DevTools protocol, with no dependency beyond Chrome itself. CHROME points
// at another Chrome binary.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STEP_TIMEOUT_MS = 20_000;

export const DESKTOP = { width: 1280, height: 900, mobile: false };
export const PHONE = { width: 390, height: 844, mobile: true };

const CORS = [
  { name: "access-control-allow-origin", value: "*" },
  { name: "access-control-allow-methods", value: "POST, OPTIONS" },
  { name: "access-control-allow-headers", value: "content-type" },
];

function withTimeout(promise, what, ms = STEP_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function startChrome() {
  const profile = await mkdtemp(join(tmpdir(), "bona-fide-landing-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  const endpoint = await withTimeout(
    new Promise((resolve, reject) => {
      let output = "";
      chrome.stderr.on("data", (chunk) => {
        output += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) resolve(match[1]);
      });
      chrome.once("exit", (code) => reject(new Error(`Chrome exited with code ${code}: ${output}`)));
    }),
    "Starting Chrome",
  );
  const socket = new WebSocket(endpoint);
  await withTimeout(
    new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("Can't reach Chrome's DevTools endpoint"));
    }),
    "Connecting to Chrome",
  );

  let lastId = 0;
  const calls = new Map();
  const listeners = new Set();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data));
    if (message.id === undefined) {
      for (const listener of listeners) listener(message);
      return;
    }
    const call = calls.get(message.id);
    calls.delete(message.id);
    if (!call) return;
    if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}`));
    else call.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = ++lastId;
        calls.set(id, { method, resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
      method,
    );

  return {
    /**
     * A new tab. `intercept` maps URL prefixes to handlers that answer the page's requests to them
     * instead of the network: `(body) => string` answers 200 with that JSON, and `() => null` fails
     * the request as if nothing answered.
     */
    async newPage({ intercept = {} } = {}) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const errors = [];
      const networkErrors = [];
      const requests = [];
      const on = (message) => {
        if (message.sessionId !== sessionId) return;
        const { method, params } = message;
        if (method === "Runtime.consoleAPICalled" && ["error", "assert", "warning"].includes(params.type)) {
          errors.push(`console.${params.type}: ${params.args.map((a) => a.value ?? a.description).join(" ")}`);
        } else if (method === "Runtime.exceptionThrown") {
          errors.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
        } else if (method === "Log.entryAdded" && ["error", "warning"].includes(params.entry.level)) {
          const entry = `${params.entry.source}: ${params.entry.text} ${params.entry.url ?? ""}`.trim();
          (params.entry.source === "network" ? networkErrors : errors).push(entry);
        } else if (method === "Network.requestWillBeSent") {
          requests.push({ url: params.request.url, method: params.request.method });
        } else if (method === "Fetch.requestPaused") {
          answer(params).catch(() => {});
        }
      };
      async function answer({ requestId, request }) {
        const fail = (errorReason) => send("Fetch.failRequest", { requestId, errorReason }, sessionId);
        const prefix = Object.keys(intercept).find((p) => request.url.startsWith(p));
        if (!prefix) return fail("BlockedByClient");
        if (request.method === "OPTIONS") {
          return send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: CORS }, sessionId);
        }
        const body =
          request.postData ??
          (request.postDataEntries ?? []).map((entry) => Buffer.from(entry.bytes ?? "", "base64").toString()).join("");
        const reply = await Promise.resolve()
          .then(() => intercept[prefix](body))
          .catch(() => null);
        if (reply === null) return fail("ConnectionRefused");
        return send(
          "Fetch.fulfillRequest",
          {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "application/json" }, ...CORS],
            body: Buffer.from(reply).toString("base64"),
          },
          sessionId,
        );
      }
      listeners.add(on);
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Log.enable", {}, sessionId);
      await send("Network.enable", {}, sessionId);
      const patterns = Object.keys(intercept).map((prefix) => ({ urlPattern: `${prefix}*` }));
      if (patterns.length > 0) await send("Fetch.enable", { patterns }, sessionId);

      async function evaluate(expression) {
        const { result, exceptionDetails } = await send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        );
        if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description}`);
        return result.value;
      }

      return {
        errors,
        networkErrors,
        requests,
        evaluate,

        async withoutScripts() {
          await send("Emulation.setScriptExecutionDisabled", { value: true }, sessionId);
        },

        async open(url, viewport = DESKTOP, scheme = "light") {
          await send(
            "Emulation.setEmulatedMedia",
            { features: [{ name: "prefers-color-scheme", value: scheme }] },
            sessionId,
          );
          await send(
            "Emulation.setDeviceMetricsOverride",
            {
              width: viewport.width,
              height: viewport.height,
              deviceScaleFactor: viewport.mobile ? 2 : 1,
              mobile: viewport.mobile,
            },
            sessionId,
          );
          const loaded = new Promise((resolve) => {
            const onLoad = (message) => {
              if (message.sessionId === sessionId && message.method === "Page.loadEventFired") {
                listeners.delete(onLoad);
                resolve();
              }
            };
            listeners.add(onLoad);
          });
          await send("Page.navigate", { url }, sessionId);
          await withTimeout(loaded, `Loading ${url}`);
        },

        /** Waits until `expression` is truthy in the page, and returns its value. */
        async waitFor(expression, what = expression, timeoutMs = 10_000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const value = await evaluate(expression).catch(() => undefined);
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        },

        /** Saves a PNG of the whole page, or of the element `selector` finds. */
        async screenshot(path, selector) {
          const { cssContentSize } = await send("Page.getLayoutMetrics", {}, sessionId);
          const clip = selector
            ? await evaluate(
                `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }; })()`,
              )
            : { x: 0, y: 0, width: cssContentSize.width, height: Math.ceil(cssContentSize.height) };
          const { data } = await send(
            "Page.captureScreenshot",
            { format: "png", captureBeyondViewport: true, clip: { ...clip, scale: 1 } },
            sessionId,
          );
          await writeFile(path, Buffer.from(data, "base64"));
        },

        async close() {
          listeners.delete(on);
          await send("Target.closeTarget", { targetId }).catch(() => {});
        },
      };
    },

    async close() {
      await send("Browser.close").catch(() => {});
      socket.close();
      await withTimeout(exited, "Closing Chrome", 10_000).catch(() => chrome.kill("SIGKILL"));
      await rm(profile, { recursive: true, force: true });
    },
  };
}
