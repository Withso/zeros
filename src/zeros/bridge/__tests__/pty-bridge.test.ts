import { describe, it, expect } from "vitest";
import {
  bridgePtyCreate,
  bridgePtyWrite,
  bridgePtyResize,
  bridgePtyKill,
  bridgePtyList,
  bridgePtyTerminals,
  subscribeBridgePtyData,
  subscribeBridgePtyExit,
  subscribeBridgePtyTerminalsChanged,
} from "../pty-bridge";
import type { RuntimeClient } from "../ws-client";

describe("pty-bridge", () => {
  it("bridgePtyCreate sends PTY_CREATE and maps PTY_CREATED → PtySessionInfo", async () => {
    let sent: { type?: string } = {};
    const bridge = {
      request: async (m: { type: string }) => {
        sent = m;
        return {
          type: "PTY_CREATED",
          requestId: "r",
          sessionId: "s1",
          pid: 42,
          cwd: "/w",
          cols: 80,
          rows: 24,
        };
      },
    } as unknown as RuntimeClient;
    const info = await bridgePtyCreate(bridge, {
      sessionId: "s1",
      cwd: "/w",
      cols: 80,
      rows: 24,
    });
    expect(sent.type).toBe("PTY_CREATE");
    expect(info).toMatchObject({
      sessionId: "s1",
      pid: 42,
      cwd: "/w",
      shell: "",
      cols: 80,
      rows: 24,
    });
    // A FRESH spawn carries no snapshot → reattach fields stay undefined.
    expect((info as { replay?: string }).replay).toBeUndefined();
    expect((info as { reattached?: boolean }).reattached).toBeUndefined();
  });

  it("bridgePtyCreate passes a reattach snapshot (reattached + replay) through", async () => {
    const bridge = {
      request: async () => ({
        type: "PTY_CREATED",
        requestId: "r",
        sessionId: "s2",
        pid: 7,
        cwd: "/w",
        cols: 80,
        rows: 24,
        reattached: true,
        replay: "\x1b[2JHELLO",
        replayTruncated: false,
        replayBytes: 9,
      }),
    } as unknown as RuntimeClient;
    const info = await bridgePtyCreate(bridge, {
      sessionId: "s2",
      cwd: "/w",
      cols: 80,
      rows: 24,
    });
    expect(info).toMatchObject({
      sessionId: "s2",
      reattached: true,
      replay: "\x1b[2JHELLO",
      replayTruncated: false,
      replayBytes: 9,
    });
  });

  it("bridgePtyCreate returns null on a failed/denied request (timeout)", async () => {
    const bridge = {
      request: async () => {
        throw new Error("timeout");
      },
    } as unknown as RuntimeClient;
    expect(
      await bridgePtyCreate(bridge, {
        sessionId: "s",
        cwd: "/",
        cols: 1,
        rows: 1,
      }),
    ).toBeNull();
  });

  it("write/resize/kill fire the right fire-and-forget messages", () => {
    const sent: Array<{ type: string }> = [];
    const bridge = {
      send: (m: { type: string }) => sent.push(m),
    } as unknown as RuntimeClient;
    bridgePtyWrite(bridge, { sessionId: "s", data: "ls\n" });
    bridgePtyResize(bridge, { sessionId: "s", cols: 120, rows: 40 });
    bridgePtyKill(bridge, { sessionId: "s" });
    expect(sent).toEqual([
      { type: "PTY_WRITE", sessionId: "s", data: "ls\n" },
      { type: "PTY_RESIZE", sessionId: "s", cols: 120, rows: 40 },
      { type: "PTY_KILL", sessionId: "s" },
    ]);
  });

  it("subscriptions map PTY_DATA / PTY_EXIT and return the unsubscribe fn", () => {
    let dataCb: ((m: unknown) => void) | null = null;
    let exitCb: ((m: unknown) => void) | null = null;
    const off = () => {};
    const bridge = {
      on: (type: string, h: (m: unknown) => void) => {
        if (type === "PTY_DATA") dataCb = h;
        if (type === "PTY_EXIT") exitCb = h;
        return off;
      },
    } as unknown as RuntimeClient;

    const data: unknown[] = [];
    const unsub = subscribeBridgePtyData(bridge, (e) => data.push(e));
    dataCb!({ type: "PTY_DATA", sessionId: "s1", data: "out" });
    expect(data).toEqual([{ sessionId: "s1", data: "out" }]);
    expect(unsub).toBe(off);

    const exits: unknown[] = [];
    subscribeBridgePtyExit(bridge, (e) => exits.push(e));
    exitCb!({
      type: "PTY_EXIT",
      sessionId: "s1",
      exitCode: null,
      signal: null,
      reason: "spawn-failed",
    });
    expect(exits).toEqual([
      {
        sessionId: "s1",
        exitCode: null,
        signal: null,
        reason: "spawn-failed",
      },
    ]);
  });

  it("bridgePtyList returns [] (legacy native shape; shared list is separate)", async () => {
    expect(await bridgePtyList({} as RuntimeClient)).toEqual([]);
  });

  it("bridgePtyTerminals sends PTY_LIST and returns the shared terminal list", async () => {
    let sent: { type?: string; workspaceId?: string } = {};
    const bridge = {
      request: async (m: { type: string; workspaceId?: string }) => {
        sent = m;
        return {
          type: "PTY_LIST_RESULT",
          requestId: "r",
          terminals: [
            { sessionId: "t1", workspaceId: "ws1", cwd: "/w/1", createdAt: 1 },
            { sessionId: "t2", workspaceId: "ws1", cwd: "/w/2", createdAt: 2 },
          ],
        };
      },
    } as unknown as RuntimeClient;
    const terms = await bridgePtyTerminals(bridge, "ws1");
    expect(sent.type).toBe("PTY_LIST");
    expect(sent.workspaceId).toBe("ws1");
    expect(terms.map((t) => t.sessionId)).toEqual(["t1", "t2"]);
  });

  it("bridgePtyTerminals rejects a failed request so callers retain prior rows", async () => {
    const bridge = {
      request: async () => {
        throw new Error("timeout");
      },
    } as unknown as RuntimeClient;
    await expect(bridgePtyTerminals(bridge)).rejects.toThrow("timeout");
  });

  it("subscribeBridgePtyTerminalsChanged fires the handler on the push", () => {
    let cb: ((m: unknown) => void) | null = null;
    const off = () => {};
    const bridge = {
      on: (type: string, h: (m: unknown) => void) => {
        if (type === "PTY_TERMINALS_CHANGED") cb = h;
        return off;
      },
    } as unknown as RuntimeClient;
    let fired = 0;
    const unsub = subscribeBridgePtyTerminalsChanged(bridge, () => {
      fired++;
    });
    cb!({ type: "PTY_TERMINALS_CHANGED" });
    expect(fired).toBe(1);
    expect(unsub).toBe(off);
  });
});
