import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Headless Chrome over the DevTools protocol, with no dependency beyond Chrome itself.
// CHROME overrides the browser binary.

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const STEP_TIMEOUT_MS = 20_000;

type Message = { id?: number; method?: string; params?: any; sessionId?: string; result?: any; error?: any };

export interface Viewport {
  width: number;
  height: number;
  mobile: boolean;
}

export const DESKTOP: Viewport = { width: 1280, height: 900, mobile: false };
export const PHONE: Viewport = { width: 390, height: 844, mobile: true };

function withTimeout<T>(promise: Promise<T>, what: string, ms = STEP_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function startChrome() {
  const profile = await mkdtemp(join(tmpdir(), "bona-fide-chrome-"));
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
  const endpoint = await withTimeout(
    new Promise<string>((resolve, reject) => {
      let output = "";
      chrome.stderr!.on("data", (chunk) => {
        output += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (match) resolve(match[1]!);
      });
      chrome.on("exit", (code) => reject(new Error(`Chrome exited with code ${code}: ${output}`)));
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
  const calls = new Map<number, { method: string; resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners = new Set<(message: Message) => void>();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as Message;
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
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
    withTimeout(
      new Promise((resolve, reject) => {
        const id = ++lastId;
        calls.set(id, { method, resolve, reject });
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      }),
      method,
    );

  return {
    /** A new tab. `onBinding` answers calls the page makes to `window[binding]`. */
    async newPage({
      binding,
      onBinding,
      injected,
      intercept,
    }: {
      binding?: string;
      onBinding?: (payload: string, reply: (expression: string) => Promise<void>) => void;
      injected?: string;
      /** Answers requests the page makes to these URL prefixes, instead of the network. */
      intercept?: Record<string, (url: string) => { status: number; body: string }>;
    } = {}) {
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const errors: string[] = [];
      const requests: string[] = [];
      let contextId: number | null = null;
      const on = (message: Message) => {
        if (message.sessionId !== sessionId) return;
        const { method, params } = message;
        if (method === "Runtime.executionContextCreated" && params.context.auxData?.isDefault) {
          contextId = params.context.id;
        } else if (method === "Runtime.consoleAPICalled" && (params.type === "error" || params.type === "assert")) {
          errors.push(`console.${params.type}: ${params.args.map((a: any) => a.value ?? a.description).join(" ")}`);
        } else if (method === "Runtime.exceptionThrown") {
          errors.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`);
        } else if (method === "Log.entryAdded" && params.entry.level === "error") {
          errors.push(`log: ${params.entry.text} ${params.entry.url ?? ""}`);
        } else if (method === "Network.requestWillBeSent") {
          requests.push(params.request.url);
        } else if (method === "Runtime.bindingCalled" && params.name === binding && onBinding) {
          const replyContext = params.executionContextId;
          onBinding(params.payload, async (expression) => {
            await send("Runtime.evaluate", { expression, contextId: replyContext }, sessionId).catch(() => {});
          });
        } else if (method === "Fetch.requestPaused") {
          const prefix = Object.keys(intercept ?? {}).find((p) => params.request.url.startsWith(p));
          if (!prefix) {
            void send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }, sessionId);
            return;
          }
          const { status, body } = intercept![prefix]!(params.request.url);
          void send(
            "Fetch.fulfillRequest",
            {
              requestId: params.requestId,
              responseCode: status,
              responseHeaders: [
                { name: "content-type", value: "text/plain; charset=utf-8" },
                { name: "access-control-allow-origin", value: "*" },
              ],
              body: Buffer.from(body).toString("base64"),
            },
            sessionId,
          );
        }
      };
      listeners.add(on);
      await send("Page.enable", {}, sessionId);
      await send("Runtime.enable", {}, sessionId);
      await send("Log.enable", {}, sessionId);
      await send("Network.enable", {}, sessionId);
      if (intercept) {
        const patterns = Object.keys(intercept).map((prefix) => ({ urlPattern: `${prefix}*` }));
        await send("Fetch.enable", { patterns }, sessionId);
      }
      if (binding) await send("Runtime.addBinding", { name: binding }, sessionId);
      if (injected) await send("Page.addScriptToEvaluateOnNewDocument", { source: injected }, sessionId);

      async function evaluate<T>(expression: string): Promise<T> {
        const { result, exceptionDetails } = await send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) },
          sessionId,
        );
        if (exceptionDetails) throw new Error(`${expression}: ${exceptionDetails.exception?.description}`);
        return result.value as T;
      }

      return {
        errors,
        requests,

        /** Runs the page without its scripts, as before they load or with JavaScript off. */
        async withoutScripts() {
          await send("Emulation.setScriptExecutionDisabled", { value: true }, sessionId);
        },

        async open(url: string, viewport: Viewport = DESKTOP, scheme: "light" | "dark" = "light") {
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
          contextId = null;
          const loaded = new Promise<void>((resolve) => {
            const listener = (message: Message) => {
              if (message.sessionId !== sessionId || message.method !== "Page.loadEventFired") return;
              listeners.delete(listener);
              resolve();
            };
            listeners.add(listener);
          });
          await send("Page.navigate", { url }, sessionId);
          await withTimeout(loaded, `Loading ${url}`);
        },

        evaluate,

        /** Waits until `expression` is truthy in the page, and returns its value. */
        async waitFor<T>(expression: string, what = expression, timeoutMs = STEP_TIMEOUT_MS): Promise<T> {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const value = await evaluate<T>(expression).catch(() => null);
            if (value) return value;
            if (Date.now() > deadline) {
              const state = await evaluate<string>("document.documentElement.dataset.state").catch(() => "?");
              throw new Error(`Timed out waiting for ${what} (page state: ${state}; errors: ${errors.join(" | ")})`);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        },

        /** Waits for the page's state, as `<html data-state>` names it. */
        waitForState(state: string, timeoutMs?: number) {
          return this.waitFor(
            `document.documentElement.dataset.state === ${JSON.stringify(state)}`,
            `state ${state}`,
            timeoutMs,
          );
        },

        /** Clicks the first visible element matching `selector`. */
        async click(selector: string) {
          const clicked = await this.waitFor<boolean>(
            `(() => {
              const el = [...document.querySelectorAll(${JSON.stringify(selector)})]
                .find((e) => e.offsetParent !== null && !e.disabled);
              if (!el) return false;
              el.click();
              return true;
            })()`,
            `a clickable ${selector}`,
          );
          return clicked;
        },

        /** The text of the visible parts of the page. */
        text(): Promise<string> {
          return evaluate<string>("document.body.innerText");
        },

        /** How far the page is wider than the viewport: 0 means no sideways scroll. */
        overflow(): Promise<number> {
          return evaluate<number>("document.documentElement.scrollWidth - window.innerWidth");
        },

        async screenshot(path: string) {
          const height = await evaluate<number>("Math.ceil(document.documentElement.scrollHeight)");
          const { data } = await send(
            "Page.captureScreenshot",
            {
              format: "png",
              captureBeyondViewport: true,
              clip: {
                x: 0,
                y: 0,
                width: await evaluate<number>("window.innerWidth"),
                height,
                scale: 1,
              },
            },
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

    async stop() {
      socket.close();
      const exited = new Promise((resolve) => chrome.once("exit", resolve));
      chrome.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
}

export type Chrome = Awaited<ReturnType<typeof startChrome>>;
export type Page = Awaited<ReturnType<Chrome["newPage"]>>;
