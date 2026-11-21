import { describe, expect, it } from "vitest";
import {
  chatAttachmentName,
  formatReply,
  INLINE_QUOTE_CHARACTER_LIMIT,
  normalizeSelectionText,
  parseReply,
  placePopup,
  POPUP_EDGE,
  POPUP_GAP,
  previewText,
  replyMessage,
  replySendBlocker,
} from "../chat-selection";

const bounds = { top: 100, bottom: 700, left: 200, right: 1000 };
const rect = (top: number, bottom: number, left = 300, right = 700) => ({ top, bottom, left, right });

describe("selection text", () => {
  it("reads as the user sees it", () => {
    expect(normalizeSelectionText("\n\nTwo things  \r\n\n\n\n- one​\n- two \n\n")).toBe("Two things\n\n- one\n- two");
  });

  it("keeps indentation inside a selection", () => {
    expect(normalizeSelectionText("if (a) {\n  b();\n}")).toBe("if (a) {\n  b();\n}");
  });

  it("previews one line, clipped with an ellipsis", () => {
    expect(previewText("a\n\n  b\tc")).toBe("a b c");
    expect(previewText("x".repeat(30), 10)).toBe(`${"x".repeat(10)}…`);
  });
});

describe("replies", () => {
  it("quotes every line, blank ones included, then the reply", () => {
    expect(formatReply("first\n\nsecond", "  Great  ")).toBe("> first\n>\n> second\n\nGreat");
  });

  it("parses what it formats", () => {
    expect(parseReply(formatReply("What do you want\nto work on?", "Namaste\nthanks"))).toEqual({
      quote: "What do you want\nto work on?",
      reply: "Namaste\nthanks",
    });
  });

  it("leaves ordinary messages alone", () => {
    for (const text of ["Great", "> only a quote", "> quote\nno blank line", "> \n\nreply", "a\n> b\n\nc", ">quote\n\n  "]) {
      expect(parseReply(text), text).toBeNull();
    }
  });

  it("sends a short quote inline and a long one as a file", () => {
    expect(replyMessage("short", "ok")).toEqual({ text: "> short\n\nok", attachQuote: false });
    const long = replyMessage("word ".repeat(INLINE_QUOTE_CHARACTER_LIMIT), "ok");
    expect(long.attachQuote).toBe(true);
    expect(long.text.length).toBeLessThan(400);
    expect(parseReply(long.text)?.quote).toMatch(/…$/);
    expect(parseReply(long.text)?.reply).toBe("ok");
  });

  it("keeps the reply open while a send can't go yet", () => {
    const ready = { sendInFlight: false, provisioning: false, permission: "send" as const };
    expect(replySendBlocker(ready)).toBeNull();
    // A typed follow-up during plan review sends, as the composer's does.
    expect(replySendBlocker({ ...ready, permission: "revise-plan" })).toBeNull();
    expect(replySendBlocker({ ...ready, sendInFlight: true })?.title).toMatch(/still sending/);
    expect(replySendBlocker({ ...ready, provisioning: true })?.title).toMatch(/set up/);
    expect(replySendBlocker({ ...ready, permission: "hold" })?.title).toMatch(/permission/);
  });

  it("names attachments by local time", () => {
    const at = new Date(2026, 10, 22, 0, 31, 48);
    expect(chatAttachmentName("selection", at)).toBe("chat-selection-2026-11-22_00-31-48.txt");
    expect(chatAttachmentName("reply", at)).toBe("chat-reply-2026-11-22_00-31-48.txt");
  });
});

describe("popup placement", () => {
  const base = { bounds, width: 200, height: 34, pin: false };

  it("sits above the selection, centred on it", () => {
    expect(placePopup({ ...base, selection: rect(400, 460) })).toEqual({ x: 400, y: 400 - POPUP_GAP - 34, side: "top" });
  });

  it("drops below when the selection's first line is at the top of the view", () => {
    expect(placePopup({ ...base, selection: rect(110, 160) })).toEqual({ x: 400, y: 160 + POPUP_GAP, side: "bottom" });
  });

  it("rests inside the view when the selection fills it", () => {
    expect(placePopup({ ...base, selection: rect(20, 900) })).toEqual({ x: 400, y: bounds.top + POPUP_EDGE, side: "inside" });
    expect(placePopup({ ...base, selection: rect(120, 690) })?.side).toBe("inside");
  });

  it("stays inside the transcript beside a selection at either edge", () => {
    expect(placePopup({ ...base, selection: rect(400, 420, 205, 230) })?.x).toBe(bounds.left + POPUP_EDGE);
    expect(placePopup({ ...base, selection: rect(400, 420, 960, 999) })?.x).toBe(bounds.right - POPUP_EDGE - 200);
    // Wider than the transcript: start at its left edge.
    expect(placePopup({ ...base, width: 900, selection: rect(400, 420) })?.x).toBe(bounds.left + POPUP_EDGE);
  });

  it("hides a selection scrolled out of view, unless a reply is open", () => {
    expect(placePopup({ ...base, selection: rect(-300, -200) })).toBeNull();
    expect(placePopup({ ...base, selection: rect(800, 820) })).toBeNull();
    expect(placePopup({ ...base, selection: rect(400, 420, 0, 150) })).toBeNull();
    expect(placePopup({ ...base, pin: true, selection: rect(-300, -200) })).toEqual({ x: 400, y: bounds.top + POPUP_EDGE, side: "inside" });
    expect(placePopup({ ...base, pin: true, selection: rect(800, 820) })).toEqual({
      x: 400, y: bounds.bottom - POPUP_EDGE - 34, side: "inside",
    });
  });

  it("keeps a growing reply on the side it opened on while it fits", () => {
    const selection = rect(300, 320);
    expect(placePopup({ ...base, height: 120, previous: "bottom", selection })?.side).toBe("bottom");
    expect(placePopup({ ...base, height: 120, previous: null, selection })?.side).toBe("top");
    // Past the room below, it moves above.
    expect(placePopup({ ...base, height: 190, previous: "bottom", selection: rect(500, 520) })?.side).toBe("top");
  });
});
