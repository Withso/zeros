// The label chain, the slug, the overflow split and the read cache.
//
// These are the parts of "attach a chat transcript" that are easy to get
// subtly wrong and impossible to notice: a pill that reads "Untitled", a
// filename that collides between two modes, a cache that serves a streaming
// chat's stale transcript, or a failed read that pins itself in the cache so
// retry can never succeed.

import { beforeEach, describe, expect, it, vi } from "vitest";

const loadFullTranscript = vi.fn();
const formatTranscript = vi.fn();

vi.mock("../agent-history-client", () => ({
  loadFullTranscript: (...a: unknown[]) => loadFullTranscript(...a),
}));
// Only formatTranscript is stubbed — the cache tests need to count engine
// walks without formatting anything. `sliceSafe` stays REAL: the pill label
// truncates through it, and a stub there would let a surrogate-splitting
// regression pass unnoticed, which is the bug it was shared to fix.
vi.mock("../transcript-format", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../transcript-format")>()),
  formatTranscript: (...a: unknown[]) => formatTranscript(...a),
}));

import {
  clearTranscriptCache,
  hasCachedTranscriptForTesting,
  loadTranscriptSnapshot,
  splitTranscriptPills,
  transcriptFileName,
  transcriptPillLabel,
  transcriptSlug,
  transcriptSourceKey,
  TRANSCRIPT_PILL_CAP,
} from "../chat-transcript-attach";

describe("transcriptPillLabel", () => {
  it("uses a real title", () => {
    expect(
      transcriptPillLabel({ title: "Rework the tab strip", summary: "hi" }),
    ).toBe("Rework the tab strip");
  });

  it("falls back to the first prompt when the title is still the seed", () => {
    // "Untitled" is the stored seed, not a display string. A chat that has
    // messages but no AI title yet is normal — and it is MOST likely on the
    // chat you were just in, which is the one you most want to attach.
    expect(
      transcriptPillLabel({
        title: "Untitled",
        summary: "Why is the tab strip re-mounting on every keystroke?",
      }),
    ).toBe("Why is the tab strip re-mounting on ever…");
  });

  it("collapses whitespace in the fallback so a pasted prompt fits one line", () => {
    expect(
      transcriptPillLabel({ title: "", summary: "  bump   the\n sqlite pin " }),
    ).toBe("bump the sqlite pin");
  });

  it("does not clip a short prompt or leave a dangling space before the ellipsis", () => {
    expect(transcriptPillLabel({ title: "", summary: "short one" })).toBe(
      "short one",
    );
    const clipped = transcriptPillLabel({
      title: "",
      // Character 40 lands mid-gap; the ellipsis must not follow a space.
      summary: "abcdefghij abcdefghij abcdefghij abcdefg hij",
    });
    expect(clipped.endsWith(" …")).toBe(false);
  });

  it("does not cut an emoji in half at the clip boundary", () => {
    // An emoji is two code units, so a raw slice at the 40-char boundary can
    // land between them and leave a lone high surrogate — ill-formed, and the
    // DOM paints it as a tofu box immediately before the ellipsis. Opening a
    // prompt with an emoji is ordinary, so this is reachable, not exotic.
    const label = transcriptPillLabel({
      title: "",
      summary: `${"x".repeat(39)}😀 and then some more words`,
    });
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(label)).toBe(false);
    expect(label).toBe(`${"x".repeat(39)}…`);
  });

  it("keeps a whole emoji when the pair fits inside the budget", () => {
    const label = transcriptPillLabel({
      title: "",
      summary: `${"x".repeat(38)}😀 and then some more words`,
    });
    expect(label).toBe(`${"x".repeat(38)}😀…`);
  });

  it("never returns an empty label", () => {
    expect(transcriptPillLabel({ title: "Untitled", summary: "" })).toBe(
      "Untitled chat",
    );
    expect(transcriptPillLabel({ title: "   ", summary: "   " })).toBe(
      "Untitled chat",
    );
  });
});

