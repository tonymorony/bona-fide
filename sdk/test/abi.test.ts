import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { ABI_MODULE, renderAbiModule } from "../scripts/abi.ts";

test("src/abi.ts is what `npm run abi` writes from the current Foundry artifacts", async () => {
  expect(await readFile(ABI_MODULE, "utf8")).toBe(await renderAbiModule());
});
