// Paging contract for loadFullTranscript (see agent-history-client). "Copy
// transcript" must return the WHOLE chat, so the walk pages backwards until
// the engine runs out of rows. Three properties matter most: it cursors on
// the RAW wire `msgId` (a page of unparseable rows must not read as "end of
// history"); only an EMPTY page ends the walk (a short page would couple this
// to the engine's exact row clamp); and when a bound stops it early it
// reports `complete: false` rather than passing a partial copy off as whole.
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveBridge: vi.fn(() => ({}) as unknown),
  bridgeMessageWindow: vi.fn(),
  bridgeMessageWindowOlder: vi.fn(),
}));

vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: mocks.getActiveBridge,
}));
vi.mock("../../../platform/bridge/workspace-bridge", () => ({
  bridgeMessageWindow: mocks.bridgeMessageWindow,
  bridgeMessageWindowOlder: mocks.bridgeMessageWindowOlder,
  bridgeChatList: vi.fn(),
  bridgeChatSnapshot: vi.fn(),
  bridgeChatDelete: vi.fn(),
  bridgeChatBulkUpsert: vi.fn(),
  bridgeMessageClear: vi.fn(),
  bridgeMessageTruncateFrom: vi.fn(),
  bridgeDbHead: vi.fn(),
  bridgeDbPull: vi.fn(),
  bridgeChatSummaries: vi.fn(),
}));
vi.mock("../../../platform/runtime", () => ({ nativeInvoke: vi.fn() }));

import { loadFullTranscript } from "../agent-history-client";

const PAGE = 1000;

/** `count` wire rows whose ids are `<prefix>-<n>`, payloads a minimal text
 *  message so fromPersistedMessage parses them. */
function rows(prefix: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    msgId: `${prefix}-${i}`,
    kind: "text",
    payload: JSON.stringify({
      id: `${prefix}-${i}`,
      kind: "text",
      role: "agent",
      text: `${prefix}-${i}`,
      createdAt: i,
    }),
    createdAt: i,
  }));
}

beforeEach(() => {
  mocks.getActiveBridge.mockReturnValue({} as unknown);
  mocks.bridgeMessageWindow.mockReset();
  mocks.bridgeMessageWindowOlder.mockReset();
});

