import { describe, expect, it, vi } from "vitest";

import type { EngineMessage } from "../../../../types";
import { ZerosEngine } from "../../../../zeros-engine";
import type { TransportClient } from "../../../../transport/types";
import {
  CodexJobBridge,
  type CodexJobRequestMessage,
} from "../codex-job-bridge";

type MessageInput = CodexJobRequestMessage extends infer M
  ? M extends CodexJobRequestMessage
    ? Omit<M, "id" | "source" | "timestamp">
    : never
  : never;

function message(value: MessageInput): CodexJobRequestMessage {
  return {
    id: "request-1",
    source: "browser",
    timestamp: 1,
    ...value,
  } as CodexJobRequestMessage;
}

function client(kind: "local" | "cloud") {
  const sent: EngineMessage[] = [];
  const value: TransportClient = {
    id: `${kind}-client`,
    kind,
    send: (msg) => sent.push(msg),
    close: vi.fn(),
  };
  return { value, sent };
}

describe("CodexJobBridge", () => {
  it("is routed by the engine dispatcher instead of falling through silently", async () => {
    const engine = new ZerosEngine({ root: process.cwd(), port: 29_940 });
    const state = engine as unknown as {
      codexJobBridge: CodexJobBridge;
      handleMessage(
        msg: EngineMessage,
        client: TransportClient,
      ): Promise<void>;
    };
    const handle = vi
      .spyOn(state.codexJobBridge, "handle")
      .mockResolvedValue(undefined);
    const local = client("local");
    const request = message({ type: "CODEX_JOB_LIST" });

    await state.handleMessage(request, local.value);

    expect(handle).toHaveBeenCalledWith(request, local.value);
  });

  it("routes local start, get, list, and cancel requests", async () => {
    const snapshot = {
      id: "job-1",
      status: "queued" as const,
      createdAt: 10,
    };
    const manager = {
      start: vi.fn(() => snapshot),
      get: vi.fn(() => snapshot),
      list: vi.fn(() => [snapshot]),
      cancel: vi.fn(() => true),
    };
    const bridge = new CodexJobBridge(async () => manager);
    const local = client("local");

    await bridge.handle(
      message({
        type: "CODEX_JOB_START",
        cwd: process.cwd(),
        prompt: "Run tests",
        networkAccessEnabled: false,
      }),
      local.value,
    );
    await bridge.handle(
      message({ type: "CODEX_JOB_GET", jobId: "job-1" }),
      local.value,
    );
    await bridge.handle(message({ type: "CODEX_JOB_LIST" }), local.value);
    await bridge.handle(
      message({ type: "CODEX_JOB_CANCEL", jobId: "job-1" }),
      local.value,
    );

    expect(manager.start).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: process.cwd(), prompt: "Run tests" }),
    );
    expect(manager.get).toHaveBeenCalledTimes(2);
    expect(manager.list).toHaveBeenCalledTimes(1);
    expect(manager.cancel).toHaveBeenCalledWith("job-1");
    expect(local.sent.map((msg) => msg.type)).toEqual([
      "CODEX_JOB_SNAPSHOT",
      "CODEX_JOB_SNAPSHOT",
      "CODEX_JOBS_LIST",
      "CODEX_JOB_SNAPSHOT",
    ]);
    expect(local.sent[0]).toMatchObject({
      requestId: "request-1",
      job: snapshot,
    });
  });

  it("fails closed for a cloud client without constructing the manager", async () => {
    const getManager = vi.fn();
    const bridge = new CodexJobBridge(getManager);
    const remote = client("cloud");

    await bridge.handle(
      message({
        type: "CODEX_JOB_START",
        cwd: "/private/host/path",
        prompt: "read host files",
      }),
      remote.value,
    );
    await bridge.handle(message({ type: "CODEX_JOB_LIST" }), remote.value);

    expect(getManager).not.toHaveBeenCalled();
    expect(remote.sent).toHaveLength(2);
    expect(remote.sent[0]).toMatchObject({
      type: "CODEX_JOB_SNAPSHOT",
      requestId: "request-1",
      job: null,
      error: { code: "LOCAL_ONLY" },
    });
    expect(remote.sent[1]).toMatchObject({
      type: "CODEX_JOBS_LIST",
      requestId: "request-1",
      jobs: [],
      error: { code: "LOCAL_ONLY" },
    });
    expect(JSON.stringify(remote.sent)).not.toContain("/private/host/path");
  });

  it("returns correlated unavailable and validation failures", async () => {
    const unavailable = new CodexJobBridge(async () => {
      throw new Error("packaged Codex runtime unavailable");
    });
    const local = client("local");
    await unavailable.handle(
      message({ type: "CODEX_JOB_GET", jobId: "job-1" }),
      local.value,
    );
    expect(local.sent[0]).toMatchObject({
      type: "CODEX_JOB_SNAPSHOT",
      requestId: "request-1",
      job: null,
      error: { code: "UNAVAILABLE" },
    });

    const invalid = new CodexJobBridge(async () => ({
      start: () => {
        throw new Error("Codex job cwd must be absolute");
      },
      get: () => null,
      list: () => [],
      cancel: () => false,
    }));
    await invalid.handle(
      message({ type: "CODEX_JOB_START", cwd: "relative", prompt: "test" }),
      local.value,
    );
    expect(local.sent[1]).toMatchObject({
      type: "CODEX_JOB_SNAPSHOT",
      requestId: "request-1",
      job: null,
      error: { code: "INVALID_REQUEST" },
    });
  });
});
