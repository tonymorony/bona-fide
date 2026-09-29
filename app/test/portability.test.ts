import { rolldown } from "rolldown";
import { expect, test } from "vitest";

// Workers run web APIs, not Node's. Everything the package exports must bundle without them;
// only src/node.ts, the Node host, may use Node.
test("the App bundles for a Workers-style runtime without Node built-ins", async () => {
  const bundle = await rolldown({ input: "src/index.ts", platform: "browser", logLevel: "silent" });
  const { output } = await bundle.generate({ format: "esm" });
  const code = output.map((chunk) => ("code" in chunk ? chunk.code : "")).join("\n");

  expect(code).not.toMatch(/["']node:/);
  // A member access such as process.env, not prose such as "too large for the Wallet to process."
  expect(code).not.toMatch(/\b(Buffer|process)\.[A-Za-z_$]/);
});
