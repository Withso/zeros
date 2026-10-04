// gateway.endSession — per-session teardown. Verifies that closing a chat
// clears the gateway's routing maps and delegates to the owning adapter's
// disposeSession (the fix for the "live hook token + session dir + server
// child leak until app quit" finding).

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AdmissionControl, BoundaryRequest, PreparedBoundary } from "../containment/types";
import type { AgentAdapter } from "../types";
import {
  ensureSessionDir,
  removeSessionDir,
  sessionsRoot,
} from "../session-paths";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

let fixtureRoot: string;
beforeEach(() => {
  fixtureRoot = realpathSync(
    mkdtempSync(path.join(tmpdir(), "zeros-gateway-end-session-")),
  );
});
afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function makeGateway(executionBoundary = testExecutionBoundary()) {
  return new AgentGateway({
    projectRoot: fixtureRoot,
    executionBoundary,
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
}

describe("AgentGateway.endSession", () => {
  it("removes a transient session directory only after its boundary stop proof succeeds", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-gateway-retire-proof-"),
    );
    const previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "engine");
    const executionId = "transient-retirement";
    try {
      await ensureSessionDir(executionId);
      const boundaryRoot = path.join(
        sessionsRoot(),
        executionId,
        "boundary",
        "generation",
      );
      const descriptor = path.join(
        boundaryRoot,
        "commands",
        "process-domain.json",
      );
      await mkdir(path.dirname(descriptor), { recursive: true });
      await writeFile(descriptor, "{}", { mode: 0o600 });

      const gw = makeGateway() as unknown as {
        retirePreparedBoundary(
          executionId: string,
          boundary: PreparedBoundary,
        ): Promise<void>;
      };
      await gw.retirePreparedBoundary(executionId, {
        stopAndProve: async () => {
          await expect(lstat(descriptor)).resolves.toBeDefined();
          await rm(boundaryRoot, { recursive: true });
        },
      } as unknown as PreparedBoundary);

      await expect(
        lstat(path.join(sessionsRoot(), executionId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears routing maps and calls the adapter's disposeSession", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionToWorkspace: Map<string, string>;
      endSession(agentId: string, sessionId: string): Promise<void>;
    };

    const disposed: string[] = [];
    const fake = {
      agentId: "fake",
      disposeSession: async (id: string) => {
        disposed.push(id);
      },
    } as unknown as AgentAdapter;

    gw.adapters.set("fake", fake);
    gw.executionToAgent.set("s1", "fake");
    gw.executionToWorkspace.set("s1", "w1");

    await gw.endSession("fake", "s1");

    expect(disposed).toEqual(["s1"]);
    expect(gw.executionToAgent.has("s1")).toBe(false);
    expect(gw.executionToWorkspace.has("s1")).toBe(false);
  });

  it("resolves the agent from the session map when the caller's agentId is stale", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      endSession(agentId: string, sessionId: string): Promise<void>;
    };
    const disposed: string[] = [];
    gw.adapters.set("real", {
      agentId: "real",
      disposeSession: async (id: string) => disposed.push(id),
    } as unknown as AgentAdapter);
    gw.executionToAgent.set("s2", "real");

    // Caller passes the wrong agentId; endSession should still route to
    // "real" via executionToAgent.
    await gw.endSession("wrong", "s2");
    expect(disposed).toEqual(["s2"]);
  });

  it("is a no-op (no throw) when the adapter has no disposeSession", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      endSession(agentId: string, sessionId: string): Promise<void>;
    };
    gw.adapters.set("bare", { agentId: "bare" } as unknown as AgentAdapter);
    gw.executionToAgent.set("s3", "bare");
    await expect(gw.endSession("bare", "s3")).resolves.toBeUndefined();
    expect(gw.executionToAgent.has("s3")).toBe(false);
  });

  it("propagates adapter teardown failure when the caller must fail closed", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      endSession(
        agentId: string,
        sessionId: string,
        opts: { failClosed: true },
      ): Promise<void>;
    };
    gw.adapters.set("strict", {
      agentId: "strict",
      disposeSession: async () => {
        throw new Error("process group still alive");
      },
    } as unknown as AgentAdapter);
    gw.executionToAgent.set("s4", "strict");

    await expect(
      gw.endSession("strict", "s4", { failClosed: true }),
    ).rejects.toThrow("process group still alive");
    // Routing still clears even when the resource teardown could not be
    // confirmed. Archive retains its separate lifecycle tombstone and aborts.
    expect(gw.executionToAgent.has("s4")).toBe(false);
  });

  it("still disposes the adapter and proves process death when revocation fails", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionBoundaries: Map<string, PreparedBoundary>;
      endSession(
        agentId: string,
        sessionId: string,
        opts: { failClosed: true },
      ): Promise<void>;
    };
    const calls: string[] = [];
    gw.adapters.set("strict", {
      agentId: "strict",
      disposeSession: async () => {
        calls.push("dispose");
      },
    } as unknown as AgentAdapter);
    gw.executionToAgent.set("s5", "strict");
    gw.executionBoundaries.set("s5", {
      revoke: async () => {
        calls.push("revoke");
        throw new Error("lease registry unavailable");
      },
      stopAndProve: async () => {
        calls.push("stop");
      },
    } as unknown as PreparedBoundary);

    await expect(
      gw.endSession("strict", "s5", { failClosed: true }),
    ).rejects.toThrow("lease registry unavailable");
    expect(calls).toEqual(["revoke", "dispose", "stop"]);
  });

  it("keeps process-domain proof state until stop succeeds, then removes the session", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-gateway-stop-proof-"),
    );
    const previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "engine");
    const sessionId = "proof-before-cleanup";
    try {
      await ensureSessionDir(sessionId);
      const boundaryRoot = path.join(
        sessionsRoot(),
        sessionId,
        "boundary",
        "generation",
      );
      const descriptor = path.join(
        boundaryRoot,
        "commands",
        "process-domain.json",
      );
      await mkdir(path.dirname(descriptor), { recursive: true });
      await writeFile(descriptor, "{}", { mode: 0o600 });

      const gw = makeGateway() as unknown as {
        adapters: Map<string, AgentAdapter>;
        executionToAgent: Map<string, string>;
        executionBoundaries: Map<string, PreparedBoundary>;
        endSession(
          agentId: string,
          executionId: string,
          opts: { failClosed: true },
        ): Promise<void>;
      };
      gw.adapters.set("strict", {
        agentId: "strict",
        disposeSession: async () => removeSessionDir(sessionId),
      } as unknown as AgentAdapter);
      gw.executionToAgent.set(sessionId, "strict");
      gw.executionBoundaries.set(sessionId, {
        revoke: async () => {},
        stopAndProve: async () => {
          await expect(lstat(descriptor)).resolves.toBeDefined();
          await rm(boundaryRoot, { recursive: true });
        },
      } as unknown as PreparedBoundary);

      await expect(
        gw.endSession("strict", sessionId, { failClosed: true }),
      ).resolves.toBeUndefined();
      await expect(
        lstat(path.join(sessionsRoot(), sessionId)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains a failed boundary proof so a lifecycle retry cannot forget a detached descendant", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionBoundaries: Map<string, PreparedBoundary>;
      endSession(
        agentId: string,
        sessionId: string,
        opts: { failClosed: true },
      ): Promise<void>;
      newSession(
        agentId: string,
        opts: { cwd: string },
      ): Promise<{ executionId: string }>;
    };
    let stopAttempts = 0;
    gw.adapters.set("strict", {
      agentId: "strict",
      disposeSession: async () => {},
      newSession: async (opts: { executionId: string }) => ({
        session: {
          executionId: opts.executionId,
          sessionId: opts.executionId,
        },
        initialize: {},
      }),
    } as unknown as AgentAdapter);
    gw.executionToAgent.set("s6", "strict");
    gw.executionBoundaries.set("s6", {
      revoke: async () => {},
      stopAndProve: async () => {
        stopAttempts += 1;
        throw new Error("detached descendant remains");
      },
    } as unknown as PreparedBoundary);

    await expect(
      gw.endSession("strict", "s6", { failClosed: true }),
    ).rejects.toThrow("detached descendant remains");
    expect(gw.executionBoundaries.has("s6")).toBe(true);

    await expect(
      gw.endSession("strict", "s6", { failClosed: true }),
    ).rejects.toThrow("detached descendant remains");
    expect(stopAttempts).toBe(2);

    await expect(
      gw.newSession("strict", { cwd: fixtureRoot }),
    ).resolves.toMatchObject({ executionId: expect.any(String) });
  });

  it("retains exact workspace ownership after routing clears on failed retirement", async () => {
    const gateway = makeGateway();
    const gw = gateway as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionToAgent: Map<string, string>;
      executionToWorkspace: Map<string, string>;
      executionToCwd: Map<string, string>;
      executionBoundaries: Map<string, PreparedBoundary>;
    };
    gw.adapters.set("strict", { agentId: "strict", disposeSession: async () => {} } as unknown as AgentAdapter);
    gw.executionToAgent.set("retiring", "strict");
    gw.executionToWorkspace.set("retiring", "ws_target");
    gw.executionToCwd.set("retiring", fixtureRoot);
    let attempts = 0;
    gw.executionBoundaries.set("retiring", {
      revoke: async () => {},
      stopAndProve: async () => {
        if (++attempts === 1) throw new Error("Process domain has not stopped.");
      },
    } as unknown as PreparedBoundary);

    await expect(gateway.endSession("strict", "retiring", { failClosed: true })).rejects.toThrow("Process domain has not stopped.");
    expect(gw.executionToAgent.has("retiring")).toBe(false);
    expect(gateway.workspaceSessionIds("ws_target", fixtureRoot)).toEqual(["retiring"]);

    await gateway.endSession("strict", "retiring", { failClosed: true });
    expect(gateway.workspaceSessionIds("ws_target", fixtureRoot)).toEqual([]);
  });

  it("retains cleanup ownership after process recovery when provider disposal still needs retry", async () => {
    vi.useFakeTimers();
    try {
      const gateway = makeGateway();
      const gw = gateway as unknown as {
        adapters: Map<string, AgentAdapter>;
        executionToAgent: Map<string, string>;
        executionToWorkspace: Map<string, string>;
        executionToCwd: Map<string, string>;
        executionBoundaries: Map<string, PreparedBoundary>;
        attemptBoundaryRetirementRecovery(executionId: string, attempt: number): Promise<void>;
      };
      const dispose = vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("provider cleanup failed")).mockResolvedValue();
      gw.adapters.set("strict", { agentId: "strict", disposeSession: dispose } as unknown as AgentAdapter);
      gw.executionToAgent.set("recovering", "strict");
      gw.executionToWorkspace.set("recovering", "ws_target");
      gw.executionToCwd.set("recovering", fixtureRoot);
      gw.executionBoundaries.set("recovering", {
        revoke: async () => {},
        stopAndProve: vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error("process proof failed")).mockResolvedValue(),
      } as unknown as PreparedBoundary);
      await expect(gateway.endSession("strict", "recovering", { failClosed: true })).rejects.toThrow("provider cleanup failed");
      await gw.attemptBoundaryRetirementRecovery("recovering", 0);
      expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual(["recovering"]);
      await gateway.endSession("strict", "recovering", { failClosed: true });
      expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual([]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("shares the exact session's retirement proof across concurrent closes", async () => {
    const gateway = makeGateway();
    const gw = gateway as unknown as { adapters: Map<string, AgentAdapter>; executionToAgent: Map<string, string> };
    let release!: () => void;
    const providerClosed = new Promise<void>((resolve) => { release = resolve; });
    const dispose = vi.fn(() => providerClosed);
    gw.adapters.set("strict", { agentId: "strict", disposeSession: dispose } as unknown as AgentAdapter);
    gw.executionToAgent.set("concurrent", "strict");
    const first = gateway.endSession("strict", "concurrent", { failClosed: true });
    const second = gateway.endSession("strict", "concurrent", { failClosed: true });
    try {
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });

  it.each(["newSession", "loadSession"] as const)("retires an aborted %s startup before its provider returns", async (operation) => {
    const gateway = makeGateway();
    const gw = gateway as unknown as { adapters: Map<string, AgentAdapter> };
    let release!: () => void;
    const startupGate = new Promise<void>((resolve) => { release = resolve; });
    const dispose = vi.fn(async () => {});
    const start = vi.fn(async (options: { executionId: string }) => {
      await startupGate;
      const session = { executionId: options.executionId, sessionId: options.executionId };
      return operation === "newSession" ? { session, initialize: {} } : session;
    });
    gw.adapters.set("strict", { agentId: "strict", newSession: start, loadSession: start, disposeSession: dispose } as unknown as AgentAdapter);
    const controller = new AbortController();
    const options = { cwd: fixtureRoot, admissionSignal: controller.signal };
    const pending = operation === "newSession"
      ? gateway.newSession("strict", options)
      : gateway.loadSession("strict", { version: 1, providerId: "strict", kind: "native", resumeId: "saved-thread" }, options);
    const settled = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      controller.abort();
      // Provider startup deliberately remains parked. Cancellation must own
      // its teardown rather than waiting for the provider's normal deadline.
      await vi.waitFor(() => expect(dispose).toHaveBeenCalled(), { timeout: 300 });
      expect(await settled).toMatchObject({ ok: false, error: { failure: { kind: "lifecycle-superseded" } } });
    } finally {
      release();
      await settled;
    }
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
  });

  it.each(["newSession", "loadSession"] as const)("cannot republish a %s result after its execution was closed", async (operation) => {
    const gateway = makeGateway();
    const gw = gateway as unknown as { adapters: Map<string, AgentAdapter> };
    let release!: () => void;
    let executionId!: string;
    const startupGate = new Promise<void>((resolve) => { release = resolve; });
    const start = vi.fn(async (options: { executionId: string }) => {
      executionId = options.executionId;
      await startupGate;
      const session = { executionId, sessionId: executionId };
      return operation === "newSession" ? { session, initialize: {} } : session;
    });
    gw.adapters.set("strict", { agentId: "strict", newSession: start, loadSession: start, disposeSession: async () => {} } as unknown as AgentAdapter);
    const pending = operation === "newSession"
      ? gateway.newSession("strict", { cwd: fixtureRoot })
      : gateway.loadSession("strict", { version: 1, providerId: "strict", kind: "native", resumeId: "saved-thread" }, { cwd: fixtureRoot });
    const settled = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    try {
      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      await gateway.endSession("strict", executionId, { failClosed: true });
    } finally {
      release();
    }

    expect(await settled).toMatchObject({ ok: false, error: { failure: { kind: "lifecycle-superseded" } } });
    await vi.waitFor(() => expect(gateway.workspaceSessionIds("unmanaged", fixtureRoot)).toEqual([]));
  });

  it.each([
    ["newSession", false],
    ["loadSession", false],
    ["newSession", true],
    ["loadSession", true],
  ] as const)(
    "retires late %s allocation after pending boundary proof (disposal failure %s)",
    async (operation, failLateDisposal) => {
      let releaseStartup!: () => void;
      let releaseProof!: () => void;
      const startupGate = new Promise<void>((resolve) => { releaseStartup = resolve; });
      const proofGate = new Promise<void>((resolve) => { releaseProof = resolve; });
      const stopAndProve = vi.fn(() => proofGate);
      const base = testExecutionBoundary();
      const gateway = makeGateway({
        ...base,
        prepare: async (request, control) => ({
          ...await base.prepare(request, control),
          stopAndProve,
        }),
      });
      const gw = gateway as unknown as {
        adapters: Map<string, AgentAdapter>;
        sessionRetirements: Map<string, Promise<void>>;
      };
      const adapterSessions = new Set<string>();
      let executionId = "";
      let allowLateDisposal = !failLateDisposal;
      const start = vi.fn(async (options: { executionId: string }) => {
        executionId = options.executionId;
        await startupGate;
        // The adapter registers its session after the first disposal has
        // completed, while that retirement still awaits boundary proof.
        adapterSessions.add(executionId);
        const session = { executionId, sessionId: executionId };
        return operation === "newSession" ? { session, initialize: {} } : session;
      });
      const dispose = vi.fn(async (sessionId: string) => {
        if (adapterSessions.has(sessionId) && !allowLateDisposal) {
          throw new Error("late provider disposal failed");
        }
        adapterSessions.delete(sessionId);
      });
      gw.adapters.set("strict", {
        agentId: "strict", newSession: start, loadSession: start, disposeSession: dispose,
      } as unknown as AgentAdapter);
      const options = { cwd: fixtureRoot, workspaceId: "ws_target" };
      const pending = operation === "newSession"
        ? gateway.newSession("strict", options)
        : gateway.loadSession("strict", { version: 1, providerId: "strict", kind: "native", resumeId: "saved-thread" }, options);
      const settled = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      let retirement: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
        retirement = gateway.endSession("strict", executionId, { failClosed: true });
        await vi.waitFor(() => expect(stopAndProve).toHaveBeenCalledOnce());
        expect(dispose).toHaveBeenCalledOnce();

        releaseStartup();
        await vi.waitFor(() => expect(adapterSessions.has(executionId)).toBe(true));
        expect(dispose).toHaveBeenCalledOnce();
        releaseProof();
        await retirement;
        expect(await settled).toMatchObject({ ok: false, error: { failure: { kind: "lifecycle-superseded" } } });

        await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(2));
        if (failLateDisposal) {
          await gw.sessionRetirements.get(executionId)?.catch(() => undefined);
          expect(adapterSessions.has(executionId)).toBe(true);
          expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual([executionId]);
          allowLateDisposal = true;
          await gateway.endSession("strict", executionId, { failClosed: true });
          expect(dispose).toHaveBeenCalledTimes(3);
        } else {
          await vi.waitFor(() => expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual([]));
        }
        expect(adapterSessions.size).toBe(0);
        expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual([]);
      } finally {
        allowLateDisposal = true;
        releaseStartup();
        releaseProof();
        await retirement?.catch(() => undefined);
        await settled;
      }
    },
  );

  it.each(["newSession", "loadSession"] as const)("drops empty ownership after %s preparation fails before a boundary exists", async (operation) => {
    const onPrepare = vi.fn<(_: BoundaryRequest, control?: AdmissionControl) => void>();
    const executionBoundary = testExecutionBoundary({ prepareError: new Error("Admission was cancelled before allocation."), onPrepare });
    const proveFailedPreparationStopped = vi.fn<(_: string) => Promise<void>>().mockResolvedValue();
    const gateway = makeGateway({ ...executionBoundary, proveFailedPreparationStopped } as typeof executionBoundary);
    const gw = gateway as unknown as { adapters: Map<string, AgentAdapter> };
    gw.adapters.set("strict", { agentId: "strict", newSession: vi.fn(), loadSession: vi.fn() } as unknown as AgentAdapter);

    const start = operation === "newSession"
      ? gateway.newSession("strict", { cwd: fixtureRoot })
      : gateway.loadSession("strict", { version: 1, providerId: "strict", kind: "native", resumeId: "saved-thread" }, { cwd: fixtureRoot });
    await expect(start).rejects.toThrow();
    expect(onPrepare).toHaveBeenCalledOnce();
    expect(onPrepare.mock.calls[0]?.[1]).toMatchObject({ retainFailedPreparationProof: true });
    expect(gateway.workspaceSessionIds("unmanaged", fixtureRoot)).toEqual([]);
    expect(proveFailedPreparationStopped).toHaveBeenCalledOnce();
  });

  it("retains a rejected preparation's exact owner until cleanup proof succeeds on archive retry", async () => {
    let executionId = "";
    let admissionControl: AdmissionControl | undefined;
    const executionBoundary = testExecutionBoundary({ prepareError: new Error("admission failed"), onPrepare: (request, control) => { executionId = request.executionId; admissionControl = control; } });
    const proveFailedPreparationStopped = vi.fn<(_: string) => Promise<void>>().mockRejectedValueOnce(new Error("initial cleanup unproven"))
      .mockRejectedValueOnce(new Error("cleanup still unproven")).mockResolvedValue();
    const gateway = makeGateway({ ...executionBoundary, proveFailedPreparationStopped } as typeof executionBoundary);
    const gw = gateway as unknown as { adapters: Map<string, AgentAdapter> };
    gw.adapters.set("strict", { agentId: "strict", newSession: vi.fn() } as unknown as AgentAdapter);
    await expect(gateway.newSession("strict", { cwd: fixtureRoot, workspaceId: "ws_target" })).rejects.toThrow();
    expect(admissionControl).toMatchObject({ retainFailedPreparationProof: true });
    expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual([executionId]);
    await expect(gateway.endSession("strict", executionId, { failClosed: true })).rejects.toThrow("cleanup still unproven");
    expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual([executionId]);
    await expect(gateway.endSession("strict", executionId, { failClosed: true })).resolves.toBeUndefined();
    expect(gateway.workspaceOwnedSessionIds("ws_target", fixtureRoot, () => "ws_target")).toEqual([]);
    expect(proveFailedPreparationStopped.mock.calls).toEqual([[executionId], [executionId], [executionId]]);
  });

  it("does not retain failed one-shot fork preparation proof", async () => {
    const onPrepare = vi.fn<(_: BoundaryRequest, control?: AdmissionControl) => void>();
    const boundary = testExecutionBoundary({
      prepareError: new Error("one-shot admission failed"),
      onPrepare,
    });
    const gateway = makeGateway(boundary);
    const gw = gateway as unknown as {
      adapters: Map<string, AgentAdapter>;
      failedBoundaryPreparations: Set<string>;
    };
    const forkProviderBinding = vi.fn();
    gw.adapters.set("strict", { agentId: "strict", forkProviderBinding } as unknown as AgentAdapter);

    await expect(gateway.forkProviderBinding("strict", {
      version: 1, providerId: "strict", kind: "native", resumeId: "source-thread",
    }, { cwd: fixtureRoot })).rejects.toThrow();

    expect(onPrepare).toHaveBeenCalledOnce();
    expect(onPrepare.mock.calls[0]?.[1]?.retainFailedPreparationProof).not.toBe(true);
    expect(gw.failedBoundaryPreparations.size).toBe(0);
    expect(forkProviderBinding).not.toHaveBeenCalled();
  });
});

describe("AgentGateway.dispose", () => {
  it("runs every teardown stage and reports failed boundary proof", async () => {
    const gw = makeGateway() as unknown as {
      adapters: Map<string, AgentAdapter>;
      executionBoundaries: Map<string, PreparedBoundary>;
      dispose(): Promise<void>;
    };
    const calls: string[] = [];
    gw.adapters.set("strict", {
      agentId: "strict",
      dispose: async () => {
        calls.push("adapter-dispose");
        throw new Error("adapter child remains");
      },
    } as unknown as AgentAdapter);
    gw.executionBoundaries.set("s7", {
      revoke: async () => {
        calls.push("revoke");
        throw new Error("lease revocation failed");
      },
      stopAndProve: async () => {
        calls.push("stop");
        throw new Error("process proof failed");
      },
    } as unknown as PreparedBoundary);

    const error = await gw.dispose().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "lease revocation failed" }),
        expect.objectContaining({ message: "adapter child remains" }),
        expect.objectContaining({ message: "process proof failed" }),
      ]),
    );
    expect(calls).toEqual(["revoke", "adapter-dispose", "stop"]);
    expect(gw.adapters.size).toBe(0);
    expect(gw.executionBoundaries.size).toBe(0);
  });
});