describe("loadFullTranscript", () => {
  it("confirms the end of history rather than trusting a short page", async () => {
    // A short page must NOT end the walk: that would couple this to the
    // engine's exact row clamp, so lowering the clamp would silently cap
    // every copy. Only an empty page ends it.
    mocks.bridgeMessageWindow.mockResolvedValue(rows("a", 3));
    mocks.bridgeMessageWindowOlder.mockResolvedValueOnce([]);

    const { messages, complete } = await loadFullTranscript("chat1");

    expect(messages).toHaveLength(3);
    expect(complete).toBe(true);
    expect(mocks.bridgeMessageWindowOlder).toHaveBeenCalledTimes(1);
  });

  it("pages backwards and returns the transcript oldest-first", async () => {
    // Newest page first (the engine returns the tail), then an older short page.
    mocks.bridgeMessageWindow.mockResolvedValue(rows("newer", PAGE));
    mocks.bridgeMessageWindowOlder
      .mockResolvedValueOnce(rows("older", 2))
      .mockResolvedValueOnce([]);

    const { messages } = await loadFullTranscript("chat1");

    expect(messages).toHaveLength(PAGE + 2);
    // Older page is prepended, so history reads chronologically.
    expect((messages[0] as { text: string }).text).toBe("older-0");
    expect((messages[2] as { text: string }).text).toBe("newer-0");
  });

  it("cursors on the OLDEST row of the page just fetched", async () => {
    mocks.bridgeMessageWindow.mockResolvedValue(rows("newer", PAGE));
    mocks.bridgeMessageWindowOlder.mockResolvedValueOnce([]);

    await loadFullTranscript("chat1");

    const [, chatId, limit, cursor] =
      mocks.bridgeMessageWindowOlder.mock.calls[0];
    expect(chatId).toBe("chat1");
    expect(limit).toBe(PAGE);
    expect(cursor).toBe("newer-0");
  });

  it("keeps walking past a page whose rows are ALL unparseable", async () => {
    // The bug this guards: filtering before cursoring turns a corrupt page
    // into [] and ends the walk, silently truncating the copy.
    const corrupt = Array.from({ length: PAGE }, (_, i) => ({
      msgId: `bad-${i}`,
      kind: "text",
      payload: "{not json",
      createdAt: i,
    }));
    mocks.bridgeMessageWindow.mockResolvedValue(corrupt);
    mocks.bridgeMessageWindowOlder
      .mockResolvedValueOnce(rows("good", 2))
      .mockResolvedValueOnce([]);
    // fromPersistedMessage warns per dropped row; 1000 of them would bury
    // the rest of the suite's output.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { messages } = await loadFullTranscript("chat1");
    warn.mockRestore();

    expect(mocks.bridgeMessageWindowOlder).toHaveBeenCalled();
    // The corrupt rows drop out at parse time; the older good ones survive.
    expect(messages).toHaveLength(2);
    expect((messages[0] as { text: string }).text).toBe("good-0");
  });

  it("stops at an empty page", async () => {
    mocks.bridgeMessageWindow.mockResolvedValue([]);

    const { messages, complete } = await loadFullTranscript("chat1");

    expect(messages).toEqual([]);
    expect(complete).toBe(true);
    expect(mocks.bridgeMessageWindowOlder).not.toHaveBeenCalled();
  });

  it("stops on the payload budget and reports the copy as incomplete", async () => {
    // Each row's payload is ~70 chars, so ~4 MB of budget lands well before
    // the 200-page backstop. The walk must SAY it stopped early.
    mocks.bridgeMessageWindow.mockResolvedValue(rows("p", PAGE));
    mocks.bridgeMessageWindowOlder.mockResolvedValue(rows("p", PAGE));

    const { messages, complete } = await loadFullTranscript("chat1");

    expect(complete).toBe(false);
    expect(messages.length).toBeGreaterThan(0);
    // Bounded well under the 200-page backstop.
    expect(mocks.bridgeMessageWindowOlder.mock.calls.length).toBeLessThan(199);
  });

  it("bounds the walk by page count when payloads are tiny", async () => {
    const tiny = Array.from({ length: PAGE }, (_, i) => ({
      msgId: `t-${i}`,
      kind: "text",
      payload: "{}",
      createdAt: i,
    }));
    mocks.bridgeMessageWindow.mockResolvedValue(tiny);
    mocks.bridgeMessageWindowOlder.mockResolvedValue(tiny);

    const { complete } = await loadFullTranscript("chat1");

    expect(complete).toBe(false);
    // 200-page backstop: 1 initial window + 199 older pages, then the one-row
    // probe that decides `complete`. Here it comes back non-empty, so the
    // partial report is the true one.
    expect(mocks.bridgeMessageWindowOlder).toHaveBeenCalledTimes(200);
    expect(mocks.bridgeMessageWindowOlder.mock.calls.at(-1)?.[2]).toBe(1);
  });

  // A bound stopping the walk is not the same as history being left behind,
  // and conflating them told users a whole transcript was partial. A
  // tool-heavy chat reaches the 4 MB budget INSIDE one page — a page is up to
  // 1000 rows and a single Read result can be 100 KB — so this is the ordinary
  // large chat, not a corner case.
  describe("the completeness probe", () => {
    /** 40 rows × ~120 KB — over the 4 MB budget, in a single page. */
    const fatPage = () =>
      Array.from({ length: 40 }, (_, i) => ({
        msgId: `f-${i}`,
        kind: "text",
        payload: JSON.stringify({
          id: `f-${i}`,
          kind: "text",
          role: "agent",
          text: "x".repeat(120_000),
          createdAt: i,
        }),
        createdAt: i,
      }));

    it("reports COMPLETE when the budget trips but nothing older exists", async () => {
      mocks.bridgeMessageWindow.mockResolvedValue(fatPage());
      mocks.bridgeMessageWindowOlder.mockResolvedValue([]);

      const { messages, complete } = await loadFullTranscript("chat1");

      expect(messages).toHaveLength(40);
      expect(complete).toBe(true);
      // One probe, for ONE row — not another multi-megabyte page to learn a
      // single bit.
      expect(mocks.bridgeMessageWindowOlder).toHaveBeenCalledTimes(1);
      expect(mocks.bridgeMessageWindowOlder.mock.calls[0][2]).toBe(1);
    });

    it("still reports incomplete when the probe finds older history", async () => {
      mocks.bridgeMessageWindow.mockResolvedValue(fatPage());
      mocks.bridgeMessageWindowOlder.mockResolvedValue(rows("older", 1));

      expect((await loadFullTranscript("chat1")).complete).toBe(false);
    });

    it("degrades to incomplete when the probe itself fails", async () => {
      // The safe direction: the rows already in hand are still returned, and
      // the user is warned the copy may be partial rather than losing a read
      // that otherwise succeeded entirely.
      mocks.bridgeMessageWindow.mockResolvedValue(fatPage());
      mocks.bridgeMessageWindowOlder.mockRejectedValue(new Error("timeout"));

      const { messages, complete } = await loadFullTranscript("chat1");
      expect(messages).toHaveLength(40);
      expect(complete).toBe(false);
    });
  });

  it("throws a readable error when no bridge is connected", async () => {
    mocks.getActiveBridge.mockReturnValue(null);

    await expect(loadFullTranscript("chat1")).rejects.toThrow(
      /copy the chat transcript/,
    );
  });
});
