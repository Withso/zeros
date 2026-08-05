// ──────────────────────────────────────────────────────────
// composer-focus — pure decision helpers for auto-focusing the composer
// ──────────────────────────────────────────────────────────
//
// The composer should pull keyboard focus whenever its chat becomes the single
// active ("focused") chat window — creating a new tab, switching tabs, clicking
// into another split pane, or opening a chat from History all route through the
// global `activeChatId`, so one rule covers them all. But split panes mount
// several AgentChat instances at once (each pane's displayed chat is
// `surfaceActive`), so the focus MUST be gated on `activeChatId === chatId` or
// every composer would grab focus and the last one would win.
//
// The logic lives here as small pure functions so the tricky "only the active
// window, and never steal from another input the user moved to" rules are
// unit-testable in the node test env (no DOM/React harness) — the same
// duck-typed approach as pane-focus.ts / its test.
// ──────────────────────────────────────────────────────────

/** True when THIS chat owns the composer focus: it is the single global active
 *  chat AND its composer is actually on screen (not concealed by a permission /
 *  question card, and not a hidden/parked retained layer). `composerConcealed`
 *  already folds in `!surfaceActive`, so this is the complete on-screen test. */
export function composerOwnsFocus(params: {
  chatId: string | null | undefined;
  activeChatId: string | null;
  composerConcealed: boolean;
}): boolean {
  const { chatId, activeChatId, composerConcealed } = params;
  if (composerConcealed) return false;
  // No chatId → a standalone AgentChat (picker / beta / tests) that isn't part
  // of the split-pane tree. Keep the pre-split "focus when the composer is on
  // screen" behavior rather than gating on a global selection it never joins.
  if (!chatId) return true;
  return activeChatId === chatId;
}

/** True when focus currently sits on something we must NOT yank it away from:
 *  another input / textarea / contenteditable (a rename field, a different
 *  pane's composer the user just clicked into), or an open menu / dialog.
 *  `<body>` (nothing meaningfully focused) and plain buttons (a tab the user
 *  clicked to switch) are fair game — those paths SHOULD focus the composer.
 *
 *  Duck-typed (reads `tagName` / `isContentEditable` / `closest`) so it runs
 *  under the node test env, exactly like isInFocusedPane in pane-focus.ts. */
export function isFocusEngaged(el: Element | null | undefined): boolean {
  if (!el) return false;
  const tag = (el as { tagName?: string }).tagName;
  // <body> or a detached/unknown node → nothing is really holding focus.
  if (!tag || tag === "BODY") return false;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if ((el as { isContentEditable?: boolean }).isContentEditable) return true;
  return typeof el.closest === "function"
    ? el.closest("[role=menu],[role=dialog]") !== null
    : false;
}

/** True when keyboard focus currently rests on a surface the composer must NOT
 *  pull it away from, because the user is deliberately there. Two ways that
 *  happens:
 *    1. an engaged input / menu / dialog ANYWHERE (isFocusEngaged), or
 *    2. any real focused element OUTSIDE this chat window's pane — another split
 *       pane, or the Files / Changes / Review / Terminal workspace surface
 *       (workbench). Workbench is a sibling of the pane tree, and several of its
 *       rows aren't "engaged" (the file-tree host element, the Changes buttons,
 *       the Review sub-tab buttons all read as plain elements), so isFocusEngaged
 *       alone would happily steal focus from them — the pane-containment test is
 *       what actually honors the "only workbench defocuses the composer" rule.
 *
 *  `<body>` / null (nothing meaningfully focused) is free to reclaim. A focused
 *  element INSIDE this window (a tab, a message action button) is also fair game
 *  — that's the "click a button, keep the composer hot" behavior. When no
 *  `paneRoot` is supplied (a standalone composer outside the split-pane tree —
 *  picker / beta / tests) this degrades to the engaged-only test, preserving the
 *  pre-split behavior. Duck-typed (tagName / contains) to stay usable from the
 *  node test env, like the other helpers here. */
export function isFocusHeldElsewhere(params: {
  activeElement: Element | null | undefined;
  paneRoot: Element | null | undefined;
}): boolean {
  const { activeElement, paneRoot } = params;
  if (isFocusEngaged(activeElement)) return true;
  if (!activeElement) return false;
  const tag = (activeElement as { tagName?: string }).tagName;
  // Nothing (or a detached node) holds focus → the composer may reclaim it.
  if (!tag || tag === "BODY") return false;
  if (!paneRoot || typeof paneRoot.contains !== "function") return false;
  // A real element owns focus: leave it only if it lives OUTSIDE this window.
  return !paneRoot.contains(activeElement);
}

