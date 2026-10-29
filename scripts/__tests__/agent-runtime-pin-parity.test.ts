import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Local and the standalone cloud worker run the same agent runtimes: one exact
// version per provider, in both manifests and in the worker's runtime checks.
// A provider update that moves only one side (as Cursor 1.1.0 once did) fails.
const root = join(import.meta.dirname, "..", "..");
const RUNTIMES = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-agent-sdk",
  cursor: "@cursor/sdk",
} as const;

function dependencies(path: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  return { ...manifest.devDependencies, ...manifest.optionalDependencies, ...manifest.dependencies };
}

describe("agent runtime pin parity", () => {
  const local = dependencies("package.json");
  const cloud = dependencies("apps/cloud-worker/package.json");

  it.each(Object.entries(RUNTIMES))("pins %s identically and exactly for Local and the cloud worker", (_provider, name) => {
    expect(local[name], `${name} in package.json`).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cloud[name], `${name} in apps/cloud-worker/package.json`).toBe(local[name]);
  });

  it("keeps the worker's runtime checks on the same versions", () => {
    const agents = readFileSync(join(root, "apps/cloud-worker/src/agents.ts"), "utf8");
    const versions = /const VERSIONS = \{([^}]*)\}/.exec(agents)?.[1] ?? "";
    for (const [provider, name] of Object.entries(RUNTIMES))
      expect(new RegExp(`\\b${provider}: "([^"]+)"`).exec(versions)?.[1], `VERSIONS.${provider}`).toBe(local[name]);
    const cursorHost = readFileSync(join(root, "apps/cloud-worker/src/drivers/cursor/native-types.ts"), "utf8");
    expect(/export const CURSOR_VERSION = "([^"]+)"/.exec(cursorHost)?.[1]).toBe(local[RUNTIMES.cursor]);
  });

  it("keeps the Codex protocol bindings on the Local CLI pin", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { codexProtocolVersion?: string };
    expect(manifest.codexProtocolVersion).toBe(local[RUNTIMES.codex]);
  });
});
