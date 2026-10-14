import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runHourly, recoverHourlyRun, historyDigest } from "../zeros-dev/hourly";
import { Evidence } from "../zeros-dev/evidence";
import { ZerosDevError } from "../zeros-dev/errors";
import type { RunHandle } from "../zeros-dev/receipts";
import { computerBuild } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";

function fixture() {
  const calls: string[] = [], output: unknown[] = [];
  const handle = { run: { version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: randomUUID(),
    createdAt: new Date().toISOString(), source: { revision: "b".repeat(40), dirty: false }, lifecycle: [], prompts: [], evidence: [], deletionConfirmed: false,
    hourly: { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "b".repeat(40), credentials: [], histories: [], activeWindows: [], complete: false } },
    save: vi.fn(async () => {}) } as RunHandle;
  const api = {
    assertFixtureEmpty: vi.fn(async () => { calls.push("empty"); }),
    ensureRepository: vi.fn(async () => { calls.push("repo"); }),
    computerState: vi.fn(async () => ({active:computerBuild()})),
    verifyComputerRuntime: vi.fn(async () => {calls.push("pin");return "confirmed";}),
    createWorkspace: vi.fn(async () => { calls.push("create"); handle.run.create = { key: randomUUID(), body: {} as never,
      result: { id: randomUUID(), createdBy: randomUUID(), createdAt: new Date().toISOString(), generation: 1 } }; }),
    waitWorkspace: vi.fn(async (_h: unknown, target: string) => { calls.push(target); }),
    lifecycle: vi.fn(async (_h: unknown, op: string) => { calls.push(op); }),
    cleanup: vi.fn(async (_h: unknown, _apply: boolean, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false); calls.push("cleanup"); handle.run.deletionConfirmed = true; return { planned: 1, confirmed: 1 };
    }),
  };
  const credentials = { install: vi.fn(async () => { calls.push("credentials"); }), cleanup: vi.fn(async () => { calls.push("revoke"); }) };
  let connections = 0;
  const rows = [{ msgId: "m", kind: "text", payload: JSON.stringify({ role: "assistant", text: "ZEROS_DEV_OK" }), createdAt: 1 }];
  const runtime = {
    terminal: vi.fn(async () => ({ exitCode: 0, truncated: false, output: "" })),
    prompt: vi.fn(async (h: RunHandle, input: { id: string; agent: "claude" | "codex" | "cursor"; model: string }) => {
      calls.push(input.agent); const receipt = { id: input.id, agent: input.agent, model: input.model, conversationId: randomUUID(), sha256: "c".repeat(64), state: "succeeded" as const };
      h.run.prompts.push(receipt); return receipt;
    }),
    tail: vi.fn(async () => rows), dispose: vi.fn(async () => { calls.push("disconnect"); }),
  };
  const connect = vi.fn(async () => { connections++; calls.push(`connect${connections}`); return runtime; });
  const options = { handle, api, credentials, connect, evidence: new Evidence(handle.run.runId, value => output.push(value)) };
  return { options, handle, api, credentials, connect, runtime, rows, calls, output };
}

