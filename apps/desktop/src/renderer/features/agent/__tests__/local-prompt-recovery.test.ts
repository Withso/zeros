import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeMessage } from "../../../platform/bridge/messages";
import type {
  RuntimeClient,
  ConnectionStatus,
} from "../../../platform/bridge/ws-client";
import {
  backfillLocalPromptTranscript,
  LocalPromptRecoveryError,
  requestLocalPrompt,
} from "../local-prompt-recovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const prompt = deferred<unknown>();
  const listeners = new Map<string, Set<(message: BridgeMessage) => void>>();
  const statuses = new Set<(status: ConnectionStatus) => void>();
  let status: ConnectionStatus = "connected";
  let current = true;
  const controller = new AbortController();
  const load = vi.fn(async () => ({
    type: "AGENT_SESSION_LOADED",
    agentId: "codex",
    executionId: "execution-a",
    sessionId: "execution-a",
    promptActive: true,
    promptId: "prompt-a",
    response: {},
  }));
  const readTurn = vi.fn(async () => ({
    type: "WORKSPACE_RESPONSE",
    op: "turns.get",
    result: {
      turn: {
        chatId: "chat-a",
        turnId: "turn-a",
        agentId: "codex",
        status: "completed",
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 10 },
      },
    },
  }));
  const request = vi.fn((message: { type: string }) => {
    if (message.type === "AGENT_PROMPT") return prompt.promise;
    if (message.type === "AGENT_LOAD_SESSION") return load();
    if (message.type === "WORKSPACE_REQUEST") return readTurn();
    throw new Error(`Unexpected request: ${message.type}`);
  });
  const bridge = {
    request,
    get status() {
      return status;
    },
    on(type: string, listener: (message: BridgeMessage) => void) {
      const bucket = listeners.get(type) ?? new Set();
      listeners.set(type, bucket);
      bucket.add(listener);
      return () => {
        bucket.delete(listener);
      };
    },
    onStatusChange(listener: (next: ConnectionStatus) => void) {
      statuses.add(listener);
      return () => {
        statuses.delete(listener);
      };
    },
  } as Pick<RuntimeClient, "request" | "on" | "onStatusChange" | "status">;
  const promise = requestLocalPrompt(
    bridge,
    {
      type: "AGENT_PROMPT",
      agentId: "codex",
      sessionId: "execution-a",
      executionId: "execution-a",
      prompt: [{ type: "text", text: "Finish the task" }],
      userMessageId: "turn-a",
      promptId: "prompt-a",
    },
    { chatId: "chat-a", signal: controller.signal, isCurrent: () => current },
  );
  // Observe immediately so deliberately rejected requests cannot become unhandled.
  const result = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const setStatus = (next: ConnectionStatus) => {
    status = next;
    for (const listener of statuses) listener(next);
  };
  return {
    prompt,
    request,
    load,
    readTurn,
    promise,
    result,
    controller,
    retire: () => {
      current = false;
    },
    setStatus,
    disconnect() {
      setStatus("disconnected");
      prompt.reject(new Error("Request timeout: engine disconnected"));
    },
    emit(
      state: "running" | "completed" | "failed" | "cancelled",
      overrides: Record<string, unknown> = {},
    ) {
      const message = {
        type: "AGENT_SESSION_UPDATE",
        agentId: "codex",
        chatId: "chat-a",
        executionId: "execution-a",
        notification: {
          sessionId: "execution-a",
          executionId: "execution-a",
          update: {
            sessionUpdate: "turn_state",
            turnId: "turn-a",
            state,
            startedAt: 1,
            ...(state === "cancelled" ? { stopReason: "cancelled" } : {}),
          },
        },
        ...overrides,
      } as unknown as BridgeMessage;
      for (const listener of listeners.get(message.type) ?? [])
        listener(message);
    },
    listenerCount: () =>
      [...listeners.values()].reduce(
        (n, bucket) => n + bucket.size,
        statuses.size,
      ),
  };
}

afterEach(() => vi.useRealTimers());

