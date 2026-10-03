import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const check = path.resolve("scripts/check-codex-pin.mjs");

function runCheck(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-codex-pin-"));
  const generated = "apps/desktop/src/engine/agents/adapters/codex/generated";
  const files = {
    "package.json": JSON.stringify({ codexProtocolVersion: "0.160.0" }),
    "node_modules/@openai/codex/package.json": JSON.stringify({ version: "0.160.0" }),
    [`${generated}/.version`]: "0.160.0\n",
    [`${generated}/LICENSE`]: "Apache License",
    [`${generated}/NOTICE`]: "OpenAI Codex",
    "apps/control-plane/package.json": JSON.stringify({ dependencies: { "@openai/codex": "0.154.0" } }),
    "apps/control-plane/src/cloud-workspaces/codex-auth-cache.ts": 'export const CODEX_AUTH_RUNTIME_VERSION="0.154.0";',
    ...overrides,
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const result = spawnSync(process.execPath, [check], { cwd: root, encoding: "utf8" });
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Codex runtime qualification pins", () => {
  it("allows the interactive runtime to advance without invalidating the qualified auth-cache format", () => {
    expect(runCheck()).toMatchObject({ status: 0 });
  });

  it("still rejects an interactive binary that differs from its generated protocol", () => {
    const result = runCheck({
      "node_modules/@openai/codex/package.json": JSON.stringify({ version: "0.159.0" }),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("protocol triple is out of sync");
  });

  it("rejects an auth helper bump without its separately qualified cache version", () => {
    const result = runCheck({
      "apps/control-plane/package.json": JSON.stringify({ dependencies: { "@openai/codex": "0.160.0" } }),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("control-plane native keeper");
  });

  it("rejects missing keeper pins rather than comparing two absent values", () => {
    const result = runCheck({
      "apps/control-plane/package.json": "{}",
      "apps/control-plane/src/cloud-workspaces/codex-auth-cache.ts": "",
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("control-plane native keeper");
  });
});
