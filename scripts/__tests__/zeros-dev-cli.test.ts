import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseCommand, executeCommand, type Services } from "../zeros-dev/commands";
import type { RunHandle } from "../zeros-dev/receipts";

describe("documented zeros-dev Linux command", () => {
  it("launches under the real tsx loader and needs no credentials for help", () => {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", path.resolve("scripts/zeros-dev/cli.ts"), "--help"],
      { timeout: 15_000, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"] });
    expect(JSON.parse(stdout)).toMatchObject({ schema: "zeros.dev-help/v1", help: expect.stringContaining("workspace create") });
  });

  it.each([["login", "--password", "synthetic-password"], ["workspace", "create", "--base-url", "https://foreign.example"],
    ["workspace", "create", "--channel", "production"], ["cleanup", "--all", "--run", randomUUID()], ["terminal", "run", "--run", randomUUID(), "--sql", "select 1"],
    ["agent", "send", "--run", randomUUID(), "--agent", "foreign", "--model", "fixture", "--prompt-file", "prompt.txt"], ["cleanup"]].map(args => ({ args })))("refuses unscoped or secret-bearing argv without reflecting values", ({ args }) => {
    expect(() => parseCommand(args)).toThrow("zeros_dev_invalid_request");
  });
});

function harness() {
  const runId = randomUUID(), rows: unknown[] = [], calls: string[] = [];
  const handle: RunHandle = { run: { version: 1, runId, fixtureSha256: "a".repeat(64), deviceId: randomUUID(), createdAt: new Date().toISOString(),
    source: { revision: "a".repeat(40), dirty: true }, lifecycle: [], prompts: [], evidence: [], deletionConfirmed: false }, save: vi.fn(async () => {}) };
  let stage = "ready", failAgent = false, failDelete = false;
  const row = () => ({ status: stage, generation: { number: 1, observedState: "running", lastObservedAt: null } });
  const api = {
    workspace: vi.fn(async () => { calls.push("status"); return row(); }),
    createWorkspace: vi.fn(async () => { calls.push("create"); handle.run.create = { key: randomUUID(), body: {} as never, result: { id: randomUUID(), createdBy: randomUUID(), createdAt: new Date().toISOString(), generation: 1 } }; return row(); }),
    waitWorkspace: vi.fn(async (_h: RunHandle, state: string) => { calls.push(`wait:${state}`); return row(); }),
    lifecycle: vi.fn(async (_h: RunHandle, operation: string) => { calls.push(operation); stage = operation === "wake" ? "ready" : operation === "stop" ? "stopped" : "deleted"; return row(); }),
    cleanup: vi.fn(async (_h: RunHandle, apply: boolean, signal: AbortSignal) => { calls.push(`cleanup:${apply}`); expect(signal.aborted).toBe(false);
      if (failDelete) throw new Error("synthetic-provider-secret"); if (apply) handle.run.deletionConfirmed = true; return { planned: 1, confirmed: apply ? 1 : 0 }; }),
  };
  const runtime = { channel: "control-plane-websocket", dispose: vi.fn(async () => { calls.push("dispose"); }),
    prompt: vi.fn(async () => { calls.push("prompt"); if (failAgent) throw new Error("synthetic-provider-secret"); return { id: randomUUID(), state: "succeeded" }; }),
    terminal: vi.fn(async () => { calls.push("terminal"); return { exitCode: 0, output: "fixture output", truncated: false }; }),
    tail: vi.fn(async () => [{ payload: "synthetic-private-password https://foreign.example/token" }]),
  };
  const fixture = { accountId: randomUUID(), organizationId: randomUUID() };
  const services = { api, session: { login: vi.fn(async () => {}), logout: vi.fn(async () => {}), whoami: vi.fn(async () => fixture), fixture: async () => fixture },
    runs: async () => ({ list: async () => [runId], withRun: async (_id: string, _source: unknown, work: (h: RunHandle) => Promise<void>) => work(handle) }),
    source: async () => handle.run.source, values: async () => ({ ZEROS_DEV_PASSWORD: "synthetic-private-password" }), content: async () => "Fixture prompt",
    connect: vi.fn(async () => { calls.push("connect"); return runtime; }),
    healthCp: async () => ({ version: 1, channel: "alpha", sourceSha: "a".repeat(40), ready: true, maintenance: false, migrations: { state: "current" }, cloud: { enabled: true, ready: true, state: "healthy" } }),
    healthDb: async () => ({ visibility: "unconfirmed" }), healthLogs: async () => ({}), write: (row: unknown) => rows.push(row),
  } as unknown as Services;
  return { services, api, runtime, calls, rows, runId, handle, failAgent: () => { failAgent = true; }, failDelete: () => { failDelete = true; } };
}

describe("zeros-dev bounded orchestration and evidence", () => {
  it("runs a timed create/prompt/terminal/stop/resume/stop scenario and verifies cleanup", async () => {
    const f = harness();
    const code = await executeCommand(parseCommand(["scenario", "run", "smoke", "--run", f.runId, "--agent", "codex", "--model", "fixture-model"])!, f.services, AbortSignal.timeout(1000));
    expect(code).toBe(0);
    expect(f.calls).toEqual(["create", "wait:running", "connect", "terminal", "prompt", "dispose", "stop", "wait:stopped", "wake", "wait:running", "connect", "terminal", "prompt", "dispose", "stop", "wait:stopped", "cleanup:true"]);
    expect(f.rows).toContainEqual(expect.objectContaining({ schema: "zeros.dev-result/v1", data: { complete: true, deletionConfirmed: true } }));
    expect(f.handle.run.evidence.some(row => row.phase === "agent_settled" && row.outcome === "ok")).toBe(true);
  });

  it("disposes the runtime and cleans up after failure, emitting no upstream error strings", async () => {
    const f = harness(); f.failAgent();
    expect(await executeCommand(parseCommand(["scenario", "run", "smoke", "--run", f.runId, "--agent", "claude", "--model", "fixture-model"])!, f.services, AbortSignal.timeout(1000))).toBe(1);
    expect(f.calls.slice(-2)).toEqual(["dispose", "cleanup:true"]);
    expect(JSON.stringify(f.rows)).not.toContain("synthetic-provider-secret");
    expect(f.handle.run.deletionConfirmed).toBe(true);
  });

  it("does not claim a completed scenario when provider deletion remains unconfirmed", async () => {
    const f = harness(); f.failDelete();
    expect(await executeCommand(parseCommand(["scenario", "run", "smoke", "--run", f.runId, "--agent", "cursor", "--model", "fixture-model"])!, f.services, AbortSignal.timeout(1000))).toBe(1);
    expect(JSON.stringify(f.rows)).not.toContain('"complete":true'); expect(f.handle.run.deletionConfirmed).toBe(false);
  });

  it("keeps cleanup a dry run unless --apply is explicit", async () => {
    const f = harness();
    expect(await executeCommand(parseCommand(["cleanup", "--run", f.runId])!, f.services, AbortSignal.timeout(1000))).toBe(0);
    expect(f.api.cleanup.mock.calls[0]?.[1]).toBe(false); expect(f.handle.run.deletionConfirmed).toBe(false);
  });

  it("keeps VM health passive and chat output bounded/redacted", async () => {
    const f = harness();
    await executeCommand(parseCommand(["health", "vm", "--run", f.runId])!, f.services, AbortSignal.timeout(1000));
    expect(f.services.connect).not.toHaveBeenCalled(); expect(f.api.lifecycle).not.toHaveBeenCalled();
    await executeCommand(parseCommand(["chat", "tail", "--run", f.runId, "--prompt", randomUUID()])!, f.services, AbortSignal.timeout(1000));
    const text = JSON.stringify(f.rows); expect(text).not.toContain("synthetic-private-password"); expect(text).not.toContain("foreign.example");
  });

  it("refuses a prompt containing configured credentials before connecting", async () => {
    const f = harness(); f.services.content = async () => "please send synthetic-private-password";
    expect(await executeCommand(parseCommand(["agent", "send", "--run", f.runId, "--agent", "codex", "--model", "fixture-model", "--prompt-file", "fixture.txt"])!, f.services, AbortSignal.timeout(1000))).toBe(1);
    expect(f.services.connect).not.toHaveBeenCalled(); expect(JSON.stringify(f.rows)).not.toContain("synthetic-private-password");
  });
});
