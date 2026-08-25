// Warm session-boundary adoption — after a chat session goes live, a spare
// boundary for the byte-identical request is pre-admitted in the background,
// and the next newSession with the same shape adopts it instead of paying a
// cold admission (policy build + canary) on the user's critical path.

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import type { BoundaryRequest } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zeros-warm-session-")),
  );
  roots.push(root);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
  await mkdir(path.join(root, "Zeros Design"), { recursive: true });
  await writeFile(path.join(root, "Zeros Design", ".zeros-canvas.json"), "{}\n");
  await writeFile(path.join(root, "code.ts"), "export {};\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  return root;
}

function fakeAdapter(): AgentAdapter {
  return {
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
}

describe("gateway warm session boundaries", () => {
  it("replenishes after a live session and adopts for the next identical one", async () => {
    const root = await fixture();
    const preparedIds: string[] = [];
    const gw = new AgentGateway({
      projectRoot: "/tmp/zeros-warm-test",
      executionBoundary: testExecutionBoundary({
        onPrepare: (request: BoundaryRequest) => {
          preparedIds.push(request.executionId);
        },
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const internals = gw as unknown as {
      adapters: Map<string, AgentAdapter>;
      warmSessionBoundariesInstance: { size(): number } | null;
      hasPooledUtilityCodeAuthority(): boolean;
    };
    internals.adapters.set("contained", fakeAdapter());

    const first = await gw.newSession("contained", { cwd: root });
    // The session's own admission is always the first prepare; the background
    // replenish may land at any point after the session reports live.
    expect(preparedIds[0]).toBe(first.executionId);
    await vi.waitFor(() => {
      expect(internals.warmSessionBoundariesInstance?.size() ?? 0).toBe(1);
    });
    expect(preparedIds).toHaveLength(2);
    expect(preparedIds[1]).toMatch(/^warm-/);
    // Warm entries participate in the engine's live-authority checks.
    expect(internals.hasPooledUtilityCodeAuthority()).toBe(true);

    const second = await gw.newSession("contained", { cwd: root });
    // The second session adopted the warm boundary: its own executionId never
    // reached the boundary factory.
    expect(preparedIds).not.toContain(second.executionId);

    // Adoption emptied the pool and queued the next replenish.
    await vi.waitFor(() => {
      expect(internals.warmSessionBoundariesInstance?.size() ?? 0).toBe(1);
    });
    expect(preparedIds).toHaveLength(3);
    expect(preparedIds[2]).toMatch(/^warm-/);
    await gw.dispose();
  });

  it("admits cold when the pool is disabled by configuration", async () => {
    const root = await fixture();
    process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES = "0";
    try {
      const preparedIds: string[] = [];
      const gw = new AgentGateway({
        projectRoot: "/tmp/zeros-warm-test",
        executionBoundary: testExecutionBoundary({
          onPrepare: (request: BoundaryRequest) => {
            preparedIds.push(request.executionId);
          },
        }),
        events: {
          onSessionUpdate: () => {},
          onPermissionRequest: () => {},
          onQuestionRequest: () => {},
          onAgentStderr: () => {},
          onAgentExit: () => {},
        },
      });
      const internals = gw as unknown as {
        adapters: Map<string, AgentAdapter>;
        warmSessionBoundariesInstance: { size(): number } | null;
      };
      internals.adapters.set("contained", fakeAdapter());
      const first = await gw.newSession("contained", { cwd: root });
      const second = await gw.newSession("contained", { cwd: root });
      expect(preparedIds).toEqual([
        first.executionId,
        second.executionId,
      ]);
      expect(internals.warmSessionBoundariesInstance).toBeNull();
      await gw.dispose();
    } finally {
      delete process.env.ZEROS_ZSR_WARM_SESSION_BOUNDARIES;
    }
  });
});
