import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runHourly, recoverHourlyRun, historyDigest, HOURLY_COMPUTER_MS, HOURLY_WORK_MS, HOURLY_CLEANUP_MS } from "../zeros-dev/hourly";
import { Evidence } from "../zeros-dev/evidence";
import { ZerosDevError } from "../zeros-dev/errors";
import type { RunHandle } from "../zeros-dev/receipts";
import type { Fixture } from "../zeros-dev/config";
import { ProductApi } from "../zeros-dev/product";
import { AlphaTransport } from "../zeros-dev/transport";
import type { CloudComputerV2BuildRuntime } from "@zeros/protocol/cloud-computer-v2";
import { computerBuild } from "../../apps/desktop/src/renderer/features/settings/__tests__/cloud-computer-v2-fixtures";
import type { AdmissionObservation } from "../zeros-dev/admission-observation";

function fixture() {
  const calls: string[] = [], output: unknown[] = [];
  const handle = { run: { version: 1, runId: randomUUID(), fixtureSha256: "a".repeat(64), deviceId: randomUUID(),
    createdAt: new Date().toISOString(), source: { revision: "b".repeat(40), dirty: false }, lifecycle: [], prompts: [], evidence: [], deletionConfirmed: false,
    hourly: { version: 1, workflowRunId: "17", attempt: 1, sourceSha: "b".repeat(40), credentials: [], histories: [], activeWindows: [], complete: false } },
    save: vi.fn(async () => {}) } as RunHandle;
  const selected = { runtimeId: `r1-${"c".repeat(64)}`, baseImageId: "fixture-base", sourceCommit: "d".repeat(40), qualificationMode: "smoke" as const };
  const computer = { active: computerBuild(), selected: selected as CloudComputerV2BuildRuntime["selected"] };
  const pins = new Map([[computer.active.id, { runtimeId: selected.runtimeId, baseImageId: selected.baseImageId }]]);
  const transport = new AlphaTransport(async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname.endsWith("/runtime")) {
      const id = pathname.split("/").at(-2)!;
      return Response.json({ buildId: id, version: computer.active.version, ...pins.get(id), selected: computer.selected });
    }
    return Response.json(computer.active);
  });
  const product = new ProductApi({ fixture: async () => ({ organizationId: randomUUID() }) as Fixture,
    whoami: async () => ({}) as never, accessToken: async () => "synthetic-account-access" }, transport);
  const api = {
    assertFixtureEmpty: vi.fn(async () => { calls.push("empty"); }),
    ensureRepository: vi.fn(async () => { calls.push("repo"); }),
    computerState: vi.fn(async () => ({active:computer.active})),
    readComputerRuntime: vi.fn((...args: Parameters<ProductApi["readComputerRuntime"]>) => product.readComputerRuntime(...args)),
    verifyComputerRuntime: vi.fn((...args: Parameters<ProductApi["verifyComputerRuntime"]>) => { calls.push("pin"); return product.verifyComputerRuntime(...args); }),
    buildComputer: vi.fn(async () => {
      calls.push("build");
      computer.active = computerBuild({ id: randomUUID(), version: computer.active.version + 1 });
      pins.set(computer.active.id, { runtimeId: computer.selected!.runtimeId, baseImageId: computer.selected!.baseImageId });
      handle.run.computer = { operationId: randomUUID(), expectedRevision: 1, result: { id: computer.active.id, version: computer.active.version } };
      await handle.save(); return computer.active;
    }),
    waitComputer: vi.fn((...args: Parameters<ProductApi["waitComputer"]>) => { calls.push("build_wait"); return product.waitComputer(...args); }),
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
  return { options, handle, api, credentials, connect, runtime, rows, calls, output, computer, pins };
}

