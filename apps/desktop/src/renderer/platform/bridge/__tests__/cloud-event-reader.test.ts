import { describe, it, expect, vi } from "vitest";
import { CloudEventReader } from "../cloud-event-reader";
import type { RuntimeClient } from "../ws-client";
import type { BridgeMessage } from "../messages";

const streamId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const listeners = new Map<string, (message: BridgeMessage) => void>();
  const request = vi.fn();
  const resnapshot = vi.fn();
  const reader = new CloudEventReader(
    {
      on: (type: string, fn: (message: BridgeMessage) => void) => {
        listeners.set(type, fn);
        return () => listeners.delete(type);
      },
      onStatusChange: () => () => {},
      request,
    } as unknown as RuntimeClient,
    resnapshot,
  );
  const emit = (sequence: number, id = streamId) =>
    listeners.get("AGENT_SESSION_UPDATE")!({
      type: "AGENT_SESSION_UPDATE",
      cloudStream: { streamId: id, sequence },
      notification: {
        sessionId: "run",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: String(sequence) },
        },
      },
    } as BridgeMessage);
  return { reader, request, emit, resnapshot };
}
describe("cloud event replay", () => {
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
