import { describe, it, expect, vi } from "vitest";
import { CloudEventReader } from "../cloud-event-reader";
import type { ConnectionStatus, RuntimeClient } from "../ws-client";
import type { BridgeMessage } from "../messages";

const streamId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const listeners = new Map<string, (message: BridgeMessage) => void>();
  const request = vi.fn(async (message: any): Promise<any> => ({ type: "WORKSPACE_RESPONSE", result: {
    streamId: message.params.request.cursor.streamId, head: message.params.request.cursor.sequence, cursor: message.params.request.cursor.sequence, firstRetained: 1, events: [],
  } }));
  const resnapshot = vi.fn();
  let status!: (value: ConnectionStatus) => void;
  const reader = new CloudEventReader(
    {
      on: (type: string, fn: (message: BridgeMessage) => void) => {
        listeners.set(type, fn);
        return () => listeners.delete(type);
      },
      onStatusChange: (listener: typeof status) => { status = listener; return () => {}; },
      request,
    } as unknown as RuntimeClient,
    resnapshot,
  );
  const emit = (sequence: number, id = streamId, execution = "run") =>
    listeners.get("AGENT_SESSION_UPDATE")!({
      type: "AGENT_SESSION_UPDATE",
      cloudStream: { streamId: id, sequence },
      notification: {
        sessionId: execution,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: String(sequence) },
        },
      },
    } as BridgeMessage);
  const admission = () => listeners.get("AGENT_SESSION_CREATED")!({
    type: "AGENT_SESSION_CREATED", agentId: "codex", session: { sessionId: "run" },
  } as BridgeMessage);
  return { reader, request, emit, resnapshot, status, admission };
}
describe("cloud event replay", () => {
  it("keeps unrelated unsequenced admissions live during an owned snapshot", () => {
    const f = fixture(), created = vi.fn();
    f.reader.on("AGENT_SESSION_CREATED", created);
    const stalled = f.reader.beginSnapshot({ conversationId: "other", executionId: "other-run" });
    f.admission();
    expect(created).toHaveBeenCalledOnce(); expect(stalled.current()).toBe(true);
    expect(f.resnapshot).not.toHaveBeenCalled(); f.reader.dispose();
  });
  it("refreshes only the ambiguous owner on an unsequenced admission", () => {
    const f = fixture(), a = f.reader.beginSnapshot({ conversationId: "chat", executionId: "run" }),
      b = f.reader.beginSnapshot({ conversationId: "other", executionId: "other-run" });
    f.admission();
    expect(a.current()).toBe(false); expect(b.current()).toBe(true);
    expect(f.resnapshot).toHaveBeenCalledWith("chat"); f.reader.dispose();
  });
  it("refetches only the attachment when its missing prefix contains a truncated frame", async () => {
    const f = fixture(), delivered = vi.fn();
    f.reader.on("AGENT_SESSION_UPDATE", delivered);
    const stalled = f.reader.beginSnapshot({ conversationId: "chat", executionId: "run" });
    f.emit(20, streamId, "other-run"); delivered.mockClear();
    f.request.mockImplementation(async message => {
      const after = message.params.request.cursor.sequence;
      return { type: "WORKSPACE_RESPONSE", result: { streamId, head: 20, cursor: after === 10 ? 19 : after, firstRetained: 1,
        events: after === 10 ? Array.from({ length: 9 }, (_, i) => ({ sequence: 11 + i, frame: { type: "AGENT_SESSION_UPDATE",
          notification: { sessionId: "run" }, cloudStream: { streamId, sequence: 11 + i, requiresSnapshot: true } } })) : [],
      } };
    });
    stalled.install({ streamId, sequence: 10 }, { conversationId: "chat", executionId: "run" }); stalled.finish();
    await vi.waitFor(() => expect(f.resnapshot).toHaveBeenCalledWith("chat"));
    expect(delivered).not.toHaveBeenCalled(); f.emit(21, streamId, "other-run"); expect(delivered).toHaveBeenCalledOnce(); f.reader.dispose();
  });
  it.each([false, true])("recovers an initial attachment's unread prefix without rewinding the shared cursor (live=%s)", async live => {
    const f = fixture(), delivered: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => delivered.push(message.cloudStream!.sequence));
    f.request.mockImplementation(async message => {
      const after = message.params.request.cursor.sequence;
      return { type: "WORKSPACE_RESPONSE", result: { streamId, head: 20, cursor: 20, firstRetained: 1,
        events: Array.from({ length: Math.max(0, 20 - after) }, (_, i) => ({ sequence: after + i + 1, frame: {
          type: "AGENT_SESSION_UPDATE", cloudStream: { streamId, sequence: after + i + 1 }, notification: { sessionId: "other-run" },
        } })) } };
    });
    const a = f.reader.beginSnapshot({ conversationId: "a", executionId: "run" });
    const b = f.reader.beginSnapshot({ conversationId: "b", executionId: "other-run" });
    if (live) f.emit(20, streamId, "other-run");
    a.install({ streamId, sequence: 20 }, { conversationId: "a", executionId: "run" }); a.finish();
    b.install({ streamId, sequence: 10 }, { conversationId: "b", executionId: "other-run" }); b.finish();
    await vi.waitFor(() => expect(delivered).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]));
    f.reader.dispose();
  });
  it.each(["run", "other-run"])("never replays already-drained initial-attach frames (%s)", async execution => {
    const f = fixture(), delivered: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => delivered.push(message.cloudStream!.sequence));
    f.request.mockImplementation(async message => {
      const cursor = message.params.request.cursor.sequence;
      return { type: "WORKSPACE_RESPONSE", result: { streamId, head: 6, cursor: 6, firstRetained: 1,
        events: cursor < 6 ? [{ sequence: 6, frame: { type: "AGENT_SESSION_UPDATE", cloudStream: { streamId, sequence: 6 }, notification: { sessionId: execution } } }] : [] } };
    });
    const restoring = f.reader.beginSnapshot({ conversationId: "chat", executionId: "run" });
    f.emit(6, streamId, execution);
    restoring.install({ streamId, sequence: 5 }, { conversationId: "chat", executionId: "run" });
    restoring.finish(); await vi.waitFor(() => expect(f.request).toHaveBeenCalled());
    await Promise.resolve(); expect(delivered).toEqual([6]); f.reader.dispose();
  });
  it("keeps another conversation live while one snapshot is stalled", () => {
    const f = fixture(), delivered: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => delivered.push(message.cloudStream!.sequence));
    f.emit(1);
    const stalled = f.reader.beginSnapshot({ conversationId: "chat", executionId: "run" });
    f.emit(2); f.emit(3, streamId, "other-run");
    expect(delivered).toEqual([1, 3]);
    stalled.install({ streamId, sequence: 2 }, { conversationId: "chat", executionId: "run" });
    f.emit(4); expect(delivered).toEqual([1, 3]);
    stalled.finish(); expect(delivered).toEqual([1, 3, 4]); f.reader.dispose();
  });
  it("refetches an ambiguous snapshot instead of applying unsequenced session metadata after it", () => {
    const f = fixture(), created = vi.fn();
    f.reader.on("AGENT_SESSION_CREATED", created);
    const old = f.reader.beginSnapshot();
    f.admission();
    // The snapshot may already include the turn's completion. A metadata
    // frame without a cursor cannot prove that it belongs after that state.
    expect(old.current()).toBe(false);
    expect(f.resnapshot).toHaveBeenCalledOnce();
    expect(() => old.install({ streamId, sequence: 10 }, { conversationId: "chat", executionId: "run" })).toThrow(/retired/);
    const current = f.reader.beginSnapshot();
    current.install({ streamId, sequence: 10 }, { conversationId: "chat", executionId: "run" });
    current.finish(); old.finish();
    expect(created).not.toHaveBeenCalled();
    f.reader.dispose();
  });
  it("revalidates Git views only for the current connected epoch", async () => {
    const f = fixture(), changed = vi.fn();
    f.reader.on("DB_CHANGED", changed);
    f.status("connected"); f.status("disconnected");
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    f.status("connected"); await Promise.resolve();
    expect(changed).toHaveBeenCalledWith({ type: "DB_CHANGED", kinds: ["files", "git"] });
    f.reader.dispose();
  });
  it("replays a lost final event after a replacement snapshot even if the retired replay finishes later", async () => {
    const f = fixture(), nextStream = "22222222-2222-4222-8222-222222222222", delivered: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => delivered.push(message.cloudStream!.sequence));
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", result: {
        streamId: nextStream, head: 11, firstRetained: 1, cursor: 11,
        events: [{ sequence: 11, frame: { type: "AGENT_SESSION_UPDATE", cloudStream: { streamId: nextStream, sequence: 11 } } }],
      } });
    f.emit(1); f.emit(3);
    f.status("disconnected");
    const restoring = f.reader.beginSnapshot();
    restoring.install({ streamId: nextStream, sequence: 10 }, { conversationId: "chat", executionId: "run" });
    restoring.finish();
    finish({ type: "WORKSPACE_ERROR", code: "event_stream_changed" });
    await vi.waitFor(() => expect(delivered).toEqual([1, 11]));
    expect(f.resnapshot).not.toHaveBeenCalled();
    f.reader.dispose();
  });
  it("holds live frames until a snapshot is installed, then emits only events after its cursor", async () => {
    const f = fixture(), delivered: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => delivered.push(message.cloudStream!.sequence));
    const restoring = f.reader.beginSnapshot();
    f.emit(11); f.emit(12);
    expect(delivered).toEqual([]);
    restoring.install({ streamId, sequence: 10 }, { conversationId: "chat", executionId: "run" });
    expect(delivered).toEqual([]);
    restoring.finish();
    expect(delivered).toEqual([11, 12]);
    f.emit(11); expect(delivered).toEqual([11, 12]);
    f.reader.dispose();
  });
  it("does not skip another conversation when snapshots have different cursors", async () => {
    const f = fixture(), delivered: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => delivered.push(message.cloudStream!.sequence));
    f.emit(1);
    const first = f.reader.beginSnapshot(), second = f.reader.beginSnapshot();
    f.emit(2); f.emit(3);
    first.install({ streamId, sequence: 2 }, { conversationId: "chat", executionId: "run" });
    second.install({ streamId, sequence: 3 }, { conversationId: "other", executionId: "other-run" });
    second.finish(); expect(delivered).toEqual([1]);
    first.finish(); expect(delivered).toEqual([1, 3]);
    f.reader.dispose();
  });
  it("retires pending snapshot and replay work when the stream changes", () => {
    const f = fixture();
    f.emit(1);
    const restoring = f.reader.beginSnapshot();
    f.emit(1, "22222222-2222-4222-8222-222222222222");
    expect(() => restoring.install({ streamId, sequence: 1 }, { conversationId: "chat" })).toThrow(/retired/);
    restoring.finish(); f.reader.dispose();
  });
  it("does not reset a replacement stream when the previous replay fails late", async () => {
    const f = fixture();
    const nextStream = "22222222-2222-4222-8222-222222222222";
    const received: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => received.push(message.cloudStream!.sequence));
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", result: {
        streamId: nextStream, head: 12, firstRetained: 1, cursor: 12,
        events: [11, 12].map(sequence => ({ sequence,
          frame: { type: "AGENT_SESSION_UPDATE", cloudStream: { streamId: nextStream, sequence } },
        })),
      } });
    f.emit(1);
    f.emit(3);
    f.emit(10, nextStream);
    f.emit(12, nextStream);
    finish({ type: "WORKSPACE_ERROR", code: "event_stream_changed" });
    await vi.waitFor(() => expect(received).toEqual([1, 10, 11, 12]));
    expect(f.resnapshot).toHaveBeenCalledOnce();
    f.reader.dispose();
  });
  it("continues replay when a second live gap arrives during the first request", async () => {
    const f = fixture();
    const received: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", message => received.push(message.cloudStream!.sequence));
    const page = (sequences: number[]) => ({
      type: "WORKSPACE_RESPONSE",
      result: {
        streamId, head: sequences.at(-1), firstRetained: 1, cursor: sequences.at(-1),
        events: sequences.map(sequence => ({ sequence,
          frame: { type: "AGENT_SESSION_UPDATE", cloudStream: { streamId, sequence } },
        })),
      },
    });
    let finish!: (value: unknown) => void;
    f.request.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(page([4, 5]));
    f.emit(1);
    f.emit(3); // First replay captured journal head 3.
    f.emit(5); // The final frame arrives before that replay returns; no more live frames follow.
    finish(page([2, 3]));
    await vi.waitFor(() => expect(received).toEqual([1, 2, 3, 4, 5]));
    expect(f.request).toHaveBeenCalledTimes(2);
    f.reader.dispose();
  });
  it("fills a live gap once before publishing the later frame", async () => {
    const f = fixture();
    const received: number[] = [];
    f.reader.on("AGENT_SESSION_UPDATE", (message) =>
      received.push(message.cloudStream!.sequence),
    );
    f.request.mockResolvedValue({
      type: "WORKSPACE_RESPONSE",
      result: {
        streamId,
        head: 3,
        firstRetained: 1,
        cursor: 3,
        events: [2, 3].map((sequence) => ({
          sequence,
          frame: {
            type: "AGENT_SESSION_UPDATE",
            cloudStream: { streamId, sequence },
          },
        })),
      },
    });
    f.emit(1);
    f.emit(3);
    await vi.waitFor(() => expect(received).toEqual([1, 2, 3]));
    f.emit(2);
    f.emit(3);
    expect(received).toEqual([1, 2, 3]);
    expect(f.request).toHaveBeenCalledOnce();
    f.reader.dispose();
  });
  it("requests normalized state when the engine stream changes", () => {
    const f = fixture();
    const changed = vi.fn();
    f.reader.on("DB_CHANGED", changed);
    f.emit(10);
    f.emit(1, "22222222-2222-4222-8222-222222222222");
    expect(changed).toHaveBeenCalledOnce();
    expect(f.resnapshot).toHaveBeenCalledOnce();
    f.reader.dispose();
  });
});
