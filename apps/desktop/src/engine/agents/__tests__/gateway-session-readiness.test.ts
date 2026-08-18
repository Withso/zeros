import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import type { ExecutionBoundary } from "../containment/types";
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

  it("coalesces identical preflights and serves a short-lived cached verdict", async () => {
    const root = await fixture();
    const onPrepare = vi.fn();
    const gw = gateway(testExecutionBoundary({ onPrepare }));
    installAdapter(gw, { agentId: "contained" } as AgentAdapter);
    const cwd = path.join(root, "src");

    const [first, second] = await Promise.all([
      gw.preflightSession("contained", { cwd }),
      gw.preflightSession("contained", { cwd }),
    ]);
    const third = await gw.preflightSession("contained", { cwd });

    expect(onPrepare).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.state).toBe("ready");

    // A different request shape is a different verdict — never share it.
    await gw.preflightSession("contained", { cwd: root });
    expect(onPrepare).toHaveBeenCalledTimes(2);
  });

  it("caches a failed preflight only briefly", async () => {
    const root = await fixture();
    const onPrepare = vi.fn();
    const gw = gateway(
      testExecutionBoundary({
        onPrepare,
        prepareError: new Error("provider overlay is unavailable"),
      }),
    );
    installAdapter(gw, { agentId: "contained" } as AgentAdapter);
    const cwd = path.join(root, "src");

    const first = await gw.preflightSession("contained", { cwd });
    const second = await gw.preflightSession("contained", { cwd });
    expect(first.state).toBe("unavailable");
    expect(second).toEqual(first);
    expect(onPrepare).toHaveBeenCalledTimes(1);
  });
});
