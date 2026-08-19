// gateway.endSession — per-session teardown. Verifies that closing a chat
// clears the gateway's routing maps and delegates to the owning adapter's
// disposeSession (the fix for the "live hook token + session dir + server
// child leak until app quit" finding).

import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentGateway } from "../gateway";
import type { PreparedBoundary } from "../containment/types";
import type { AgentAdapter } from "../types";
import {
  ensureSessionDir,
  removeSessionDir,
  sessionsRoot,
} from "../session-paths";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

function makeGateway() {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-test",
    executionBoundary: testExecutionBoundary(),
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
    const root = await mkdtemp(path.join(tmpdir(), "zeros-gateway-retire-proof-"));
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
    const root = await mkdtemp(path.join(tmpdir(), "zeros-gateway-stop-proof-"));
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

    await expect(gw.newSession("strict", { cwd: "/tmp" })).rejects.toThrow(
      /prior execution boundary could not be proven stopped/i,
    );
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
