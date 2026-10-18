// Local provider connection changes for a live Codex thread. The app-server
// reads its credential and CODEX_HOME only at spawn, so a change must restart
// this execution's child under the new connection and resume the SAME thread
// before the next turn — never interrupt a running turn, never require the
// user to reconnect the chat.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapterContext, ContentBlock, ProviderCredentialUpdate } from "../../../types";

const rt = vi.hoisted(() => ({
  boots: [] as Array<{
    env?: Record<string, string>;
    cliBinary?: string;
    disposed: boolean;
    resumed: Array<{ threadId: string }>;
    turns: Array<{ threadId?: string }>;
  }>,
  runTurnImpl: null as
    | null
    | ((boot: number, params: { threadId?: string }) => Promise<unknown>),
  /** Thread a boot's `thread/start` creates; resume failures fall back to it. */
  startedThread: (boot: number) => (boot === 0 ? "thread-1" : `thread-${boot + 1}`),
  resumeFailure: null as null | Error,
}));

vi.mock("../app-server", () => ({
  bootCodexAppServerRuntime: vi.fn(
    async (opts: { env?: Record<string, string>; cliBinary?: string }) => {
      const boot = rt.boots.length;
      const record = {
        env: opts.env,
        cliBinary: opts.cliBinary,
        disposed: false,
        resumed: [] as Array<{ threadId: string }>,
        turns: [] as Array<{ threadId?: string }>,
      };
      rt.boots.push(record);
      const request = vi.fn(async (method: string) => {
        if (method === "config/read") return { config: {} };
        if (method === "model/list") return { data: [] };
        return {};
      });
      return {
        initializeResponse: { userAgent: "codex_cli 0.162.1", codexHome: "/tmp" },
        cliVersion: "0.162.1",
        binarySource: { source: "path", path: "codex" },
        child: { pid: 1000 + boot, killed: false },
        startThread: async () => ({ threadId: rt.startedThread(boot), model: "gpt-5", raw: {} }),
        resumeThread: async (params: { threadId: string }) => {
          record.resumed.push({ threadId: params.threadId });
          if (rt.resumeFailure) throw rt.resumeFailure;
          return { threadId: params.threadId, raw: {} };
        },
        runTurn: async (
          params: { threadId?: string },
          o: { onTurnStarted?: (id: string) => void },
        ) => {
          record.turns.push({ threadId: params.threadId });
          o.onTurnStarted?.(`turn-${boot}`);
          if (rt.runTurnImpl) return rt.runTurnImpl(boot, params);
          return { turnId: `turn-${boot}`, status: "completed", raw: {} };
        },
        interruptTurn: async () => {},
        respondToPermission: () => {},
        onNotification: () => () => {},
        request,
        requestTyped: request,
        dispose: async () => {
          record.disposed = true;
        },
      };
    },
  ),
}));

vi.mock("../../session-paths", () => ({
  ensureSessionDir: vi.fn(async () => ({
    root: "/tmp/s",
    env: "/tmp/s/env",
    log: "/tmp/s/log",
    telemetry: "/tmp/s/tel",
  })),
  writeSessionMeta: vi.fn(async () => {}),
  removeSessionDir: vi.fn(async () => {}),
}));

import { CodexAppServerAdapter, type CodexSession } from "../app-server-adapter";

const TEXT = (text: string): ContentBlock[] => [{ type: "text", text } as never];
const KEYS = ["OPENAI_API_KEY", "CODEX_HOME"] as const;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rt.boots = [];
  rt.runTurnImpl = null;
  rt.resumeFailure = null;
});

function makeAdapter() {
  const emit = {
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
    onQuestionRequest: vi.fn(),
    onAgentStderr: vi.fn(),
    onAgentExit: vi.fn(),
  };
  const ctx: AgentAdapterContext = {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/sessions",
    emit,
    authenticationContext: () => "account-b",
  };
  const adapter = new CodexAppServerAdapter(ctx);
  cleanups.push(() => adapter.dispose());
  const update = (sessionId: string, env: Record<string, string>): Promise<void> =>
    adapter.capabilityPorts.runtimeConfiguration.updateCredentials({
      sessionId,
      keys: KEYS,
      env,
      authenticationContext: "account-b",
    } satisfies ProviderCredentialUpdate);
  return { adapter, emit, update };
}

