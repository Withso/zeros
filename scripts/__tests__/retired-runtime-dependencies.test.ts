import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("retired sandbox dependency and verification graph", () => {
  it("removes SRT from the declared and locked graph without removing providers", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty(
      "@anthropic-ai/sandbox-runtime",
    );
    for (const provider of [
      "@anthropic-ai/claude-agent-sdk",
      "@openai/codex",
      "@cursor/sdk",
    ]) {
      expect(pkg.dependencies[provider]).toMatch(/^\d+\.\d+\.\d+/);
    }
    expect(read("pnpm-lock.yaml")).not.toContain(
      "@anthropic-ai/sandbox-runtime",
    );
  });

  it("removes the SRT-only Forge patch and conditional audit exception", () => {
    const workspace = load(read("pnpm-workspace.yaml")) as {
      patchedDependencies: Record<string, string>;
      auditConfig?: { ignoreGhsas?: string[] };
    };
    for (const retired of [
      "@anthropic-ai/sandbox-runtime@0.0.78",
      "node-forge@1.4.0",
    ]) {
      expect(Object.keys(workspace.patchedDependencies)).not.toContain(retired);
    }
    expect(workspace.auditConfig?.ignoreGhsas ?? []).not.toContain(
      "GHSA-86w9-cpqp-85rv",
    );
    expect(Object.keys(workspace.patchedDependencies)).toContain("ssh2@1.17.0");
    expect(Object.keys(workspace.patchedDependencies)).toContain(
      "app-builder-lib@26.8.1",
    );
    for (const file of [
      "patches/@anthropic-ai__sandbox-runtime@0.0.78.patch",
      "patches/node-forge@1.4.0.patch",
      "scripts/check-node-forge-patch.mjs",
      "scripts/node-forge-patch.json",
      "scripts/zsr-qualification/pin.json",
    ]) {
      expect(existsSync(path.join(root, file)), file).toBe(false);
    }
  });

  it("retains provider artifact/permission checks without obsolete sandbox verification", () => {
    const pins = read("scripts/check-runtime-pins.mjs");
    expect(pins).not.toMatch(
      /sandbox-runtime|checkSandboxRuntime|verifyNodeForgePatch|all-tool Design containment/,
    );
    for (const check of [
      "checkClaudeArtifact",
      "checkCodexTriple",
      "checkPins",
    ])
      expect(pins).toContain(check);
    expect(pins).toContain("Edit(path)");
    expect(read("scripts/check-audit.mjs")).not.toContain(
      "verifyNodeForgePatch",
    );
    expect(read("renovate.json")).not.toContain(
      "@anthropic-ai/sandbox-runtime",
    );
  });

  it("does not ship notices or a production license entry for deleted SRT", () => {
    expect(read("THIRD-PARTY-NOTICES.md")).not.toMatch(
      /Zeros Sandbox Runtime dependency|Forge RSA verifier security backport/,
    );
    expect(read("THIRD-PARTY-LICENSES.txt")).not.toContain(
      "@anthropic-ai/sandbox-runtime",
    );
  });
});
