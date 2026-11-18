import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Release jobs install only the root workspace. A release CLI that reaches a control-plane runtime module (and so `pg`)
// fails at start: Release (alpha) failed on every merge after #1132 with "Cannot find module 'pg'".
const root = resolve(import.meta.dirname, "../.."), runtimeOnly = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
function bareImports(entry: string): Set<string> {
  const seen = new Set<string>(), bare = new Set<string>(), stack = [resolve(root, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, spec] of readFileSync(file, "utf8").matchAll(runtimeOnly)) {
      if (!spec!.startsWith(".")) { bare.add(spec!); continue; }
      const base = resolve(dirname(file), spec!).replace(/\.js$/, "");
      const found = [`${base}.ts`, `${base}.mts`, `${base}/index.ts`].find(existsSync);
      if (found) stack.push(found);
    }
  }
  return bare;
}

describe("release CLIs run with the root workspace's dependencies only", () => {
  // candidate-cli: 0.1.30's first rc publication failed on `pg` in release.yml's publish job.
  it.each(["scripts/release/ci-cli.ts", "scripts/release/cli.ts", "scripts/release/cutover-cli.ts", "scripts/release/candidate-cli.ts",
    "scripts/release/release-ledger-cli.ts", "scripts/release/publication-cli.ts"])("%s never loads pg", entry => {
    expect(bareImports(entry).has("pg")).toBe(false);
  });
});
