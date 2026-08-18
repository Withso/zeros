import { endianness } from "node:os";
import type { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  dispatchCodexBrowserUseRequest,
  encodeCodexBrowserUseFrame,
} from "../codex-browser-use-pipe";

describe("Codex Browser Use native pipe", () => {
  it("frames JSON-RPC and preserves the native Codex session binding", async () => {
    const seen: Array<{ method: string; sessionId: string; turnId: string }> =
      [];
    const result = await dispatchCodexBrowserUseRequest(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "getInfo",
        params: {
          session_id: "codex-session-1",
          turn_id: "turn-1",
        },
      },
      {} as Socket,
      async (request) => {
        seen.push({
          method: request.method,
          sessionId: request.sessionId,
          turnId: request.turnId,
        });
        return { type: "iab", name: "Zeros Browser" };
      },
    );

    expect(result).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { type: "iab", name: "Zeros Browser" },
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

  it("fails closed without Codex session ownership metadata", async () => {
    const result = await dispatchCodexBrowserUseRequest(
      { jsonrpc: "2.0", id: 8, method: "getInfo", params: {} },
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

  it("accepts the official sessionless ping without exposing a browser binding", async () => {
    const onRequest = vi.fn();
    const result = await dispatchCodexBrowserUseRequest(
      { jsonrpc: "2.0", id: 9, method: "ping", params: {} },
      {} as Socket,
      onRequest,
    );

    expect(result).toEqual({ jsonrpc: "2.0", id: 9, result: "pong" });
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("inherits only focusTab identity from the last authenticated request on the same socket", async () => {
    const connection = { sessionId: null, turnId: null };
    const seen: Array<{ method: string; sessionId: string; turnId: string }> =
      [];
    const onRequest = async (request: {
      method: string;
      sessionId: string;
      turnId: string;
    }) => {
      seen.push(request);
      return {};
    };
    await dispatchCodexBrowserUseRequest(
      {
        jsonrpc: "2.0",
        id: 10,
        method: "getInfo",
        params: { session_id: "codex-session-1", turn_id: "turn-1" },
      },
      {} as Socket,
      onRequest,
      connection,
    );
    const focused = await dispatchCodexBrowserUseRequest(
      {
        jsonrpc: "2.0",
        id: 11,
        method: "focusTab",
        params: { tabId: 42 },
      },
      {} as Socket,
      onRequest,
      connection,
    );

    expect(focused).toEqual({ jsonrpc: "2.0", id: 11, result: {} });
    expect(seen).toEqual([
      expect.objectContaining({
        method: "getInfo",
        sessionId: "codex-session-1",
        turnId: "turn-1",
      }),
      expect.objectContaining({
        method: "focusTab",
        sessionId: "codex-session-1",
        turnId: "turn-1",
      }),
    ]);
  });

  it("never inherits socket identity for arbitrary sessionless methods", async () => {
    const connection = {
      sessionId: "codex-session-1",
      turnId: "turn-1",
    };
    const result = await dispatchCodexBrowserUseRequest(
      { jsonrpc: "2.0", id: 12, method: "executeCdp", params: {} },
      {} as Socket,
      async () => ({}),
      connection,
    );

    expect(result).toMatchObject({
      id: 12,
      error: { code: -32602 },
    });
  });
});
