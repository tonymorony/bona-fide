import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["test/support/build-contracts.ts"],
  },
});
