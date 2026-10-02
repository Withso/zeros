import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const rootRequire = createRequire(import.meta.url);

describe("shared audit CLI independent graph boundary", () => {
  let fixtureRoot: string;
  let controlPlane: string;
  let binDirectory: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), "zeros-audit-graph-"));
    controlPlane = join(fixtureRoot, "apps/control-plane");
    binDirectory = join(fixtureRoot, "bin");
    for (const filename of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "scripts/check-audit.mjs",
      "scripts/check-node-forge-patch.mjs",
      "scripts/node-forge-patch.json",
      "patches/node-forge@1.4.0.patch",
      "apps/control-plane/package.json",
      "apps/control-plane/pnpm-lock.yaml",
      "apps/control-plane/pnpm-workspace.yaml",
    ]) {
      const destination = join(fixtureRoot, filename);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(root, filename), destination);
    }
    symlinkSync(
      join(root, "apps/control-plane/node_modules"),
      join(controlPlane, "node_modules"),
      "dir",
    );
    mkdirSync(binDirectory);
    writeFileSync(join(fixtureRoot, "audit-config.json"), "{}\n");
    writeFileSync(
      join(fixtureRoot, "audit-result.json"),
      JSON.stringify({ exitCode: 0, output: "found 0 vulnerabilities" }),
    );
    writeFileSync(
      join(binDirectory, "pnpm"),
      `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const fixture = ${JSON.stringify(fixtureRoot)};
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(["config", "get", "auditConfig", "--json"])) {
  process.stdout.write(readFileSync(join(fixture, "audit-config.json"), "utf8"));
} else if (JSON.stringify(args) === JSON.stringify(["audit", "--prod", "--audit-level=high"])) {
  appendFileSync(join(fixture, "audit-receipts.jsonl"), JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
  const result = JSON.parse(readFileSync(join(fixture, "audit-result.json"), "utf8"));
  process.stdout.write(result.output + "\\n");
  process.exitCode = result.exitCode;
} else {
  throw new Error("Unexpected package-manager invocation");
}
`,
      { mode: 0o755 },
    );
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function invoke(cwd: string) {
    return spawnSync(
      process.execPath,
      [resolve(fixtureRoot, "scripts/check-audit.mjs")],
      {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH}`,
          NODE_PATH: "",
        },
      },
    );
  }

  function receipts(): { cwd: string; args: string[] }[] {
    const filename = join(fixtureRoot, "audit-receipts.jsonl");
    if (!existsSync(filename)) return [];
    return readFileSync(filename, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  }

  it("audits the isolated control-plane install without resolving root Forge", () => {
    expect(existsSync(join(fixtureRoot, "node_modules"))).toBe(false);
    expect(existsSync(join(controlPlane, "node_modules"))).toBe(true);
    const result = invoke(controlPlane);
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
    expect(result.status).toBe(0);
    expect(receipts()).toEqual([
      { cwd: controlPlane, args: ["audit", "--prod", "--audit-level=high"] },
    ]);
  });

  it("never skips the root guard just because desktop dependencies are missing", () => {
    mkdirSync(join(fixtureRoot, "node_modules"));
    symlinkSync(
      dirname(rootRequire.resolve("js-yaml/package.json")),
      join(fixtureRoot, "node_modules/js-yaml"),
      "dir",
    );
    const result = invoke(fixtureRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain("@anthropic-ai/sandbox-runtime");
    expect(receipts()).toEqual([]);
  });

  it("fails closed when the explicit root verifier tooling is not installed", () => {
    const result = invoke(fixtureRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain("js-yaml");
    expect(receipts()).toEqual([]);
  });

  it.each(["apps/marketing", "packages/protocol", "nested/apps/control-plane"])(
    "rejects unknown/wrong audit boundary %s before registry execution",
    (directory) => {
      const cwd = join(fixtureRoot, directory);
      mkdirSync(cwd, { recursive: true });
      const result = invoke(cwd);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unsupported audit working directory");
      expect(receipts()).toEqual([]);
    },
  );

  it.each([
    ["GHSA", { ignoreGhsas: ["GHSA-86w9-cpqp-85rv"] }],
    ["CVE", { ignoreCves: ["CVE-2026-85393"] }],
  ])("rejects an unguarded standalone Forge %s exception", (_name, config) => {
    writeFileSync(join(fixtureRoot, "audit-config.json"), JSON.stringify(config));
    const result = invoke(controlPlane);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Control-plane audit cannot ignore the Forge advisory");
    expect(receipts()).toEqual([]);
  });

  it("retains unrelated standalone advisory configuration and the actual audit", () => {
    writeFileSync(
      join(fixtureRoot, "audit-config.json"),
      JSON.stringify({ ignoreGhsas: ["GHSA-vrm6-8vpv-qv8q"] }),
    );
    const result = invoke(controlPlane);
    expect(result.status).toBe(0);
    expect(receipts()).toHaveLength(1);
  });

  it("accepts pnpm's empty output when standalone auditConfig is absent", () => {
    writeFileSync(join(fixtureRoot, "audit-config.json"), "");
    const result = invoke(controlPlane);
    expect(result.status).toBe(0);
    expect(receipts()).toHaveLength(1);
  });

  it.each(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])(
    "rejects a missing independent graph boundary file %s",
    (filename) => {
      rmSync(join(controlPlane, filename));
      const result = invoke(controlPlane);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Control-plane audit boundary");
      expect(receipts()).toEqual([]);
    },
  );

  it.each([
    "not-json",
    '"not-an-object"',
    "null",
    "[]",
    '{"ignoreGhsas":"GHSA-86w9-cpqp-85rv"}',
    '{"ignoreCves":[42]}',
  ])(
    "fails closed on unreadable/malformed audit configuration %s",
    (config) => {
      writeFileSync(join(fixtureRoot, "audit-config.json"), config);
      const result = invoke(controlPlane);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Control-plane audit configuration");
      expect(receipts()).toEqual([]);
    },
  );

  it("preserves a real standalone finding without retrying a mixed transport message", () => {
    writeFileSync(
      join(fixtureRoot, "audit-result.json"),
      JSON.stringify({
        exitCode: 1,
        output: "HTTP 503 retry metadata\nGHSA-86w9-cpqp-85rv\nfound 1 high severity vulnerability",
      }),
    );
    const result = invoke(controlPlane);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("GHSA-86w9-cpqp-85rv");
    expect(receipts()).toHaveLength(1);
  });
});
