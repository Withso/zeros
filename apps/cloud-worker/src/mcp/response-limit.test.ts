import { describe, expect, it, vi } from "vitest";
import { limitMcpResponse, MAX_MCP_RESPONSE_BYTES } from "./response-limit";

function source(chunks: Uint8Array[], headers: HeadersInit = {}, status = 200) {
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { const next = chunks.shift(); if (next) controller.enqueue(next); else controller.close(); }, cancel,
  }, { highWaterMark: 0 }), { headers, status });
  return { response, cancel };
}

describe("MCP response limits", () => {
  it("bounds the decoded response bytes and cancels its source on overflow", async () => {
    const signal = new AbortController().signal;
    const allowed = source([new Uint8Array(MAX_MCP_RESPONSE_BYTES)]);
    expect((await limitMcpResponse(allowed.response, signal).arrayBuffer()).byteLength).toBe(MAX_MCP_RESPONSE_BYTES);
    const oversized = source([new Uint8Array(MAX_MCP_RESPONSE_BYTES), new Uint8Array(1)]);
    await expect(limitMcpResponse(oversized.response, signal).text()).rejects.toThrow("size limit");
    expect(oversized.cancel).toHaveBeenCalledOnce();
  });

  it.each(["\n", "\r", "\r\n"])("allows many bounded SSE events with split %j delimiters", async newline => {
    const chunks = Array.from({ length: 5 }, () => [Buffer.from(`data: ${"x".repeat(1024 * 1024)}`),
      ...[...newline, ...newline].map(character => Buffer.from(character))]).flat();
    const stream = source(chunks, { "Content-Type": "text/event-stream; charset=utf-8" });
    const text = await limitMcpResponse(stream.response, new AbortController().signal).text();
    expect(Buffer.byteLength(text)).toBeGreaterThan(MAX_MCP_RESPONSE_BYTES);
    expect(text.split(`data: `)).toHaveLength(6);
    expect(stream.cancel).not.toHaveBeenCalled();
  });

  it("bounds an unfinished SSE event and treats error text as a finite body", async () => {
    const signal = new AbortController().signal;
    for (const status of [200, 500]) {
      const chunks = status === 200 ? [Buffer.from(`data: ${"x".repeat(MAX_MCP_RESPONSE_BYTES)}`)]
        : Array.from({ length: 5 }, () => Buffer.from(`data: ${"x".repeat(1024 * 1024)}\n\n`));
      const stream = source(chunks, { "Content-Type": "text/event-stream" }, status);
      await expect(limitMcpResponse(stream.response, signal).text()).rejects.toThrow("size limit");
      expect(stream.cancel).toHaveBeenCalledOnce();
    }
  });

  it("cancels an idle reader immediately when its session is withdrawn", async () => {
    const cancel = vi.fn(), controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({ pull() {}, cancel }));
    const pending = limitMcpResponse(response, controller.signal).text();
    controller.abort(new Error("fixture session closed"));
    await expect(pending).rejects.toThrow("fixture session closed");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates consumer cancellation exactly once", async () => {
    const controller = new AbortController(), stream = source([Buffer.from("data: held\n")], { "Content-Type": "text/event-stream" });
    const reader = limitMcpResponse(stream.response, controller.signal).body!.getReader();
    await reader.read(); await reader.cancel(); controller.abort();
    expect(stream.cancel).toHaveBeenCalledOnce();
  });
});
