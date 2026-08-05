import { describe, expect, it } from "vitest";

import {
  composerOwnsFocus,
  isFocusEngaged,
  isFocusHeldElsewhere,
  nextComposerFocusAction,
  shouldReclaimComposerFocus,
} from "../composer-focus";

// Duck-typed element mock (the node test env has no DOM), mirroring
// pane-focus.test.ts. `tagName` drives the input/body checks; `contentEditable`
// and `role` drive the remaining guards via a minimal closest().
function mockEl({
  tagName = "DIV",
  contentEditable = false,
  role = null,
}: {
  tagName?: string;
  contentEditable?: boolean;
  role?: "menu" | "dialog" | null;
} = {}): Element {
  return {
    tagName,
    isContentEditable: contentEditable,
    closest(selector: string) {
      if (role && selector.includes(`role=${role}`)) return this;
      return null;
    },
  } as unknown as Element;
}

describe("composerOwnsFocus", () => {
  it("owns focus when this chat is the global active chat and on screen", () => {
    expect(
      composerOwnsFocus({
        chatId: "c1",
        activeChatId: "c1",
        composerConcealed: false,
      }),
    ).toBe(true);
  });

  it("never owns focus while concealed (card / hidden retained layer)", () => {
    expect(
      composerOwnsFocus({
        chatId: "c1",
        activeChatId: "c1",
        composerConcealed: true,
      }),
    ).toBe(false);
  });

  it("does not own focus when another chat is active (split-pane gate)", () => {
    // The decisive rule: in a split, several panes are surfaceActive at once,
    // so a background pane's chat must NOT grab focus.
    expect(
      composerOwnsFocus({
        chatId: "c1",
        activeChatId: "c2",
        composerConcealed: false,
      }),
    ).toBe(false);
    expect(
      composerOwnsFocus({
        chatId: "c1",
        activeChatId: null,
        composerConcealed: false,
      }),
    ).toBe(false);
  });

  it("keeps pre-split behavior for a chatId-less standalone composer", () => {
    expect(
      composerOwnsFocus({
        chatId: null,
        activeChatId: "c9",
        composerConcealed: false,
      }),
    ).toBe(true);
    expect(
      composerOwnsFocus({
        chatId: undefined,
        activeChatId: null,
        composerConcealed: true,
      }),
    ).toBe(false);
  });
});

describe("isFocusEngaged", () => {
  it("treats nothing / <body> as free to focus the composer", () => {
    expect(isFocusEngaged(null)).toBe(false);
    expect(isFocusEngaged(undefined)).toBe(false);
    expect(isFocusEngaged(mockEl({ tagName: "BODY" }))).toBe(false);
    // A tab button the user clicked to switch — fair game, focus the composer.
    expect(isFocusEngaged(mockEl({ tagName: "BUTTON" }))).toBe(false);
  });

  it("protects a live text input the user moved to", () => {
    expect(isFocusEngaged(mockEl({ tagName: "INPUT" }))).toBe(true);
    expect(isFocusEngaged(mockEl({ tagName: "TEXTAREA" }))).toBe(true);
    // Another pane's TipTap composer (contenteditable) the user clicked into.
    expect(isFocusEngaged(mockEl({ contentEditable: true }))).toBe(true);
  });

  it("protects an open menu or dialog", () => {
    expect(isFocusEngaged(mockEl({ role: "menu" }))).toBe(true);
    expect(isFocusEngaged(mockEl({ role: "dialog" }))).toBe(true);
  });
});

// A pane root that "contains" a fixed set of elements — models the DOM
// boundary between this chat window's pane and everything outside it (workbench,
// other panes). Duck-typed like mockEl; only `contains` is exercised.
function mockPaneRoot(children: Element[]): Element {
  return {
    contains: (el: Element | null) => (el ? children.includes(el) : false),
  } as unknown as Element;
}

describe("isFocusHeldElsewhere", () => {
  it("holds for an engaged input/menu/dialog regardless of pane", () => {
    expect(
      isFocusHeldElsewhere({
        activeElement: mockEl({ tagName: "INPUT" }),
        paneRoot: mockPaneRoot([]),
      }),
    ).toBe(true);
    // A workbench CodeMirror editor reads as contenteditable → held.
    expect(
      isFocusHeldElsewhere({
        activeElement: mockEl({ contentEditable: true }),
        paneRoot: null,
      }),
    ).toBe(true);
    expect(
      isFocusHeldElsewhere({
        activeElement: mockEl({ role: "menu" }),
        paneRoot: mockPaneRoot([]),
      }),
    ).toBe(true);
  });

  it("is free to reclaim when nothing / <body> holds focus", () => {
    expect(
      isFocusHeldElsewhere({ activeElement: null, paneRoot: mockPaneRoot([]) }),
    ).toBe(false);
    expect(
      isFocusHeldElsewhere({
        activeElement: mockEl({ tagName: "BODY" }),
        paneRoot: mockPaneRoot([]),
      }),
    ).toBe(false);
  });

  it("leaves a plain element focused OUTSIDE this window (workbench / other pane)", () => {
    // The decisive rule: workbench's file-tree host, Changes buttons, and Review
    // sub-tab buttons are NOT engaged, yet clicking them must not be stolen from.
    // They live outside the pane, so containment — not engagement — protects them.
    const workbenchButton = mockEl({ tagName: "BUTTON" });
    const fileTreeHost = mockEl({ tagName: "FILE-TREE-CONTAINER" });
    expect(
      isFocusHeldElsewhere({
        activeElement: workbenchButton,
        paneRoot: mockPaneRoot([]), // pane does NOT contain it
      }),
    ).toBe(true);
    expect(
      isFocusHeldElsewhere({
        activeElement: fileTreeHost,
        paneRoot: mockPaneRoot([]),
      }),
    ).toBe(true);
  });

  it("treats a plain element INSIDE this window as fair game", () => {
    // A tab or message-action button in our own pane — reclaim to keep the
    // composer hot ("click a button, keep typing").
    const inWindowButton = mockEl({ tagName: "BUTTON" });
    expect(
      isFocusHeldElsewhere({
        activeElement: inWindowButton,
        paneRoot: mockPaneRoot([inWindowButton]),
      }),
    ).toBe(false);
  });

  it("degrades to the engaged-only test for a standalone composer (no pane)", () => {
    // Picker / beta flows mount outside the split-pane tree — a plain button is
    // fair game (pre-split behavior), only real inputs hold.
    expect(
      isFocusHeldElsewhere({
        activeElement: mockEl({ tagName: "BUTTON" }),
        paneRoot: null,
      }),
    ).toBe(false);
    expect(
      isFocusHeldElsewhere({
        activeElement: mockEl({ tagName: "TEXTAREA" }),
        paneRoot: null,
      }),
    ).toBe(true);
  });
});

