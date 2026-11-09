import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ENGINE_ASCII_MESSAGE_MIN, engineMessageJson, LocalTransport } from "../local";
import type { EngineMessage } from "../../types";

// A Design recordings reply: megabytes of base64 chunks, and one recorder
// error whose "×" (and a page named in another script) is all its non-ASCII.
function recordingsReply(error = "This frame paints on 2 composited layers (1440×900, 320×200), so it isn't recorded.") {
  const chunks = Array.from({ length: 40 }, (_, index) => ({ id: index.toString(16).padStart(32, "0"), data: "QUJD".repeat(2_048) }));
  return { type: "WORKSPACE_RESPONSE", source: "engine", requestId: "r1",
    result: { recordings: [], typefaces: [], chunks, missing: ["ページ/a.html"], deferred: [],
      failed: [{ file: "ページ/a.html", sourceVersion: "v1", error: `${error} 🎨` }] } };
}
const ascii = (text: string) => !/[^\x00-\x7f]/.test(text);

describe("engine message JSON", () => {
  it("sends a large mostly-ASCII message as pure ASCII that parses to the same value", () => {
    // Chromium decodes a WebSocket text message on its fast path only when
    // every byte is ASCII; one "×" made the renderer convert a 12 MB reply
    // to UTF-16 and JSON.parse build two-byte strings from all of it.
    const message = recordingsReply();
    const text = engineMessageJson(message);
    expect(text.length).toBeGreaterThan(ENGINE_ASCII_MESSAGE_MIN);
    expect(ascii(text)).toBe(true);
    expect(JSON.parse(text)).toEqual(message);
    expect(text).toContain("1440\\u00d7900");
    // A character outside the BMP is a pair of escapes.
    expect(text).toContain("\\ud83c\\udfa8");
  });

  it("leaves small, all-ASCII and mostly non-ASCII messages exactly as JSON.stringify writes them", () => {
    const small = { type: "WORKSPACE_RESPONSE", result: { title: "Café × 2" } };
    expect(engineMessageJson(small)).toBe(JSON.stringify(small));
    const plain = recordingsReply("Plain text.");
    plain.result.missing = ["page/a.html"];
    plain.result.failed[0]!.file = "page/a.html";
    plain.result.failed[0]!.error = "Plain text.";
    expect(engineMessageJson(plain)).toBe(JSON.stringify(plain));
    // A document in another script is two-byte either way; escaping only grows it.
    const prose = { type: "WORKSPACE_RESPONSE", result: { content: "日本語の文書。".repeat(20_000) } };
    expect(engineMessageJson(prose)).toBe(JSON.stringify(prose));
  });

  describe("over the Local transport", () => {
    let transport: LocalTransport | null = null;
    afterEach(async () => { await transport?.stop().catch(() => {}); transport = null; });

    it("broadcasts a large reply as ASCII text", async () => {
      transport = new LocalTransport({ port: 38_980 });
      await transport.start();
      const socket = new WebSocket(`ws://127.0.0.1:${transport.actualPort}/ws`);
      await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
      const received = new Promise<string>((resolve) => socket.once("message", (data) => resolve(data.toString("latin1"))));
      await new Promise((resolve) => setTimeout(resolve, 50));
      const message = recordingsReply();
      transport.broadcast(message as unknown as EngineMessage);
      // The raw bytes on the wire: Latin-1 keeps any non-ASCII byte visible.
      const raw = await received;
      expect(ascii(raw)).toBe(true);
      expect(JSON.parse(raw)).toEqual(message);
      socket.close();
    });
  });
});
