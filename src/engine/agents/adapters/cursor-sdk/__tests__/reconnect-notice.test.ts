// A Cursor run stream that dies with a NETWORK error must (1) reject the
// turn RECOVERABLE (transport-closed → the renderer's shared rebuild+resend
// recovery), and (2) leave a "connection lost — reconnecting" error_notice
// row in the transcript — before this, the recovery was completely silent
// (2026-07-10, parity with the Claude adapter's exhausted-retry row).
// A NON-network stream death stays a terminal protocol-error with NO row.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CursorSdkAdapter } from "../adapter";
import type {
  AgentAdapterContext,
  ContentBlock,
  SessionNotification,
} from "../../../types";

const { createSpy, resumeSpy, sendSpy, listSpy, modelsListSpy, storeGetSpy } =
  vi.hoisted(() => ({
    createSpy: vi.fn(),
    resumeSpy: vi.fn(),
    sendSpy: vi.fn(),
    listSpy: vi.fn(),
    modelsListSpy: vi.fn(),
    storeGetSpy: vi.fn(),
  }));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: createSpy, resume: resumeSpy, list: listSpy },
  Cursor: { models: { list: modelsListSpy } },
  LocalAgentStore: {
    open: async () => ({
      runs: { get: storeGetSpy },
      dispose: async () => {},
    }),
  },
}));

const makeFailingRun = (streamError: Error) => ({
  id: "run-err",
  // The stream dies before yielding anything — that IS the test's semantics
  // (a network death mid-run), so the require-yield lint is suppressed here.
  // eslint-disable-next-line require-yield
  stream: async function* (): AsyncGenerator<unknown, void> {
    await Promise.resolve();
    throw streamError;
  },
  wait: async () => ({ status: "error" }),
  cancel: async () => {},
});

const fakeAgent = { agentId: "agent-xyz", send: sendSpy, close: () => {} };

function makeCtx(emitted: SessionNotification[]): AgentAdapterContext {
  return {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/proj/.sessions",
    emit: {
      onSessionUpdate: (_a: string, n: SessionNotification) => emitted.push(n),
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  } as unknown as AgentAdapterContext;
}

beforeAll(() => {
  process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg";
});

beforeEach(() => {
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  resumeSpy.mockReset().mockResolvedValue(fakeAgent);
  listSpy.mockReset().mockResolvedValue({ items: [] });
  modelsListSpy.mockReset().mockResolvedValue([]);
  storeGetSpy.mockReset().mockResolvedValue(null);
});

const TEXT: ContentBlock[] = [{ type: "text", text: "hi" } as ContentBlock];

describe("CursorSdkAdapter — network stream death leaves a reconnect notice", () => {
  it("network error → transport-closed + 'connection lost' error_notice", async () => {
    sendSpy
      .mockReset()
      .mockImplementation(async () =>
        makeFailingRun(new Error("read ECONNRESET while streaming")),
      );
    const emitted: SessionNotification[] = [];
    const adapter = new CursorSdkAdapter(makeCtx(emitted));
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    let kind: string | undefined;
    try {
      await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
    } catch (err) {
      kind = (err as { failure?: { kind?: string } }).failure?.kind;
    }
    expect(kind).toBe("transport-closed");

    const notice = emitted.find(
      (n) => n.update.sessionUpdate === "error_notice",
    );
    expect(notice).toBeTruthy();
    expect(notice!.sessionId).toBe(session.sessionId);
    const upd = notice!.update as {
      severity?: string;
      recoverable?: boolean;
      message?: string;
    };
    expect(upd.severity).toBe("error");
    expect(upd.recoverable).toBe(true);
    expect(upd.message).toMatch(/connection lost/i);
    expect(upd.message).toMatch(/reconnecting/i);
  });

  it("host crash mid-turn → transport-closed + reconnect row (was a hard toast)", async () => {
    // What host-client.onExit rejects live streams with when the Node host
    // dies unexpectedly: message + the CURSOR_HOST_EXITED tag.
    const hostDeath = new Error(
      "cursor host: the Cursor SDK host (Node subprocess) exited unexpectedly",
    ) as Error & { code?: string };
    hostDeath.code = "CURSOR_HOST_EXITED";
    sendSpy.mockReset().mockImplementation(async () => makeFailingRun(hostDeath));
    const emitted: SessionNotification[] = [];
    const adapter = new CursorSdkAdapter(makeCtx(emitted));
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    let kind: string | undefined;
    try {
      await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
    } catch (err) {
      kind = (err as { failure?: { kind?: string } }).failure?.kind;
    }
    expect(kind).toBe("transport-closed");
    const notice = emitted.find(
      (n) => n.update.sessionUpdate === "error_notice",
    );
    expect(notice).toBeTruthy();
    expect((notice!.update as { message?: string }).message).toMatch(
      /reconnecting/i,
    );
    await adapter.dispose();
  });

  it("non-network stream death stays terminal with NO reconnect row", async () => {
    sendSpy
      .mockReset()
      .mockImplementation(async () =>
        makeFailingRun(new Error("something entirely unrelated broke")),
      );
    const emitted: SessionNotification[] = [];
    const adapter = new CursorSdkAdapter(makeCtx(emitted));
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    let kind: string | undefined;
    try {
      await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
    } catch (err) {
      kind = (err as { failure?: { kind?: string } }).failure?.kind;
    }
    expect(kind).toBe("protocol-error");
    expect(
      emitted.some((n) => n.update.sessionUpdate === "error_notice"),
    ).toBe(false);
  });
});
