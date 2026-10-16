import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { load } = createRequire(import.meta.url)("js-yaml") as { load(input: string): unknown };

const root = path.resolve(import.meta.dirname, "../..");
const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });
const networkDenied = `
const net = require('node:net');
const original = net.Socket.prototype.connect;
const deny = () => { process.stderr.write('ZEROS_TEST_NETWORK_DENIED\\n'); throw new Error('network_denied'); };
net.Socket.prototype.connect = function(...args) {
  const value = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof value === 'string' || value && typeof value === 'object' && typeof value.path === 'string') return original.apply(this,args);
  return deny();
};
for (const name of ['node:http','node:https']) { const mod = require(name); mod.request = deny; mod.get = deny; }
require('node:tls').connect = deny;
globalThis.fetch = deny;
require('node:module').syncBuiltinESMExports();
`;
async function isolated() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "zd-workflow-entry-")); temporary.push(directory);
  const preload = path.join(directory, "network-denied.cjs");
  const file = await open(preload, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(networkDenied); } finally { await file.close(); }
  // An allowlist intentionally excludes all inherited Actions/provider secrets,
  // Git routing variables and proxies. Fixture paths never point at a real run.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_OPTIONS: `--require=${preload}`, NO_COLOR: "1" };
  return { directory, env };
}
async function execute(file: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ exit: number | string | null; stdout: string; stderr: string }>(resolve => {
    execFile(file, args, { cwd: root, env, timeout: 20_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolve({ exit: error?.code ?? 0, stdout, stderr });
    });
  });
}
async function workflow() {
  return load(await readFile(path.join(root, ".github/workflows/zeros-dev-e2e.yml"), "utf8")) as {
    jobs: { lifecycle: { steps: Array<{ name?: string; run?: string; env?: Record<string, string> }> } };
  };
}

describe("actual zeros-dev workflow entry processes", () => {
  it("covers every repository entry invoked directly by the workflow", async () => {
    const entries = (await workflow()).jobs.lifecycle.steps.flatMap(step => [...(step.run ?? "").matchAll(/(?:node|tsx) (scripts\/[^\s]+\.(?:mjs|ts))/g)].map(match => match[1]));
    expect(entries).toEqual(["scripts/zeros-dev/hourly-actions.mjs", "scripts/zeros-dev/hourly-main.ts"]);
  });

  it.each(["gate0", "infrastructure"])("executes pnpm exec tsx hourly-main.ts for %s without credentials or network", async profile => {
    const f = await isolated(), execution = { workflowRunId: "17", attempt: 1, sourceSha: "a".repeat(40) };
    const result = await execute("pnpm", ["exec", "tsx", "scripts/zeros-dev/hourly-main.ts"], {
      ...f.env, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "Withso/zeros", GITHUB_REF: "refs/heads/main",
      GITHUB_WORKFLOW_REF: "Withso/zeros/.github/workflows/zeros-dev-e2e.yml@refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ID: "17", GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: execution.sourceSha,
      ZEROS_DEV_PROFILE: profile, ZEROS_DEV_E2E_START_MS: String(Date.now()), GITHUB_WORKSPACE: f.directory, RUNNER_TEMP: f.directory,
      ZEROS_DEV_E2E_PLAN: JSON.stringify({ execution, profile, bootstrap: true, previous: null, artifactId: null }),
    });
    expect(result.exit).toBe(1);
    expect(result.stderr).not.toMatch(/Transform failed|Top-level await|ZEROS_TEST_NETWORK_DENIED/);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: profile === "infrastructure" ? "zeros.dev-infrastructure-result/v1" : "zeros.dev-hourly-result/v1",
      success: false, code: "credentials_invalid" });
    await expect(readFile(path.join(f.directory, ".env.agent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("executes node hourly-actions.mjs and awaits the closed context refusal", async () => {
    const f = await isolated(), result = await execute(process.execPath, ["scripts/zeros-dev/hourly-actions.mjs"], f.env);
    expect(result.exit).toBe(1); expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr.trim())).toEqual({ schema: "zeros.dev-error/v1", code: "artifact_invalid" });
  });

  it("supplies the cleanup handoff from a masked secret before the process starts", async () => {
    const steps = (await workflow()).jobs.lifecycle.steps;
    const consumer = steps.find(step => step.name === "Execute Alpha product lifecycle");
    expect(consumer?.env?.ZEROS_DEV_CLEANUP_HANDOFF_B64).toBe("${{ secrets.ZEROS_DEV_CLEANUP_HANDOFF_B64 }}");
    expect(steps.some(step => JSON.stringify(step).includes("vars.ZEROS_DEV_CLEANUP_HANDOFF_B64"))).toBe(false);
  });
});
