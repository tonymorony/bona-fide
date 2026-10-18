import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const APP = fileURLToPath(new URL("../../../app/", import.meta.url));

// The tests deploy the real escrow from the Foundry artifacts and run the App's relay and Keeper.
export default function setup(): void {
  if (!existsSync(`${APP}../node_modules`))
    throw new Error("These tests run the App: run `npm ci` at the repo root first.");
  if (!existsSync(`${CONTRACTS}lib/forge-std/src`)) {
    throw new Error("The contracts need their submodules: run `git submodule update --init --recursive`.");
  }
  execFileSync("forge", ["build"], { cwd: CONTRACTS, stdio: "ignore" });
}
