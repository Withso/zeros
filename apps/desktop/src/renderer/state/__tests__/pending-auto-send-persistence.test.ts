// A queued first turn has to survive the reload that interrupted it.
//
// The bug (reported 2026-08-24): a message sent while a workspace was still
// setting up was accepted into the pre-ready park — "Message queued: it will
// send as soon as this workspace finishes setting up" — and then the renderer
// reloaded (engine HMR respawn, a main-process restart, a crash). The DRAFT
// survived, because drafts are persisted; the INTENT did not, because
// `pendingAutoSend` was in-memory only. The user was left looking at their own
// text sitting in a composer that was never going to send it, in a chat whose
// transcript showed nothing at all.
//
// So the intent now rides in the same persisted document as the draft that IS
// its payload: one snapshot, written together, so recovery can never pair an
// armed intent with a draft that is gone (or vice versa).

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS,
  loadPersistedDrafts,
  persistDraftsNow,
  recoverPendingAutoSend,
  schedulePersistDrafts,
} from "../persist-composer-drafts";
import type { WorkspaceState } from "../store";

const KEY = "zeros:composer-drafts:v1";

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
  vi.stubGlobal("localStorage", {
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
  });
  return { store, attempts };
}

function draft(text: string) {
  return { text, attachments: [], json: null };
}

function stateWith(
  chats: Record<string, ReturnType<typeof draft>>,
  pendingAutoSend: Record<string, number>,
): WorkspaceState {
  return {
    chatComposerDrafts: chats,
    editComposerDrafts: {},
    pendingAutoSend,
  } as unknown as WorkspaceState;
}

describe("pending auto-send persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.unstubAllGlobals();
    installWindow();
  });

  it("writes the armed intent alongside its draft", async () => {
    const { store } = installStorage();
    schedulePersistDrafts(
      stateWith({ "chat-1": draft("the message I queued") }, { "chat-1": 500 }),
    );
    await vi.advanceTimersByTimeAsync(600);

    const written = JSON.parse(store.get(KEY)!);
    expect(written.chats["chat-1"].text).toBe("the message I queued");
    expect(written.autoSend).toEqual({ "chat-1": 500 });
  });

  it("writes an arm/consume transition immediately, not on the debounce", () => {
    // The 500 ms draft debounce is fine for typing and fatal for this: a crash
    // inside the window would either lose an intent that was just armed, or
    // resurrect one that was just consumed and re-send a message the engine
    // already has. persistDraftsNow is what the store calls on the transition.
    const { store } = installStorage();
    persistDraftsNow(
      stateWith({ "chat-1": draft("queued now") }, { "chat-1": 500 }),
    );
    expect(JSON.parse(store.get(KEY)!).autoSend).toEqual({ "chat-1": 500 });

    persistDraftsNow(stateWith({ "chat-1": draft("queued now") }, {}));
    expect(JSON.parse(store.get(KEY)!).autoSend).toEqual({});
  });

  it("keeps the intent when the write degrades past the quota", async () => {
    // The degraded retry drops attachment payloads to save the typed prompt.
    // Dropping the intent with them would turn "your message is queued" into a
    // silent no-op for exactly the drafts that are most expensive to retype.
    const { store, attempts } = installStorage({ maxBytes: 400 });
    const big = {
      text: "prompt with a big attachment",
      attachments: [
        {
          id: "att-1",
          name: "big.txt",
          mimeType: "text/plain",
          size: 50_000,
          kind: "text",
          data: "",
          text: "x".repeat(50_000),
          validation: { ok: true },
        },
      ],
      json: { type: "doc" },
    } as unknown as ReturnType<typeof draft>;
    schedulePersistDrafts(stateWith({ "chat-1": big }, { "chat-1": 500 }));
    await vi.advanceTimersByTimeAsync(600);

    expect(attempts).toHaveLength(2);
    const written = JSON.parse(store.get(KEY)!);
    expect(written.chats["chat-1"].text).toBe("prompt with a big attachment");
    expect(written.autoSend).toEqual({ "chat-1": 500 });
  });

  it("reads a pre-existing v1 document that has no autoSend field", () => {
    // Forward/backward compatibility: the key is unchanged and older writers
    // simply omit the field.
    const { store } = installStorage();
    store.set(
      KEY,
      JSON.stringify({ chats: { "chat-1": draft("hello") }, edits: {} }),
    );
    const loaded = loadPersistedDrafts();
    expect(loaded.chats["chat-1"].text).toBe("hello");
    expect(loaded.autoSend).toEqual({});
  });

  it("ignores malformed intent entries instead of failing the boot read", () => {
    const { store } = installStorage();
    store.set(
      KEY,
      JSON.stringify({
        chats: {},
        edits: {},
        autoSend: { a: "nope", b: null, c: Number.NaN, d: 12 },
      }),
    );
    expect(loadPersistedDrafts().autoSend).toEqual({ d: 12 });
  });
});