function backfillFixture() {
  let status: ConnectionStatus = "disconnected";
  let current = true;
  const statuses = new Set<(status: ConnectionStatus) => void>();
  const reconcile = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const promise = backfillLocalPromptTranscript({
    get status() { return status; },
    onStatusChange(listener) {
      statuses.add(listener);
      return () => { statuses.delete(listener); };
    },
  }, { isCurrent: () => current, reconcile });
  return {
    promise,
    reconcile,
    retire: () => { current = false; },
    setStatus(next: ConnectionStatus) {
      status = next;
      for (const listener of statuses) listener(next);
    },
    listenerCount: () => statuses.size,
  };
}

describe("Local recovered transcript barrier", () => {
  it("waits through repeated disconnects and unapplied reads before releasing follow-ups", async () => {
    vi.useFakeTimers();
    const f = backfillFixture();
    const read = deferred<boolean>();
    f.reconcile.mockImplementationOnce(() => read.promise).mockResolvedValueOnce(false);
    let settled = false;
    void f.promise.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.reconcile).not.toHaveBeenCalled();
    f.setStatus("connected");
    f.setStatus("disconnected");
    read.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    f.setStatus("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(f.promise).resolves.toBe(true);
    expect(f.reconcile).toHaveBeenCalledTimes(3);
    expect(f.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a failed history read without overlapping requests", async () => {
    vi.useFakeTimers();
    const f = backfillFixture();
    const read = deferred<boolean>();
    f.reconcile.mockImplementationOnce(() => read.promise);
    f.setStatus("connected");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.reconcile).toHaveBeenCalledOnce();
    read.reject(new Error("Request timeout: WORKSPACE_REQUEST"));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(f.promise).resolves.toBe(true);
    expect(f.reconcile).toHaveBeenCalledTimes(2);
    expect(f.listenerCount()).toBe(0);
  });

  it("releases observers when Stop or replacement invalidates a pending read", async () => {
    vi.useFakeTimers();
    const f = backfillFixture();
    const read = deferred<boolean>();
    f.reconcile.mockImplementationOnce(() => read.promise);
    f.setStatus("connected");
    f.retire();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(f.promise).resolves.toBe(false);
    read.resolve(true);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(f.reconcile).toHaveBeenCalledOnce();
    expect(f.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an unavailable transcript without authorizing queued work", async () => {
    vi.useFakeTimers();
    const f = backfillFixture();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(f.promise).resolves.toBe(false);
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.listenerCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Local prompt reconnect ownership", () => {
  it("leaves an ordinary prompt response intact", async () => {
    const f = fixture();
    const response = {
      type: "AGENT_PROMPT_COMPLETE",
      response: { stopReason: "max_tokens" },
    };
    f.prompt.resolve(response);
    await expect(f.promise).resolves.toBe(response);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.listenerCount()).toBe(0);
  });

  it("preserves the native cancellation receipt after observation is stopped", async () => {
    const f = fixture();
    const response = {
      type: "AGENT_PROMPT_COMPLETE",
      stopReason: "cancelled",
      response: { stopReason: "cancelled" },
    };
    // Stop changes the send generation before the engine acknowledges it.
    // That correlated receipt still proves delivery to this conversation.
    f.retire();
    f.prompt.resolve(response);
    await expect(f.promise).resolves.toBe(response);
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.listenerCount()).toBe(0);
  });

  it("reattaches a running turn after a socket drop without resending its prompt", async () => {
    const f = fixture();
    f.disconnect();
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    expect(
      f.request.mock.calls.filter(
        ([message]) => message.type === "AGENT_PROMPT",
      ),
    ).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "AGENT_LOAD_SESSION",
        chatId: "chat-a",
        executionId: "execution-a",
        adoptOnly: true,
      }),
      expect.anything(),
    );
    let settled = false;
    void f.result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    f.emit("completed");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
      sessionId: "execution-a",
      stopReason: "end_turn",
      response: { usage: { inputTokens: 20, outputTokens: 10 } },
    });
    expect(f.listenerCount()).toBe(0);
  });

  it("reads the exact durable turn when it completed while disconnected", async () => {
    const f = fixture();
    f.load.mockResolvedValueOnce({
      type: "AGENT_SESSION_LOADED",
      agentId: "codex",
      executionId: "execution-a",
      sessionId: "execution-a",
      promptActive: false,
      promptId: "",
      response: {},
    });
    f.disconnect();
    f.setStatus("connected");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
    });
    expect(f.request).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "WORKSPACE_REQUEST",
        op: "turns.get",
        params: { chatId: "chat-a", turnId: "turn-a" },
      }),
      expect.anything(),
    );
  });

  it("does not let another workspace or turn settle the recovered request", async () => {
    const f = fixture();
    f.disconnect();
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    f.emit("completed", { chatId: "chat-b" });
    f.emit("completed", { executionId: "execution-b" });
    f.emit("completed", {
      notification: {
        sessionId: "execution-a",
        update: {
          sessionUpdate: "turn_state",
          turnId: "turn-b",
          state: "completed",
        },
      },
    });
    expect(f.readTurn).not.toHaveBeenCalled();
    f.emit("completed");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
    });
  });

  it("does not replay a turn when the engine has lost its execution", async () => {
    const f = fixture();
    f.load.mockResolvedValueOnce({
      type: "AGENT_ERROR",
      message: "No live execution",
    } as never);
    f.readTurn.mockResolvedValueOnce({
      type: "WORKSPACE_RESPONSE",
      result: { turn: null },
    } as never);
    f.disconnect();
    f.setStatus("connected");
    await expect(f.promise).rejects.toBeInstanceOf(LocalPromptRecoveryError);
    expect(
      f.request.mock.calls.filter(
        ([message]) => message.type === "AGENT_PROMPT",
      ),
    ).toHaveLength(1);
    expect(f.listenerCount()).toBe(0);
  });

  it("preserves cancellation and never invents successful completion", async () => {
    const f = fixture();
    f.disconnect();
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    f.readTurn.mockResolvedValueOnce({
      type: "WORKSPACE_RESPONSE",
      result: { turn: null },
    } as never);
    f.emit("cancelled");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
      stopReason: "cancelled",
      response: { stopReason: "cancelled" },
    });
  });

  it("re-adopts after a second disconnect without starting a second prompt", async () => {
    const f = fixture();
    f.disconnect();
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    f.setStatus("disconnected");
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
    f.emit("completed");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
    });
    expect(
      f.request.mock.calls.filter(
        ([message]) => message.type === "AGENT_PROMPT",
      ),
    ).toHaveLength(1);
  });

  it("retries an interrupted terminal read after reconnect without replaying the prompt", async () => {
    const f = fixture();
    const terminalRead = deferred<never>();
    f.load.mockResolvedValue({
      type: "AGENT_SESSION_LOADED",
      agentId: "codex",
      executionId: "execution-a",
      sessionId: "execution-a",
      promptActive: false,
      promptId: "",
      response: {},
    });
    f.readTurn.mockImplementationOnce(() => terminalRead.promise);
    f.disconnect();
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.readTurn).toHaveBeenCalledOnce());
    f.setStatus("disconnected");
    terminalRead.reject(new Error("Request timeout: engine disconnected"));
    await Promise.resolve();
    f.setStatus("connected");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
      sessionId: "execution-a",
      stopReason: "end_turn",
    });
    expect(
      f.request.mock.calls.filter(
        ([message]) => message.type === "AGENT_PROMPT",
      ),
    ).toHaveLength(1);
    expect(f.readTurn).toHaveBeenCalledTimes(2);
    expect(f.listenerCount()).toBe(0);
  });

  it("aborts and releases listeners while recovery is waiting", async () => {
    const f = fixture();
    f.disconnect();
    f.controller.abort();
    await expect(f.promise).rejects.toMatchObject({ name: "AbortError" });
    f.setStatus("connected");
    expect(f.load).not.toHaveBeenCalled();
    expect(f.listenerCount()).toBe(0);
  });

  it("ignores a late adoption after the chat was closed or replaced", async () => {
    const f = fixture();
    const load = deferred<never>();
    f.load.mockImplementationOnce(() => load.promise);
    f.disconnect();
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    f.retire();
    load.resolve({
      type: "AGENT_SESSION_LOADED",
      executionId: "execution-a",
      promptActive: true,
    } as never);
    await expect(f.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(f.listenerCount()).toBe(0);
  });

  it("retains a completion observed before the response socket was lost", async () => {
    const f = fixture();
    f.emit("completed");
    f.disconnect();
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
    });
    expect(f.load).not.toHaveBeenCalled();
  });

  it("never reports a failed saved turn as complete", async () => {
    const f = fixture();
    f.readTurn.mockResolvedValueOnce({
      type: "WORKSPACE_RESPONSE",
      result: {
        turn: {
          chatId: "chat-a",
          turnId: "turn-a",
          agentId: "codex",
          status: "failed",
        },
      },
    } as never);
    f.disconnect();
    f.setStatus("connected");
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledOnce());
    f.emit("failed");
    await expect(f.promise).rejects.toBeInstanceOf(LocalPromptRecoveryError);
    expect(f.listenerCount()).toBe(0);
  });

  it("does not adopt a newer prompt running on the same execution", async () => {
    const f = fixture();
    f.load.mockResolvedValueOnce({
      type: "AGENT_SESSION_LOADED",
      agentId: "codex",
      executionId: "execution-a",
      sessionId: "execution-a",
      promptActive: true,
      promptId: "prompt-b",
      response: {},
    });
    f.readTurn.mockResolvedValueOnce({
      type: "WORKSPACE_RESPONSE",
      result: {
        turn: {
          chatId: "chat-a",
          turnId: "turn-a",
          agentId: "codex",
          status: "running",
        },
      },
    } as never);
    f.disconnect();
    f.setStatus("connected");
    await expect(f.promise).rejects.toBeInstanceOf(LocalPromptRecoveryError);
  });

  it("bounds an unavailable connection and drops all observers", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.disconnect();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(f.promise).rejects.toBeInstanceOf(LocalPromptRecoveryError);
    expect(f.listenerCount()).toBe(0);
    expect(f.load).not.toHaveBeenCalled();
  });

  it("does not publish a recovery error after its chat is replaced during an outage", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.disconnect();
    await Promise.resolve();
    f.retire();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(f.promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("keeps an accepted turn observed through a minute of engine overload", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let settled = false;
    void f.result.then(() => {
      settled = true;
    });
    f.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    f.setStatus("connected");
    await vi.advanceTimersByTimeAsync(0);
    f.emit("completed");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
    });
    expect(
      f.request.mock.calls.filter(
        ([message]) => message.type === "AGENT_PROMPT",
      ),
    ).toHaveLength(1);
  });

  it("retries a timed-out adoption read while the same engine remains connected", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.load.mockRejectedValueOnce(
      new Error("Request timeout: AGENT_LOAD_SESSION"),
    );
    f.disconnect();
    f.setStatus("connected");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.load).toHaveBeenCalledTimes(2);
    f.emit("completed");
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
    });
    expect(
      f.request.mock.calls.filter(
        ([message]) => message.type === "AGENT_PROMPT",
      ),
    ).toHaveLength(1);
    expect(f.listenerCount()).toBe(0);
  });

  it("retries a timed-out saved-turn read without inventing a missing execution", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.load.mockResolvedValue({
      type: "AGENT_SESSION_LOADED",
      agentId: "codex",
      executionId: "execution-a",
      sessionId: "execution-a",
      promptActive: false,
      promptId: "",
      response: {},
    });
    f.readTurn.mockRejectedValueOnce(
      new Error("Request timeout: WORKSPACE_REQUEST"),
    );
    f.disconnect();
    f.setStatus("connected");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(f.promise).resolves.toMatchObject({
      type: "AGENT_PROMPT_COMPLETE",
    });
    expect(f.readTurn).toHaveBeenCalledTimes(2);
    expect(
      f.request.mock.calls.filter(
        ([message]) => message.type === "AGENT_PROMPT",
      ),
    ).toHaveLength(1);
    expect(f.listenerCount()).toBe(0);
  });
});
