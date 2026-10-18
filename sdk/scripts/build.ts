// Builds the npm package into dist/: JavaScript, type declarations and source maps compiled from
// src/, with a package.json that points at them. In this repo, the App, the agent and the pages
// import src/ directly, so nothing here needs a build. To publish:
//
//   npm run build && npm publish ./dist

import { execFileSync } from "node:child_process";
import { copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SDK = fileURLToPath(new URL("../", import.meta.url));
const DIST = `${SDK}dist/`;

await rm(DIST, { recursive: true, force: true });
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: SDK, stdio: "inherit" });

// The workspace's manifest, minus what only the workspace uses, pointing at the compiled files.
const published = JSON.parse(await readFile(`${SDK}package.json`, "utf8"));
for (const key of ["private", "scripts", "devDependencies"]) delete published[key];
published.exports = {
  ".": { types: "./index.d.ts", default: "./index.js" },
  "./package.json": "./package.json",
};
await writeFile(`${DIST}package.json`, `${JSON.stringify(published, null, 2)}\n`);
await copyFile(`${SDK}README.md`, `${DIST}README.md`);
await copyFile(`${SDK}../LICENSE`, `${DIST}LICENSE`);
console.log(`Built ${published.name}@${published.version} in ${DIST}`);