describe("hourly fixture lifecycle", () => {
  it("names prior cleanup and refuses a still-unconfirmed signed workspace before the next allocation", async () => {
    const f = fixture();
    await f.api.createWorkspace(); f.api.createWorkspace.mockClear();
    f.api.cleanup.mockImplementation(async () => ({ planned: 1, confirmed: 0 }));
    await expect((async () => {
      await recoverHourlyRun({ ...f.options, signal: new AbortController().signal } as never);
      await runHourly(f.options as never);
    })()).rejects.toThrow("zeros_dev_cleanup_pending");
    expect(f.api.createWorkspace).not.toHaveBeenCalled();
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "prior_cleanup", code: "cleanup_pending" }));
    expect(f.credentials.cleanup).toHaveBeenCalledOnce();
  });

  it("revokes after an aborted predecessor cleanup and preserves its named first failure", async () => {
    const f = fixture(), controller = new AbortController();
    f.api.cleanup.mockImplementation(async () => { controller.abort(); throw new ZerosDevError("deadline"); });
    f.credentials.cleanup.mockImplementation(async (_h: unknown, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      throw new ZerosDevError("service_unavailable");
    });
    await expect(recoverHourlyRun({ ...f.options, signal: controller.signal } as never)).rejects.toThrow("zeros_dev_deadline");
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "prior_cleanup", code: "deadline" }));
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "credentials_cleanup", code: "service_unavailable" }));
  });

  it("sends exactly one minimal prompt per agent and proves chat/files after stop and resume", async () => {
    const f = fixture(); await runHourly(f.options as never);
    expect(f.calls).toEqual(["empty", "repo", "pin", "credentials", "create", "running", "connect1", "claude", "codex", "cursor", "disconnect", "stop", "stopped", "wake", "running", "connect2", "disconnect", "cleanup", "revoke"]);
    expect(f.runtime.prompt).toHaveBeenCalledTimes(3); expect(f.runtime.tail).toHaveBeenCalledTimes(6);
    expect(f.runtime.terminal).toHaveBeenCalledTimes(2);
    expect(f.handle.run.hourly).toMatchObject({ complete: true, activeWindows: [expect.anything(), expect.anything()] });
    expect(JSON.stringify(f.output)).not.toContain("payload");
  });

  it("refuses an unknown existing workspace before credentials or any allocation", async () => {
    const f = fixture(); f.api.assertFixtureEmpty.mockRejectedValue(new ZerosDevError("cleanup_pending"));
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_cleanup_pending");
    expect(f.credentials.install).not.toHaveBeenCalled(); expect(f.api.createWorkspace).not.toHaveBeenCalled();
  });
  it("refuses an unproved active Computer before credentials or allocation",async()=>{
    const f=fixture();f.api.verifyComputerRuntime.mockRejectedValue(new ZerosDevError("runtime_pin_unconfirmed"));
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_runtime_pin_unconfirmed");
    expect(f.credentials.install).not.toHaveBeenCalled();expect(f.api.createWorkspace).not.toHaveBeenCalled();
    expect(f.output).toContainEqual(expect.objectContaining({phase:"computer_pin",code:"runtime_pin_unconfirmed"}));
  });
  it("names a resume timeout with closed setup counts and keeps cleanup independent",async()=>{
    const f=fixture();let readyWaits=0;
    const setup={attempt:2,claimCount:3,state:"running" as const,errorCode:"setup_engine_readiness_failed" as const};
    f.api.waitWorkspace.mockImplementation(async(_h,target)=>{if(target==="running"&&++readyWaits===2)throw new ZerosDevError("deadline",undefined,undefined,setup);});
    f.api.cleanup.mockRejectedValue(new ZerosDevError("cleanup_pending"));
    await expect(runHourly(f.options as never)).rejects.toMatchObject({code:"deadline",setup});
    expect(f.output).toContainEqual(expect.objectContaining({phase:"workspace_resume_wait",code:"deadline",setup}));
    expect(f.credentials.cleanup).toHaveBeenCalledOnce();
  });

  it("retains a named agent failure and still deletes the workspace and revokes only its credentials", async () => {
    const f = fixture(); f.runtime.prompt.mockRejectedValueOnce(new ZerosDevError("agent_failed"));
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_agent_failed");
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "agent_claude", outcome: "failed", code: "agent_failed" }));
    expect(f.api.cleanup).toHaveBeenCalledOnce(); expect(f.credentials.cleanup).toHaveBeenCalledOnce();
    expect(f.runtime.prompt).toHaveBeenCalledOnce(); expect(f.handle.run.hourly?.complete).toBe(false);
  });

  it("a disconnect failure cannot replace the agent's original failed stage", async () => {
    const f = fixture(); f.runtime.prompt.mockRejectedValueOnce(new ZerosDevError("agent_failed"));
    f.runtime.dispose.mockRejectedValueOnce(new ZerosDevError("runtime_unavailable"));
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_agent_failed");
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "runtime_disconnect", code: "runtime_unavailable" }));
    expect(f.credentials.cleanup).toHaveBeenCalledOnce();
  });

  it("nonzero terminal exit is recorded as a failed terminal stage, never a successful one", async () => {
    const f = fixture(); f.runtime.terminal.mockResolvedValueOnce({ exitCode: 1, truncated: false, output: "" });
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_terminal_failed");
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "terminal_run", outcome: "failed", code: "terminal_failed" }));
    expect(f.runtime.prompt).not.toHaveBeenCalled();
  });

  it("an expired work signal still has an independent bounded cleanup signal", async () => {
    const f = fixture(); f.runtime.prompt.mockImplementationOnce(async () => new Promise(() => {}));
    await expect(runHourly({ ...f.options, workMs: 15, cleanupMs: 1000 } as never)).rejects.toThrow("zeros_dev_deadline");
    expect(f.api.cleanup).toHaveBeenCalledOnce(); expect(f.credentials.cleanup).toHaveBeenCalledOnce();
  });

  it("a pending deletion never becomes success and does not suppress credential cleanup", async () => {
    const f = fixture(); f.api.cleanup.mockRejectedValue(new ZerosDevError("cleanup_pending"));
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_cleanup_pending");
    expect(f.credentials.cleanup).toHaveBeenCalledOnce(); expect(f.handle.run.hourly?.complete).toBe(false);
  });

  it("names an unconfirmed cleanup result as a failed stage before revoking credentials", async () => {
    const f = fixture(); f.api.cleanup.mockResolvedValue({ planned: 1, confirmed: 0 });
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_cleanup_pending");
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "cleanup", outcome: "failed", code: "cleanup_pending" }));
    expect(f.credentials.cleanup).toHaveBeenCalledOnce(); expect(f.handle.run.hourly?.complete).toBe(false);
  });

  it("changed or absent restored chat is a named failure, with no extra prompt", async () => {
    const f = fixture(); f.runtime.tail.mockImplementation(async () => f.connect.mock.calls.length === 1 ? f.rows : []);
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_history_changed");
    expect(f.runtime.prompt).toHaveBeenCalledTimes(3); expect(f.api.cleanup).toHaveBeenCalledOnce();
  });

  it("does not accept a user echo as an assistant answer", () => {
    expect(() => historyDigest([{ msgId: "m", kind: "text", payload: '{"role":"user","text":"ZEROS_DEV_OK"}', createdAt: 1 }])).toThrow("zeros_dev_agent_failed");
  });

  it("refuses to repeat an interrupted or completed scenario under the same receipt", async () => {
    const f = fixture(); await runHourly(f.options as never);
    await expect(runHourly(f.options as never)).rejects.toThrow("zeros_dev_operation_conflict");
    expect(f.api.createWorkspace).toHaveBeenCalledOnce(); expect(f.runtime.prompt).toHaveBeenCalledTimes(3);
  });
});