describe("recoverPendingAutoSend", () => {
  const now = 10_000_000;

  it("re-arms an intent the reload interrupted", () => {
    // The regression: this is the whole point. A park armed seconds before the
    // reload must still be delivered.
    expect(
      recoverPendingAutoSend(
        {
          chats: { "chat-1": draft("send me when ready") },
          edits: {},
          autoSend: { "chat-1": now - 2_000 },
        },
        now,
      ),
    ).toEqual({ "chat-1": now - 2_000 });
  });

  it("drops an intent whose draft no longer holds anything to send", () => {
    // The draft IS the payload. Without it the park would arm a send with an
    // empty composer, which the drain refuses anyway — so it would sit armed
    // forever, exactly the state this whole fix exists to remove.
    expect(
      recoverPendingAutoSend(
        { chats: {}, edits: {}, autoSend: { "chat-1": now - 2_000 } },
        now,
      ),
    ).toEqual({});
    expect(
      recoverPendingAutoSend(
        {
          chats: { "chat-1": draft("   ") },
          edits: {},
          autoSend: { "chat-1": now - 2_000 },
        },
        now,
      ),
    ).toEqual({});
  });

  it("keeps an attachment-only draft armed", () => {
    // A dropped screenshot with no typed text is a real message.
    const attachmentOnly = {
      text: "",
      attachments: [{ id: "att-1", name: "shot.png" }],
      json: null,
    } as unknown as ReturnType<typeof draft>;
    expect(
      recoverPendingAutoSend(
        {
          chats: { "chat-1": attachmentOnly },
          edits: {},
          autoSend: { "chat-1": now - 2_000 },
        },
        now,
      ),
    ).toEqual({ "chat-1": now - 2_000 });
  });

  it("does not fire a stale intent on a much later launch", () => {
    // Reopening the app tomorrow must not silently dispatch yesterday's
    // half-thought prompt to an agent. The draft is still in the composer, in
    // view, where the user can send it deliberately.
    expect(
      recoverPendingAutoSend(
        {
          chats: { "chat-1": draft("yesterday's idea") },
          edits: {},
          autoSend: {
            "chat-1": now - PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS - 1,
          },
        },
        now,
      ),
    ).toEqual({});
  });

  it("drops an intent stamped implausibly far in the future", () => {
    // A clock correction between the write and the read must not create an
    // intent that can never expire.
    expect(
      recoverPendingAutoSend(
        {
          chats: { "chat-1": draft("hello") },
          edits: {},
          autoSend: {
            "chat-1": now + PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS + 1,
          },
        },
        now,
      ),
    ).toEqual({});
  });

  it("recovers each chat independently", () => {
    // Many workspace creates queue in parallel; one bad entry must not cost
    // the others their first turn.
    expect(
      recoverPendingAutoSend(
        {
          chats: {
            fresh: draft("keep me"),
            stale: draft("too old"),
            gone: draft(""),
          },
          edits: {},
          autoSend: {
            fresh: now - 1_000,
            stale: now - PENDING_AUTO_SEND_RECOVERY_MAX_AGE_MS - 1,
            gone: now - 1_000,
            unknown: now - 1_000,
          },
        },
        now,
      ),
    ).toEqual({ fresh: now - 1_000 });
  });
});
