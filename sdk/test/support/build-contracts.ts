import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));

// The tests read the Foundry artifacts and deploy the real contracts to anvil.
export default function setup(): void {
  if (!existsSync(`${CONTRACTS}lib/forge-std/src`)) {
    throw new Error("The contracts need their submodules: run `git submodule update --init --recursive`.");
  }
  execFileSync("forge", ["build"], { cwd: CONTRACTS, stdio: "ignore" });
}
