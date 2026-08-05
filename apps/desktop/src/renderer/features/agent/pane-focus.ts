// ──────────────────────────────────────────────────────────
// pane-focus — "is this element inside the focused chat pane?"
// ──────────────────────────────────────────────────────────
//
// Split panes (2026-07-17) can mount several AgentChat instances at
// once, so cards that register WINDOW-level hotkeys (permission /
// question / plan-review) need a way to tell whether THEY belong to
// the focused pane — otherwise one keystroke with focus on <body>
// would resolve the card in every pane simultaneously.
//
// The pane container (conversation/pane-layout.tsx) marks each pane root with
// `data-pane-root` + `data-pane-focused`. DOM-based on purpose: the
// cards don't know their chat id, and this keeps them decoupled from
// the pane store.

/** True when `el` is inside the focused, visible pane — or not inside any pane
 *  at all (picker/beta flows, tests), which keeps the pre-panes behavior for
 *  chats mounted outside the split-pane tree. Retained chat/route layers are
 *  marked inert; their window listeners must stand down while their DOM is
 *  deliberately kept alive off-screen. */
export function isInFocusedPane(el: Element | null | undefined): boolean {
  if (el && (!el.isConnected || el.closest("[inert],[aria-hidden='true']"))) {
    return false;
  }
  const paneRoot = el?.closest("[data-pane-root]");
  if (!paneRoot) return true;
  return paneRoot.getAttribute("data-pane-focused") === "true";
}