describe("shouldReclaimComposerFocus", () => {
  const base = {
    owns: true,
    interactionInsidePane: true,
    composerHasFocus: false,
    hasTextSelection: false,
    hasOpenOverlay: false,
    activeElement: mockEl({ tagName: "BODY" }),
    paneRoot: mockPaneRoot([]),
  };

  it("reclaims on an in-window click that left focus free (the core fix)", () => {
    // Click the transcript / empty space / scroll → focus fell to <body> → the
    // composer takes it back so the user can just type.
    expect(shouldReclaimComposerFocus(base)).toBe(true);
  });

  it("does nothing when this chat isn't the active window", () => {
    expect(shouldReclaimComposerFocus({ ...base, owns: false })).toBe(false);
  });

  it("does nothing when the composer already has focus", () => {
    expect(shouldReclaimComposerFocus({ ...base, composerHasFocus: true })).toBe(
      false,
    );
  });

  it("stands down for a click outside this window (workbench / another pane)", () => {
    expect(
      shouldReclaimComposerFocus({ ...base, interactionInsidePane: false }),
    ).toBe(false);
  });

  it("preserves an in-progress transcript text selection", () => {
    expect(shouldReclaimComposerFocus({ ...base, hasTextSelection: true })).toBe(
      false,
    );
  });

  it("does not steal when a within-pane click opened a workbench surface", () => {
    // interactionInsidePane is true, but focus ended up on a plain element that
    // lives OUTSIDE the pane — isFocusHeldElsewhere backs us off.
    const workbenchTarget = mockEl({ tagName: "BUTTON" });
    expect(
      shouldReclaimComposerFocus({
        ...base,
        activeElement: workbenchTarget,
        paneRoot: mockPaneRoot([]), // does not contain workbenchTarget
      }),
    ).toBe(false);
  });

  it("does not steal when the click landed in a real input/menu/dialog", () => {
    expect(
      shouldReclaimComposerFocus({
        ...base,
        activeElement: mockEl({ tagName: "INPUT" }),
      }),
    ).toBe(false);
  });

  it("stands down while an overlay is open (model dropdown mid-open)", () => {
    // 2026-07-24 regression: clicking the composer's ModelPill opens the
    // AgentModelMenu popover, but focus only moves INTO it after the click
    // settles — activeElement still reads as the plain trigger button. The
    // overlay probe is what must hold the guardian back; without it the
    // reclaim ripped focus out of the opening menu and Radix dismissed it
    // ("dropdown flashes open and instantly closes").
    expect(
      shouldReclaimComposerFocus({
        ...base,
        hasOpenOverlay: true,
        activeElement: mockEl({ tagName: "BUTTON" }),
        paneRoot: mockPaneRoot([mockEl({ tagName: "BUTTON" })]),
      }),
    ).toBe(false);
  });

  it("reclaims again once the overlay has closed", () => {
    // Closing the menu (second click on the pill) leaves no overlay open —
    // focus returns to the composer so the user can type immediately.
    expect(
      shouldReclaimComposerFocus({ ...base, hasOpenOverlay: false }),
    ).toBe(true);
  });
});

describe("nextComposerFocusAction", () => {
  it("focuses on the rising edge once the editor is mounted", () => {
    expect(
      nextComposerFocusAction({
        owns: true,
        hasAcquired: false,
        editorReady: true,
      }),
    ).toBe("focus");
  });

  it("waits (noop) for the editor when a brand-new tab mounts as active", () => {
    // TipTap's editor can be null on first render; we must not burn the
    // one-shot latch on a dead focus() call — retry when it mounts.
    expect(
      nextComposerFocusAction({
        owns: true,
        hasAcquired: false,
        editorReady: false,
      }),
    ).toBe("noop");
  });

  it("does not re-focus while it already owns focus (no focus-steal on re-render)", () => {
    expect(
      nextComposerFocusAction({
        owns: true,
        hasAcquired: true,
        editorReady: true,
      }),
    ).toBe("noop");
  });

  it("releases the latch when ownership is lost so a return re-focuses", () => {
    expect(
      nextComposerFocusAction({
        owns: false,
        hasAcquired: true,
        editorReady: true,
      }),
    ).toBe("release");
    expect(
      nextComposerFocusAction({
        owns: false,
        hasAcquired: false,
        editorReady: true,
      }),
    ).toBe("noop");
  });
});
