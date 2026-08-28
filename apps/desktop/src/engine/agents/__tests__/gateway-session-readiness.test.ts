import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import type { AdmissionControl, ExecutionBoundary } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const roots: string[] = [];

function gateway(
  executionBoundary: ExecutionBoundary = testExecutionBoundary(),
): AgentGateway {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-session-readiness-test",
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

function installAdapter(gw: AgentGateway, adapter: AgentAdapter): void {
  (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
    adapter.agentId,
    adapter,
  );
}

async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zeros-session-readiness-")),
  );
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("gateway session readiness", () => {
  it("starts a cold provider while behavioral attestation continues in the background", async () => {
    const root = await fixture();
    const previousWarmSetting = process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
    process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = "0";
    let passAttestation!: () => void;
    const attestation = new Promise<void>((resolve) => {
      passAttestation = resolve;
    });
    const controls: Array<AdmissionControl | undefined> = [];
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      })),
      disposeSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    const gw = gateway(
      testExecutionBoundary({
        attestation,
        onPrepare: (_request, control) => controls.push(control),
      }),
    );
    installAdapter(gw, adapter);

    try {
      const created = await gw.newSession("contained", { cwd: root });

      expect(created.executionId).toBeTruthy();
      expect(adapter.newSession).toHaveBeenCalledOnce();
      expect(controls).toHaveLength(1);
      expect(controls[0]).toMatchObject({ attestation: "background" });
    } finally {
      passAttestation();
      await attestation;
      await gw.dispose();
      if (previousWarmSetting === undefined) {
        delete process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
      } else {
        process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = previousWarmSetting;
      }
    }
  });

  it("resumes a cold provider without waiting for behavioral attestation", async () => {
    const root = await fixture();
    const previousWarmSetting = process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
    process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = "0";
    let passAttestation!: () => void;
    const attestation = new Promise<void>((resolve) => {
      passAttestation = resolve;
    });
    const controls: Array<AdmissionControl | undefined> = [];
    const adapter = {
      agentId: "contained",
      loadSession: vi.fn(
        async (opts: {
          executionId?: string;
          providerBinding?: { resumeId: string };
        }) => ({
          executionId: opts.executionId,
          providerBinding: {
            version: 1 as const,
            providerId: "contained",
            kind: "native" as const,
            resumeId: opts.providerBinding!.resumeId,
          },
        }),
      ),
      disposeSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    const gw = gateway(
      testExecutionBoundary({
        attestation,
        onPrepare: (_request, control) => controls.push(control),
      }),
    );
    installAdapter(gw, adapter);

    try {
      const loaded = await gw.loadSession(
        "contained",
        {
          version: 1,
          providerId: "contained",
          kind: "native",
          resumeId: "provider-thread",
        },
        { cwd: root },
      );

      expect(loaded.executionId).toBeTruthy();
      expect(adapter.loadSession).toHaveBeenCalledOnce();
      expect(controls).toHaveLength(1);
      expect(controls[0]).toMatchObject({ attestation: "background" });
    } finally {
      passAttestation();
      await attestation;
      await gw.dispose();
      if (previousWarmSetting === undefined) {
        delete process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
      } else {
        process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = previousWarmSetting;
      }
    }
  });

  it("interrupts a hung provider startup as soon as background protection fails", async () => {
    const root = await fixture();
    const previousWarmSetting = process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
    process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = "0";
    let failAttestation!: (error: Error) => void;
    const attestation = new Promise<void>((_resolve, reject) => {
      failAttestation = reject;
    });
    let releaseStartup!: () => void;
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const disposeSession = vi.fn(async () => {});
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(async (opts: { executionId?: string }) => {
        await startupGate;
        return {
          session: {
            executionId: opts.executionId!,
            sessionId: opts.executionId!,
          },
          initialize: {},
        };
      }),
      disposeSession,
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    const gw = gateway(testExecutionBoundary({ attestation }));
    installAdapter(gw, adapter);
    const starting = gw.newSession("contained", { cwd: root });

    try {
      await vi.waitFor(() => expect(adapter.newSession).toHaveBeenCalledOnce());
      failAttestation(
        new Error("host-parity Design write split is not enforced"),
      );
      await expect(starting).rejects.toMatchObject({
        failure: {
          kind: "design-protection-failed",
          stage: "prompt",
        },
      });
      expect(disposeSession).toHaveBeenCalled();
      releaseStartup();
      await vi.waitFor(() =>
        expect(disposeSession.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
    } finally {
      releaseStartup();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await gw.dispose();
      if (previousWarmSetting === undefined) {
        delete process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
      } else {
        process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = previousWarmSetting;
      }
    }
  });

  it("stops only the execution whose background Design-protection attestation fails", async () => {
    const root = await fixture();
    const previousWarmSetting = process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
    process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = "0";
    let failFirst!: (error: Error) => void;
    const firstAttestation = new Promise<void>((_resolve, reject) => {
      failFirst = reject;
    });
    let prepared = 0;
    const statusUpdates: Array<{
      executionId: string;
      state: string;
      failure?: string;
    }> = [];
    const prompt = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
      response: { stopReason: `completed:${sessionId}` },
    }));
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      })),
      prompt,
      disposeSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    const executionBoundary = testExecutionBoundary({
      attestation: () => {
        prepared += 1;
        return prepared === 1 ? firstAttestation : Promise.resolve();
      },
    });
    const gw = new AgentGateway({
      projectRoot: "/tmp/zeros-session-readiness-test",
      executionBoundary,
      events: {
        onSessionUpdate: () => {},
        onBoundaryStatusChanged: (_agentId, executionId, status) => {
          statusUpdates.push({
            executionId,
            state: status.state,
            failure: (status as { failure?: string }).failure,
          });
        },
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    installAdapter(gw, adapter);

    try {
      const first = await gw.newSession("contained", { cwd: root });
      const second = await gw.newSession("contained", { cwd: root });

      failFirst(new Error("host-parity Design write split is not enforced"));
      await vi.waitFor(() =>
        expect(statusUpdates).toContainEqual({
          executionId: first.executionId,
          state: "unavailable",
          failure: "design-protection-failed",
        }),
      );

      await expect(
        gw.prompt("contained", first.executionId, [
          { type: "text", text: "must not run" },
        ] as never),
      ).rejects.toMatchObject({
        failure: {
          kind: "design-protection-failed",
          stage: "prompt",
        },
      });
      await expect(
        gw.prompt("contained", second.executionId, [
          { type: "text", text: "still healthy" },
        ] as never),
      ).resolves.toMatchObject({
        stopReason: `completed:${second.executionId}`,
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(
        statusUpdates.some(
          (update) => update.executionId === second.executionId,
        ),
      ).toBe(false);
    } finally {
      await gw.dispose();
      if (previousWarmSetting === undefined) {
        delete process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
      } else {
        process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = previousWarmSetting;
      }
    }
  });

  it("holds a prompt until the in-flight adapter startup registers the session", async () => {
    const root = await fixture();
    const events: string[] = [];
    let releaseStartup = () => {};
    const startupGate = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(async (opts: { executionId?: string }) => {
        events.push("newSession:start");
        await startupGate;
        events.push("newSession:settled");
        return {
          session: {
            executionId: opts.executionId!,
            sessionId: opts.executionId!,
          },
          initialize: {},
        };
      }),
      prompt: vi.fn(async () => {
        events.push("prompt");
        return { response: { stopReason: "end_turn" } };
      }),
      disposeSession: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    const gw = gateway();
    installAdapter(gw, adapter);

    let executionId = "";
    const sessionPromise = gw.newSession("contained", {
      cwd: root,
      onExecutionCreated: (id) => {
        executionId = id;
      },
    });
    await vi.waitFor(() => {
      expect(executionId).not.toBe("");
      expect(events).toContain("newSession:start");
    });

    const promptPromise = gw.prompt("contained", executionId, [
      { type: "text", text: "hi" },
    ] as never);
    // The prompt must not reach the adapter while its startup is unsettled.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).not.toContain("prompt");

    releaseStartup();
    await sessionPromise;
    await promptPromise;
    expect(events).toEqual([
      "newSession:start",
      "newSession:settled",
      "prompt",
    ]);
  });

  it("expires a prompt for an execution this engine never admitted", async () => {
    const prompt = vi.fn(async () => ({
      response: { stopReason: "end_turn" },
    }));
    const gw = gateway();
    installAdapter(gw, {
      agentId: "contained",
      prompt,
    } as unknown as AgentAdapter);

    // Exactly what a renderer holds after an engine respawn: a live adapter,
    // and an execution id minted by the previous process. It must never reach
    // the adapter — Cursor answers that with a hard, unrecoverable refusal
    // and the user's message is dropped.
    await expect(
      gw.prompt("contained", "execution-from-a-dead-engine", [
        { type: "text", text: "hi" },
      ] as never),
    ).rejects.toMatchObject({ failure: { kind: "session-expired" } });
    expect(prompt).not.toHaveBeenCalled();
  });
});
