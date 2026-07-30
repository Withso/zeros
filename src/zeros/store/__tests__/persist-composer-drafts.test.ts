// Draft persistence must degrade, not give up.
//
// The bug (found 2026-07-30 while adding chat-transcript attachments): a
// single staged attachment past the localStorage quota made the whole
// `setItem` throw, and the catch swallowed it. Since the snapshot is
// re-serialized fresh on every write, EVERY subsequent write failed too — so
// one big attachment silently stopped EVERY chat's draft from persisting for
// as long as it stayed staged, and the only symptom was the user's typed
// prompt vanishing on reload. The old comment claimed "the text portion still
// gets written on the next field change", which was never true.
//
// Transcripts made a multi-hundred-KB text attachment a routine thing rather
// than an accident, so the failure had to stop being silent-and-total.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadPersistedDrafts, schedulePersistDrafts } from "../persist-composer-drafts";
import type { WorkspaceState } from "../store";

const KEY = "zeros:composer-drafts:v1";

/** A localStorage stand-in whose setItem can be made to throw like a real
 *  quota failure, and which records every attempt so we can assert the retry. */
/** The module schedules through `window.setTimeout`; vitest runs in node. */
function installWindow() {
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

function installStorage(opts: { maxBytes?: number } = {}) {
  const store = new Map<string, string>();
  const attempts: string[] = [];
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      attempts.push(v);
      if (opts.maxBytes !== undefined && v.length > opts.maxBytes) {
        const err = new Error("QuotaExceededError");
        err.name = "QuotaExceededError";
        throw err;
      }
      store.set(k, v);
    },
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  vi.stubGlobal("localStorage", mock);
  return { store, attempts };
}

function stateWith(text: string, attachmentBody: string): WorkspaceState {
  return {
    chatComposerDrafts: {
      "chat-1": {
        text,
        attachments: [
          {
            id: "att-1",
            name: "big.concise.txt",
            mimeType: "text/plain",
            size: attachmentBody.length,
            kind: "text",
            data: "",
            text: attachmentBody,
            validation: { ok: true },
          },
        ],
        json: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text },
                {
                  type: "attachment",
                  attrs: { attachmentId: "att-1", name: "big.concise.txt" },
                },
              ],
            },
          ],
        },
      },
    },
    editComposerDrafts: {},
  } as unknown as WorkspaceState;
}

/** schedulePersistDrafts debounces; flush it. */
async function flush() {
  await vi.advanceTimersByTimeAsync(600);
}

describe("persist-composer-drafts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
    installWindow();
  });

  it("writes the draft whole when it fits", async () => {
    const { store } = installStorage();
    schedulePersistDrafts(stateWith("my prompt", "small body"));
    await flush();

    const written = JSON.parse(store.get(KEY)!);
    expect(written.chats["chat-1"].text).toBe("my prompt");
    expect(written.chats["chat-1"].attachments).toHaveLength(1);
    expect(written.chats["chat-1"].attachments[0].text).toBe("small body");
    expect(written.chats["chat-1"].json).not.toBeNull();
  });

  it("keeps the typed prompt when the attachment blows the quota", async () => {
    // The regression. Before the fix this wrote NOTHING and the user lost
    // their prompt on reload.
    const { store, attempts } = installStorage({ maxBytes: 2_000 });
    schedulePersistDrafts(stateWith("the prompt I care about", "x".repeat(50_000)));
    await flush();

    expect(attempts).toHaveLength(2); // full attempt, then the degraded retry
    const written = JSON.parse(store.get(KEY)!);
    expect(written.chats["chat-1"].text).toBe("the prompt I care about");
  });

  it("drops the attachment BODY and the doc that references it, together", async () => {
    // Dropping the bytes while keeping the editor JSON would restore a chip
    // with nothing behind it — a file the user believes they are sending and
    // the agent never receives. Lossy is fine; lying is not.
    const { store } = installStorage({ maxBytes: 2_000 });
    schedulePersistDrafts(stateWith("prompt", "y".repeat(50_000)));
    await flush();

    const draft = JSON.parse(store.get(KEY)!).chats["chat-1"];
    expect(draft.attachments).toEqual([]);
    expect(draft.json).toBeNull();
  });

  it("survives storage being unavailable entirely", async () => {
    // Private mode: even the degraded write throws. Must not escape.
    installWindow();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {},
    });
    expect(() =>
      schedulePersistDrafts(stateWith("prompt", "z".repeat(50_000))),
    ).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
  });

  it("leaves an unrelated attachment-free draft completely untouched", async () => {
    // The degraded write OVERWRITES a previously-good snapshot, so anything it
    // strips unnecessarily is data the old catch-and-swallow would have kept.
    // A chat holding only typed text and @-mention pills didn't cause the
    // overflow and must not lose its editor document for it.
    const { store } = installStorage({ maxBytes: 3_000 });
    const state = stateWith("prompt", "q".repeat(50_000));
    (state as unknown as { chatComposerDrafts: Record<string, unknown> }).chatComposerDrafts[
      "chat-2"
    ] = {
      text: "no attachments here",
      attachments: [],
      json: { type: "doc", content: [{ type: "paragraph" }] },
    };
    schedulePersistDrafts(state);
    await flush();

    const written = JSON.parse(store.get(KEY)!);
    expect(written.chats["chat-1"].json).toBeNull(); // the culprit
    expect(written.chats["chat-2"].json).not.toBeNull(); // the bystander
    expect(written.chats["chat-2"].text).toBe("no attachments here");
  });

  it("drops keptOriginals too — they hold the biggest payloads", async () => {
    // keptOriginals are the ORIGINAL attachments of a message being edited,
    // and each thumbnailUri is a full base64 data: URL up to MAX_IMAGE_BYTES.
    // Keeping them meant the "degraded" retry could still be megabytes and
    // throw again, leaving nothing written at all — the exact outcome the
    // degrade exists to prevent.
    const { store, attempts } = installStorage({ maxBytes: 4_000 });
    const state = stateWith("prompt", "small");
    (state as unknown as { editComposerDrafts: Record<string, unknown> }).editComposerDrafts[
      "chat-1:msg-1"
    ] = {
      text: "my careful rewrite",
      newAttachments: [],
      keptOriginals: [
        {
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          thumbnailUri: `data:image/png;base64,${"A".repeat(60_000)}`,
        },
      ],
      json: { type: "doc" },
    };
    schedulePersistDrafts(state);
    await flush();

    expect(attempts).toHaveLength(2);
    // The retry actually fit, which is the whole point.
    expect(store.has(KEY)).toBe(true);
    const written = JSON.parse(store.get(KEY)!);
    expect(written.edits["chat-1:msg-1"].keptOriginals).toEqual([]);
    expect(written.edits["chat-1:msg-1"].text).toBe("my careful rewrite");
  });

  it("round-trips a degraded draft on read", async () => {
    const { store } = installStorage({ maxBytes: 2_000 });
    schedulePersistDrafts(stateWith("prompt", "w".repeat(50_000)));
    await flush();
    expect(store.has(KEY)).toBe(true);

    const loaded = loadPersistedDrafts();
    expect(loaded.chats["chat-1"].text).toBe("prompt");
    expect(loaded.chats["chat-1"].attachments).toEqual([]);
  });
});