describe("Codex Local connection changes", () => {
  it("resumes the same thread in a new app-server under the new connection", async () => {
    const { adapter, emit, update } = makeAdapter();
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { OPENAI_API_KEY: "old-fixture-key", ZEROS_THINKING_EFFORT: "high" },
    });
    await adapter.setMode({ sessionId: session.sessionId, modeId: "read-only" });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("first") });

    await update(session.sessionId, { OPENAI_API_KEY: "new-fixture-key" });

    expect(rt.boots).toHaveLength(2);
    expect(rt.boots[0]!.disposed).toBe(true);
    expect(rt.boots[1]!.env).toMatchObject({
      OPENAI_API_KEY: "new-fixture-key",
      // Composer configuration survives; only connection variables change.
      ZEROS_THINKING_EFFORT: "high",
    });
    expect(rt.boots[1]!.resumed).toEqual([{ threadId: "thread-1" }]);

    await expect(
      adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("second") }),
    ).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(rt.boots[1]!.turns).toEqual([{ threadId: "thread-1" }]);
    const internal = adapter as unknown as {
      sessions: Map<string, { modeId: string }>;
    };
    expect(internal.sessions.get(session.sessionId)?.modeId).toBe("read-only");
    // An in-place restart is not a crash the chat should reconnect from.
    expect(emit.onAgentExit).not.toHaveBeenCalled();
  });

  it("lets a running turn finish on its process and switches at the next turn", async () => {
    const { adapter, update } = makeAdapter();
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { OPENAI_API_KEY: "old-fixture-key" },
    });
    let finish!: () => void;
    rt.runTurnImpl = (boot) =>
      boot === 0
        ? new Promise((resolve) => {
            finish = () => resolve({ turnId: "turn-0", status: "completed", raw: {} });
          })
        : Promise.resolve({ turnId: `turn-${boot}`, status: "completed", raw: {} });
    const running = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("long") });
    await vi.waitFor(() => expect(rt.boots[0]!.turns).toHaveLength(1));

    await update(session.sessionId, { OPENAI_API_KEY: "new-fixture-key" });
    expect(rt.boots).toHaveLength(1);
    expect(rt.boots[0]!.disposed).toBe(false);

    finish();
    await expect(running).resolves.toMatchObject({ stopReason: "end_turn" });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("next") });
    expect(rt.boots).toHaveLength(2);
    expect(rt.boots[1]!.env?.OPENAI_API_KEY).toBe("new-fixture-key");
    expect(rt.boots[1]!.resumed).toEqual([{ threadId: "thread-1" }]);
    expect(rt.boots[1]!.turns).toEqual([{ threadId: "thread-1" }]);
  });

  it("carries the thread's rollout when the new account uses another CODEX_HOME", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-codex-switch-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const accountA = path.join(root, "account-a"), accountB = path.join(root, "account-b");
    const relative = path.join("sessions", "2026", "10", "18", "rollout-2026-10-18T07-45-57-thread-1.jsonl");
    await mkdir(path.dirname(path.join(accountA, relative)), { recursive: true });
    await writeFile(path.join(accountA, relative), '{"type":"session_meta","payload":{"id":"thread-1"}}\n');
    const { adapter, update } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj", env: { CODEX_HOME: accountA } });

    await update(session.sessionId, { CODEX_HOME: accountB });

    expect(rt.boots[1]!.env?.CODEX_HOME).toBe(accountB);
    await expect(readFile(path.join(accountB, relative), "utf8")).resolves.toContain('"id":"thread-1"');
    // The original account keeps its history.
    await expect(readFile(path.join(accountA, relative), "utf8")).resolves.toContain("thread-1");
  });

  it.each([false, true])("honors Stop while the next prompt restarts a staged connection (fresh thread: %s)", async (fresh) => {
    const { adapter, update } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj", env: { OPENAI_API_KEY: "old-fixture-key" } });
    let finishTurn!: () => void;
    rt.runTurnImpl = (boot) => boot === 0
      ? new Promise((resolve) => { finishTurn = () => resolve({ turnId: "turn-0", status: "completed", raw: {} }); })
      : Promise.resolve({ turnId: `turn-${boot}`, status: "completed", raw: {} });
    const first = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("first") });
    await vi.waitFor(() => expect(rt.boots[0]!.turns).toHaveLength(1));
    await update(session.sessionId, { OPENAI_API_KEY: "new-fixture-key" });
    finishTurn();
    await first;
    if (fresh) rt.resumeFailure = new Error("no rollout found for thread id thread-1");

    const internals = adapter as unknown as { sessions: Map<string, CodexSession> };
    const old = internals.sessions.get(session.sessionId)!;
    let finishDispose!: () => void;
    vi.spyOn(old.runtime, "dispose").mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishDispose = resolve; }),
    );
    const next = adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("must not run after Stop") });
    try {
      await vi.waitFor(() => expect(internals.sessions.has(session.sessionId)).toBe(false));
      await adapter.cancel({ sessionId: session.sessionId });
      finishDispose();
      await expect(next).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(rt.boots[1]?.turns ?? []).toHaveLength(0);
      if (fresh) {
        await expect(adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("new user send") }))
          .rejects.toMatchObject({ failure: { kind: "session-expired" } });
        expect(rt.boots[1]!.turns).toHaveLength(0);
      }
      await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("new user send") });
      expect(rt.boots[1]!.turns).toHaveLength(1);
    } finally {
      finishDispose?.();
      await next.catch(() => {});
    }
  });

  it("publishes the new thread when the new home cannot resume the old one", async () => {
    const { adapter, emit, update } = makeAdapter();
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { OPENAI_API_KEY: "old-fixture-key" },
    });
    rt.resumeFailure = new Error("no rollout found for thread id thread-1");
    await update(session.sessionId, { OPENAI_API_KEY: "new-fixture-key" });
    expect(rt.boots[1]!.resumed).toEqual([{ threadId: "thread-1" }]);
    expect(emit.onSessionUpdate).toHaveBeenCalledWith("codex", {
      executionId: session.sessionId,
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "provider_binding_update",
        providerBinding: expect.objectContaining({ providerId: "codex", resumeId: "thread-2" }),
        resumedFresh: true,
      },
    });
    // This prompt was built before adoption knew it needed history. Recover
    // through loadSession so the renderer can prepend its bounded replay.
    await expect(adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("next") }))
      .rejects.toMatchObject({ failure: { kind: "session-expired", stage: "prompt" } });
    expect(rt.boots[1]!.turns).toHaveLength(0);
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("previous conversation, then next") });
    expect(rt.boots[1]!.turns).toEqual([{ threadId: "thread-2" }]);
  });

  it("keeps an empty thread's replay pending across another connection change", async () => {
    const { adapter, update } = makeAdapter();
    const { session } = await adapter.newSession({ cwd: "/tmp/proj", env: { OPENAI_API_KEY: "fixture-a" } });
    rt.resumeFailure = new Error("no rollout found for thread id thread-1");
    await update(session.sessionId, { OPENAI_API_KEY: "fixture-b" });
    rt.resumeFailure = null;
    await update(session.sessionId, { OPENAI_API_KEY: "fixture-c" });
    expect(rt.boots[2]!.resumed).toEqual([{ threadId: "thread-2" }]);
    await expect(adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("next") }))
      .rejects.toMatchObject({ failure: { kind: "session-expired" } });
    expect(rt.boots[2]!.turns).toHaveLength(0);
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT("previous conversation, then next") });
    expect(rt.boots[2]!.turns).toEqual([{ threadId: "thread-2" }]);
  });

  it("returns to the default CLI home when a saved account is deselected", async () => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-codex-home-")));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const { adapter, update } = makeAdapter();
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { HOME: home, CODEX_HOME: path.join(home, "account"), OPENAI_API_KEY: "" },
    });
    await update(session.sessionId, { OPENAI_API_KEY: "" });
    expect(rt.boots[1]!.env).not.toHaveProperty("CODEX_HOME");
    expect(rt.boots[1]!.env?.OPENAI_API_KEY).toBe("");
  });
});
