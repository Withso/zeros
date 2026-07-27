// ──────────────────────────────────────────────────────────
// Editable-target predicate for global keyboard shortcuts
// ──────────────────────────────────────────────────────────
//
// The app's global window-level chord handlers (⌥⌘B toggle Column 3,
// ⌥⌘T cycle theme, ⌘N new chat, …) stand down when focus is inside a
// text-entry surface so they don't clobber typing in the chat
// composer or a rename input.
//
// The naive `tagName === "TEXTAREA"` check has one false positive:
// xterm.js receives keystrokes through a hidden
// `<textarea class="xterm-helper-textarea">` nested under a `.xterm`
// root. Treating that textarea as "editable" suppressed EVERY global
// shortcut whenever a terminal was focused — the col-2 terminal
// agents and the col-3 terminal row both became shortcut dead
// zones. On macOS a terminal never receives Cmd-key combos anyway
// (Cmd is reserved for app/menu shortcuts), so the app chords should
// win there.
//
// This predicate is the single source of truth for "should a global
// shortcut stand down for this target?". The entire xterm subtree is
// explicitly NOT editable for shortcut purposes; real inputs /
// textareas / contenteditable regions still are.
// ──────────────────────────────────────────────────────────

export function isEditableHotkeyTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // xterm's input proxy is a <textarea>, but global app chords must
  // pass through it — exclude the whole xterm subtree before the
  // generic text-entry check below.
  if (target.closest(".xterm")) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}
