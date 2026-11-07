import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The Bun release builds compile the engine with: the setup-bun pin the
 * release workflow uses (scripts/__tests__/renovate-coverage.test.ts keeps
 * every workflow on that one version). */
export function releaseBunVersion(repoRoot) {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
  const version = /^\s+bun-version:\s*(\d+\.\d+\.\d+)\s*$/m.exec(workflow)?.[1];
  if (!version) throw new Error("No bun-version pin in .github/workflows/release.yml.");
  return version;
}

/** Null when `actual` may build the sidecar; otherwise why not. A local build
 * embeds the runtime it was compiled with, so a different Bun than releases
 * ship would make crashes there unreproducible in a release. */
export function sidecarBunMismatch(actual, pinned, env = process.env) {
  if (actual === pinned || env.ZEROS_SIDECAR_ANY_BUN === "1") return null;
  return `bun ${actual} differs from the release pin ${pinned} (.github/workflows/release.yml). ` +
    `Install bun ${pinned}, or set ZEROS_SIDECAR_ANY_BUN=1 to build with ${actual} anyway.`;
}