describe("transcriptSlug / transcriptFileName", () => {
  it("slugs a title", () => {
    expect(transcriptSlug("Find chat transcript implementations")).toBe(
      "find-chat-transcript-implementations",
    );
  });

  it("never emits a leading, trailing or doubled separator", () => {
    expect(transcriptSlug("  ¿¿ Hello -- World ?? ")).toBe("hello-world");
  });

  it("survives a label with nothing slug-able in it", () => {
    expect(transcriptSlug("¿¿¿")).toBe("chat");
    expect(transcriptFileName("¿¿¿", "concise")).toBe("chat.concise.txt");
  });

  it("puts the mode in the name so the two modes never collide", () => {
    const label = "Audit transcript implementation";
    expect(transcriptFileName(label, "concise")).toBe(
      "audit-transcript-implementation.concise.txt",
    );
    expect(transcriptFileName(label, "full")).toBe(
      "audit-transcript-implementation.full.txt",
    );
    expect(transcriptFileName(label, "concise")).not.toBe(
      transcriptFileName(label, "full"),
    );
  });

  it("clips a long slug without leaving a trailing dash before the extension", () => {
    const name = transcriptFileName("a".repeat(30) + " " + "b".repeat(60), "full");
    expect(name.endsWith("-.full.txt")).toBe(false);
    expect(name.endsWith(".full.txt")).toBe(true);
  });
});

describe("transcriptSourceKey", () => {
  it("is keyed by chat only, so switching mode replaces rather than adds", () => {
    expect(transcriptSourceKey("c1")).toBe("transcript:c1");
    expect(transcriptSourceKey("c1")).toBe(transcriptSourceKey("c1"));
    expect(transcriptSourceKey("c1")).not.toBe(transcriptSourceKey("c2"));
  });
});

describe("splitTranscriptPills", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("shows everything below the cap", () => {
    expect(splitTranscriptPills(items(3))).toEqual({
      shown: [0, 1, 2],
      overflow: [],
    });
  });

  it("shows everything at exactly the cap", () => {
    const { shown, overflow } = splitTranscriptPills(items(TRANSCRIPT_PILL_CAP));
    expect(shown).toHaveLength(TRANSCRIPT_PILL_CAP);
    expect(overflow).toEqual([]);
  });

  it("never renders a '1 more' pill — it shows the seventh instead", () => {
    // A lone hidden item costs the same row space as showing it, and a
    // popover to reach one thing is a worse deal than the pill itself.
    const { shown, overflow } = splitTranscriptPills(
      items(TRANSCRIPT_PILL_CAP + 1),
    );
    expect(shown).toHaveLength(TRANSCRIPT_PILL_CAP + 1);
    expect(overflow).toEqual([]);
  });

  it("splits once overflow is worth a popover", () => {
    const { shown, overflow } = splitTranscriptPills(
      items(TRANSCRIPT_PILL_CAP + 2),
    );
    expect(shown).toHaveLength(TRANSCRIPT_PILL_CAP);
    expect(overflow).toHaveLength(2);
  });

  it("preserves order across the split", () => {
    const { shown, overflow } = splitTranscriptPills(items(10));
    expect([...shown, ...overflow]).toEqual(items(10));
  });
});