/** Whether a pointer interaction inside the active chat window should pull focus
 *  back to its composer. The product rule (2026-07-22): while you are in the chat
 *  column, the active window's composer is ALWAYS focused — clicking its
 *  transcript, empty space, a message button, or the tab strip, or scrolling,
 *  all return focus to the composer so you can just type. This is the piece the
 *  rising-edge focus effect (nextComposerFocusAction) can't cover: a click WITHIN
 *  the already-active window changes neither activeChatId nor the concealed flag,
 *  so that effect never re-runs and focus stayed lost.
 *
 *  It stands down when:
 *    - this chat isn't the single active window (`owns`),
 *    - the composer already has focus (nothing to do; don't disturb the caret),
 *    - the interaction happened OUTSIDE this window (`interactionInsidePane`) —
 *      a click in workbench or another pane keeps its own focus,
 *    - the user is selecting transcript text (`hasTextSelection`) — reclaiming
 *      would collapse the range they're about to copy,
 *    - an overlay is open (`hasOpenOverlay`) — the click just opened (or is
 *      interacting with) a popover / dropdown / dialog whose content portals
 *      to <body>. The activeElement test alone can NOT cover this: the click
 *      microtask runs BEFORE Radix's focus scope moves focus into the overlay
 *      (a passive effect), so `document.activeElement` is still the plain
 *      trigger button and reads as reclaimable. Reclaiming then rips focus out
 *      of the just-opened overlay and Radix dismisses it on the spot — the
 *      "composer model dropdown flashes open and instantly closes" bug
 *      (2026-07-24). The caller passes a DOM probe for any open overlay
 *      content, which IS mounted synchronously by the time the microtask runs,
 *    - focus landed somewhere we must not steal from (`isFocusHeldElsewhere`):
 *      another input / menu / dialog, or a workbench surface a click just opened.
 */
export function shouldReclaimComposerFocus(params: {
  owns: boolean;
  interactionInsidePane: boolean;
  composerHasFocus: boolean;
  hasTextSelection: boolean;
  hasOpenOverlay: boolean;
  activeElement: Element | null | undefined;
  paneRoot: Element | null | undefined;
}): boolean {
  const {
    owns,
    interactionInsidePane,
    composerHasFocus,
    hasTextSelection,
    hasOpenOverlay,
    activeElement,
    paneRoot,
  } = params;
  if (!owns) return false;
  if (composerHasFocus) return false;
  if (!interactionInsidePane) return false;
  if (hasTextSelection) return false;
  if (hasOpenOverlay) return false;
  return !isFocusHeldElsewhere({ activeElement, paneRoot });
}

/** CSS selector matching the content of any OPEN floating overlay the
 *  composer-focus guardian must never fight: Radix popovers & dialogs
 *  (role=dialog), dropdown/context menus (role=menu), and selects
 *  (role=listbox) all portal to <body> and stamp `data-state="open"` on their
 *  content. Deliberately role-scoped rather than matching Radix's popper
 *  wrapper so a lingering hover TOOLTIP (also popper-positioned) can't stop
 *  the guardian from doing its job. */
export const OPEN_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

/** What the focus effect should do this run, given the current ownership
 *  signal and two bits of latched state. Extracting the transition keeps the
 *  effect body a thin shell over a table-tested state machine:
 *
 *   - "focus"   — acquire focus for this ownership epoch (rising edge, editor
 *                 mounted, not yet acquired).
 *   - "release" — we lost ownership; clear the latch so re-acquiring re-focuses.
 *   - "noop"    — already acquired this epoch, still not the active chat, or the
 *                 editor hasn't mounted yet (we retry when it does).
 *
 *  `editorReady` guards the brand-new-tab case: TipTap's editor can be null for
 *  the first render, and focus() is a no-op then — so we wait rather than burn
 *  the one-shot latch on a dead call. */
export function nextComposerFocusAction(params: {
  owns: boolean;
  hasAcquired: boolean;
  editorReady: boolean;
}): "focus" | "release" | "noop" {
  const { owns, hasAcquired, editorReady } = params;
  if (!owns) return hasAcquired ? "release" : "noop";
  if (hasAcquired) return "noop";
  if (!editorReady) return "noop";
  return "focus";
}
