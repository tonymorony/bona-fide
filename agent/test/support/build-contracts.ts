import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  execFileSync("forge", ["build"], {
    cwd: fileURLToPath(new URL("../../../contracts/", import.meta.url)),
    stdio: "ignore",
  });
}
