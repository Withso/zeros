import { endianness } from "node:os";
import type { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import {
  dispatchCodexBrowserUseRequest,
  encodeCodexBrowserUseFrame,
} from "../codex-browser-use-pipe";

describe("Codex Browser Use native pipe", () => {
  it("frames JSON-RPC and preserves the active Codex session binding", async () => {
    const seen: Array<{ method: string; sessionId: string; turnId: string }> = [];
    const result = await dispatchCodexBrowserUseRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "getInfo",
        params: {
          session_id: "codex-session-1",
          turn_id: "turn-1",
          session_context: "live",
        },
      },
      {} as Socket,
      async (request) => {
        seen.push({
          method: request.method,
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return { type: "iab", name: "Zeros Isolated Browser" };
      },
    );

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { type: "iab", name: "Zeros Isolated Browser" },
    });
    expect(seen).toEqual([
      {
        method: "getInfo",
        sessionId: "codex-session-1",
        turnId: "turn-1",
      },
    ]);

    const framed = encodeCodexBrowserUseFrame(result);
    const length =
      endianness() === "LE" ? framed.readUInt32LE(0) : framed.readUInt32BE(0);
    expect(length).toBe(framed.byteLength - 4);
    expect(JSON.parse(framed.subarray(4).toString("utf8"))).toEqual(result);
  });

  it("fails closed when Browser Use omits its session ownership metadata", async () => {
    const result = await dispatchCodexBrowserUseRequest(
      {
        jsonrpc: "2.0",
        id: 8,
        method: "getInfo",
        params: {},
      },
      {} as Socket,
      async () => ({ ok: true }),
    );

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 8,
      error: {
        code: -32602,
        message: "Missing required browser session metadata.",
      },
    });
  });
});