describe("loadTranscriptSnapshot", () => {
  beforeEach(() => {
    clearTranscriptCache();
    loadFullTranscript.mockReset();
    formatTranscript.mockReset();
    loadFullTranscript.mockResolvedValue({ messages: [{}], complete: true });
    formatTranscript.mockReturnValue({
      text: "TEXT",
      count: 3,
      truncated: false,
    });
  });

  const input = (over: Partial<Parameters<typeof loadTranscriptSnapshot>[0]> = {}) => ({
    chatId: "c1",
    mode: "concise" as const,
    lastMessageAt: 100,
    meta: {},
    ...over,
  });

  it("returns the formatted snapshot", async () => {
    await expect(loadTranscriptSnapshot(input())).resolves.toEqual({
      text: "TEXT",
      count: 3,
      truncated: false,
      complete: true,
    });
  });

  it("shares one engine walk between concurrent callers", async () => {
    // The hover and the click want the same bytes. Two walks would double a
    // cost that is already several round trips at up to 60s each.
    const a = loadTranscriptSnapshot(input());
    const b = loadTranscriptSnapshot(input());
    await Promise.all([a, b]);
    expect(loadFullTranscript).toHaveBeenCalledTimes(1);
  });

  it("serves a warm entry without touching the engine", async () => {
    await loadTranscriptSnapshot(input());
    expect(hasCachedTranscriptForTesting("c1", "concise", 100)).toBe(true);
    await loadTranscriptSnapshot(input());
    expect(loadFullTranscript).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the source chat has moved on", async () => {
    // Staleness is structural: lastMessageAt is in the key, so a streaming
    // chat can't serve yesterday's transcript out of the cache.
    await loadTranscriptSnapshot(input({ lastMessageAt: 100 }));
    await loadTranscriptSnapshot(input({ lastMessageAt: 200 }));
    expect(loadFullTranscript).toHaveBeenCalledTimes(2);
    expect(hasCachedTranscriptForTesting("c1", "concise", 100)).toBe(false);
  });

  it("caches the two modes separately", async () => {
    await loadTranscriptSnapshot(input({ mode: "concise" }));
    await loadTranscriptSnapshot(input({ mode: "full" }));
    expect(loadFullTranscript).toHaveBeenCalledTimes(2);
    expect(formatTranscript).toHaveBeenNthCalledWith(1, [{}], "concise", {});
    expect(formatTranscript).toHaveBeenNthCalledWith(2, [{}], "full", {});
  });

  it("evicts beyond two entries so a pointer sweep can't pin the row's memory", async () => {
    await loadTranscriptSnapshot(input({ chatId: "a" }));
    await loadTranscriptSnapshot(input({ chatId: "b" }));
    await loadTranscriptSnapshot(input({ chatId: "c" }));
    expect(hasCachedTranscriptForTesting("a", "concise", 100)).toBe(false);
    expect(hasCachedTranscriptForTesting("b", "concise", 100)).toBe(true);
    expect(hasCachedTranscriptForTesting("c", "concise", 100)).toBe(true);
  });

  it("keeps the actively-hovered chat warm when its neighbour is touched", async () => {
    await loadTranscriptSnapshot(input({ chatId: "a" }));
    await loadTranscriptSnapshot(input({ chatId: "b" }));
    await loadTranscriptSnapshot(input({ chatId: "a" })); // re-hover a
    await loadTranscriptSnapshot(input({ chatId: "c" }));
    // 'b' is the least recently used, so it goes — not 'a'.
    expect(hasCachedTranscriptForTesting("a", "concise", 100)).toBe(true);
    expect(hasCachedTranscriptForTesting("b", "concise", 100)).toBe(false);
  });

  it("a streaming chat's churn does not evict the chat beside it", async () => {
    // Regression: superseded revisions used to linger, so one chat streaming
    // while you hovered it twice filled BOTH cache slots with its own dead and
    // live copies — throwing away the transcript of the chat you were actually
    // comparing it against.
    await loadTranscriptSnapshot(input({ chatId: "stable", lastMessageAt: 1 }));
    await loadTranscriptSnapshot({
      ...input({ chatId: "live" }),
      lastMessageAt: 10,
    });
    await loadTranscriptSnapshot({
      ...input({ chatId: "live" }),
      lastMessageAt: 20,
    });
    expect(hasCachedTranscriptForTesting("stable", "concise", 1)).toBe(true);
    expect(hasCachedTranscriptForTesting("live", "concise", 10)).toBe(false);
    expect(hasCachedTranscriptForTesting("live", "concise", 20)).toBe(true);
  });

  it("does not cache a failed read, so retry can actually retry", async () => {
    loadFullTranscript.mockRejectedValueOnce(new Error("engine down"));
    await expect(loadTranscriptSnapshot(input())).rejects.toThrow("engine down");
    expect(hasCachedTranscriptForTesting("c1", "concise", 100)).toBe(false);
    await expect(loadTranscriptSnapshot(input())).resolves.toMatchObject({
      text: "TEXT",
    });
    expect(loadFullTranscript).toHaveBeenCalledTimes(2);
  });

  it("propagates the engine's incomplete flag", async () => {
    loadFullTranscript.mockResolvedValue({ messages: [{}], complete: false });
    await expect(loadTranscriptSnapshot(input())).resolves.toMatchObject({
      complete: false,
    });
  });
});