describe("hourly fixture lifecycle", () => {
  it("records recovered admission failures and retry counts without retrying the lifecycle or hiding them in success", async () => {
    const f = fixture();
    const firstFailure = { status: 503 as const, code: "cloud_runtime_temporarily_unavailable" as const,
      phase: "provider_endpoint" as const, retryAfterMs: 1000 };
    const first: AdmissionObservation = { sequence: 1, firstFailure, retryCount: 0, retries: [] };
    const admission: AdmissionObservation = { ...first, retryCount: 1, retries: [{ ...firstFailure, attempt: 2, delayMs: 1000 }] };
    f.options.connect = vi.fn(async (_run?: unknown, _signal?: AbortSignal, observe?: (event: AdmissionObservation) => void) => {
      observe?.(first); observe?.(admission); return { ...f.runtime, admission };
    });
    await runHourly(f.options as never);
    expect(f.output.filter((row: any) => row.phase === "runtime_admission")).toEqual([
      ...[first, admission, first, admission].map(observed => expect.objectContaining({ outcome: "pending", admission: observed, count: observed.retryCount })),
    ]);
    expect(f.output.filter((row: any) => row.phase === "runtime_connect")).toEqual([
      expect.objectContaining({ outcome: "ok", admission }), expect.objectContaining({ outcome: "ok", admission }),
    ]);
    expect(f.handle.run.hourly?.complete).toBe(true); expect(f.api.createWorkspace).toHaveBeenCalledOnce();
    expect(f.options.connect).toHaveBeenCalledTimes(2);
  });

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
    expect(f.calls).toEqual(["empty", "repo", "pin", "credentials", "pin", "create", "running", "connect1", "claude", "codex", "cursor", "disconnect", "stop", "stopped", "wake", "running", "connect2", "disconnect", "pin", "cleanup", "revoke"]);
    expect(f.api.buildComputer).not.toHaveBeenCalled();
    expect(f.runtime.prompt).toHaveBeenCalledTimes(3); expect(f.runtime.tail).toHaveBeenCalledTimes(6);
    expect(f.runtime.terminal).toHaveBeenCalledTimes(2);
    expect(f.handle.run.hourly).toMatchObject({ complete: true, activeWindows: [expect.anything(), expect.anything()] });
    expect(JSON.stringify(f.output)).not.toContain("payload");
  });

  it("rebuilds once when the qualified selection moved, proves that exact tuple, then runs the green lifecycle", async () => {
    const f = fixture();
    f.computer.selected = { ...f.computer.selected!, runtimeId: `r1-${"e".repeat(64)}` };
    await runHourly(f.options as never);
    expect(f.api.buildComputer).toHaveBeenCalledOnce(); expect(f.api.waitComputer).toHaveBeenCalledOnce();
    expect(f.api.waitComputer).toHaveBeenCalledWith(f.handle.run, expect.any(AbortSignal), {
      runtimeId: f.computer.selected.runtimeId, baseImageId: f.computer.selected.baseImageId,
    });
    expect(f.api.createWorkspace).toHaveBeenCalledOnce(); expect(f.runtime.prompt).toHaveBeenCalledTimes(3);
    expect(f.handle.run.hourly?.complete).toBe(true);
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "computer_build", outcome: "ok" }));
  });

  it("rebuilds for a changed qualified base even when the runtime ID is unchanged", async () => {
    const f = fixture(); f.computer.selected = { ...f.computer.selected!, baseImageId: "next-qualified-base" };
    await runHourly(f.options as never);
    expect(f.api.buildComputer).toHaveBeenCalledOnce(); expect(f.handle.run.hourly?.complete).toBe(true);
  });

  it("names absent qualification as a selection prerequisite, without a build or product allocation", async () => {
    const f = fixture(); f.computer.selected = null;
    await expect(runHourly(f.options as never)).rejects.toMatchObject({ code: "runtime_selection_unavailable" });
    expect(f.api.buildComputer).not.toHaveBeenCalled(); expect(f.credentials.install).not.toHaveBeenCalled();
    expect(f.api.createWorkspace).not.toHaveBeenCalled();
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "computer_selection", code: "runtime_selection_unavailable" }));
  });

  it("closes a selection change during the one build without chasing it or starting the lifecycle", async () => {
    const f = fixture(); f.computer.selected = { ...f.computer.selected!, runtimeId: `r1-${"e".repeat(64)}` };
    const wait = f.api.waitComputer.getMockImplementation()!;
    f.api.waitComputer.mockImplementation(async (...args) => {
      f.computer.selected = { ...f.computer.selected!, runtimeId: `r1-${"f".repeat(64)}` };
      return wait(...args);
    });
    await expect(runHourly(f.options as never)).rejects.toMatchObject({ code: "runtime_selection_changed" });
    expect(f.api.buildComputer).toHaveBeenCalledOnce(); expect(f.credentials.install).not.toHaveBeenCalled();
    expect(f.api.createWorkspace).not.toHaveBeenCalled();
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "computer_build", code: "runtime_selection_changed" }));
  });

  it("closes a selection change before create and preserves it through failed credential cleanup", async () => {
    const f = fixture(); f.credentials.install.mockImplementation(async () => {
      f.computer.selected = { ...f.computer.selected!, runtimeId: `r1-${"e".repeat(64)}` };
    });
    f.credentials.cleanup.mockRejectedValue(new ZerosDevError("service_unavailable"));
    await expect(runHourly(f.options as never)).rejects.toMatchObject({ code: "runtime_selection_changed" });
    expect(f.api.buildComputer).not.toHaveBeenCalled(); expect(f.api.createWorkspace).not.toHaveBeenCalled();
    expect(f.credentials.cleanup).toHaveBeenCalledOnce();
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "computer_pin", code: "runtime_selection_changed" }));
  });

  it("cannot report green if the selection moves during resume", async () => {
    const f = fixture(), lifecycle = f.api.lifecycle.getMockImplementation()!;
    f.api.lifecycle.mockImplementation(async (handle, operation) => {
      await lifecycle(handle, operation);
      if (operation === "wake") f.computer.selected = { ...f.computer.selected!, runtimeId: `r1-${"e".repeat(64)}` };
    });
    await expect(runHourly(f.options as never)).rejects.toMatchObject({ code: "runtime_selection_changed" });
    expect(f.api.buildComputer).not.toHaveBeenCalled(); expect(f.api.cleanup).toHaveBeenCalledOnce();
    expect(f.handle.run.hourly?.complete).toBe(false);
  });

  it("bounds a hung build in its own phase without credentials or a workspace", async () => {
    const f = fixture(); f.computer.selected = { ...f.computer.selected!, runtimeId: `r1-${"e".repeat(64)}` };
    f.api.waitComputer.mockImplementation(async () => new Promise(() => {}));
    await expect(runHourly({ ...f.options, computerMs: 15 } as never)).rejects.toMatchObject({ code: "deadline" });
    expect(f.api.buildComputer).toHaveBeenCalledOnce(); expect(f.credentials.install).not.toHaveBeenCalled();
    expect(f.api.createWorkspace).not.toHaveBeenCalled();
    expect(f.output).toContainEqual(expect.objectContaining({ phase: "computer_build", code: "deadline" }));
  });

  it("starts the lifecycle allowance after the build and keeps expired preparation separate from work and cleanup", async () => {
    const f = fixture(), deadlines = new Map<number, AbortController>();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); deadlines.set(ms, controller); return controller.signal;
    });
    try {
      f.computer.selected = { ...f.computer.selected!, runtimeId: `r1-${"e".repeat(64)}` };
      const wait = f.api.waitComputer.getMockImplementation()!;
      f.api.waitComputer.mockImplementation(async (...args) => {
        expect(deadlines.has(HOURLY_COMPUTER_MS)).toBe(true);
        expect(deadlines.has(HOURLY_WORK_MS)).toBe(false);
        return wait(...args);
      });
      f.credentials.install.mockImplementation(async () => {
        expect(deadlines.has(HOURLY_WORK_MS)).toBe(true);
        deadlines.get(HOURLY_COMPUTER_MS)!.abort();
      });
      await runHourly(f.options as never);
      expect(f.handle.run.hourly?.complete).toBe(true);
      expect(deadlines.has(HOURLY_CLEANUP_MS)).toBe(true);
    } finally { timeout.mockRestore(); }
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
