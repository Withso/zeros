import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

it("includes the pinned Chromium native dependencies and fonts in the v4 base recipe", () => {
  const require = createRequire(import.meta.url);
  const playwright = path.dirname(require.resolve("playwright-core/package.json"));
  const { deps } = require(path.join(playwright, "lib/server/registry/nativeDeps.js"));
  const native = deps["ubuntu24.04-x64"] as { chromium: string[]; tools: string[] };
  const recipe = readFileSync(new URL("../cloud-workspace-validation/boat-image/templates/v4/build.sh", import.meta.url), "utf8");
  const packages = new Set(recipe.replace(/\\\n/g, " ").match(/apt-get install[^\n]*/)?.[0].split(/\s+/));
  const required = [...native.chromium, ...native.tools];
  expect(required.length).toBeGreaterThan(0);
  expect(required.filter(name => !packages.has(name))).toEqual([]);
  // This is dependency coverage only; actual UID/sandbox PNG rendering must
  // pass qualify-cloud-capture.ts inside an installed v4 runtime.
});
