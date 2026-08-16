// ──────────────────────────────────────────────────────────
// Shortcuts catalog — the app's first central keybinding registry
// ──────────────────────────────────────────────────────────
//
// Until now every shortcut was hand-rolled in its own component and its UI
// hint string was duplicated inline. This file is the single source of truth
// for the ⌘/ shortcuts palette: a flat, data-only list of the shortcuts we
// ship today, grouped into the four review buckets — General, View, Chats,
// Workspace. It intentionally describes shortcuts (label + chord + category)
// rather than wiring their actions; the palette is a discovery / review
// surface for now, and executing a row from here is a follow-up. Add, retitle,
// and recategorize entries here — the palette renders whatever this exports,
// in order.
//
// Chord glyphs use the macOS convention (⌃⌥⇧⌘ ordering, then the key):
//   ⌘ Command · ⇧ Shift · ⌥ Option · ⌃ Control · ↵ Return
//   ↑ ↓ arrows · ↖ Home · ↘ End
// ──────────────────────────────────────────────────────────

export interface ShortcutDef {
  /** Stable, unique, kebab-case id. */
  id: string;
  /** Human label shown as the row's primary text. */
  label: string;
  /** One or more key-combo chords, each rendered as its own <Kbd> chip.
   *  Usually a single chord, e.g. ["⌘T"]. */
  keys: string[];
  /** Extra never-shown search terms that widen fuzzy matching. */
  keywords?: string[];
}

export interface ShortcutCategory {
  /** Stable, unique, kebab-case id. */
  id: string;
  /** Group heading / tab label shown for the category. */
  label: string;
  shortcuts: ShortcutDef[];
}

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    id: "general",
    label: "General",
    shortcuts: [
      {
        id: "show-shortcuts",
        label: "Show all shortcuts",
        keys: ["⌘/"],
        keywords: ["keyboard", "keys", "cheatsheet", "help", "palette"],
      },
      {
        id: "open-folder",
        label: "Open folder…",
        keys: ["⇧⌘O"],
        keywords: ["project", "repository", "directory"],
      },
      {
        id: "send-feedback",
        label: "Send feedback",
        keys: ["⌥⌘F"],
        keywords: ["bug", "report", "issue", "logs", "support", "help"],
      },
      {
        id: "close-window",
        label: "Close window",
        keys: ["⌘W"],
      },
      {
        id: "quit",
        label: "Quit Zeros",
        keys: ["⌘Q"],
        keywords: ["exit"],
      },
    ],
  },
  {
    id: "view",
    label: "View",
    shortcuts: [
      {
        id: "toggle-right-panel",
        label: "Toggle right panel",
        keys: ["⌥⌘B"],
        keywords: ["column", "sidebar", "workspace", "collapse"],
      },
      {
        id: "open-browser",
        label: "Open Browser",
        keys: ["⇧⌘B"],
        keywords: ["web", "url", "site", "internet", "right panel"],
      },
      {
        id: "toggle-theme",
        label: "Toggle theme",
        keys: ["⌥⌘T"],
        keywords: ["dark", "light", "appearance", "mode"],
      },
      {
        id: "toggle-fullscreen",
        label: "Toggle full screen",
        keys: ["⌃⌘F"],
      },
      {
        id: "zoom-in",
        label: "Zoom in",
        keys: ["⌘="],
        keywords: ["bigger", "larger"],
      },
      {
        id: "zoom-out",
        label: "Zoom out",
        keys: ["⌘-"],
        keywords: ["smaller"],
      },
      {
        id: "reset-zoom",
        label: "Reset zoom",
        keys: ["⌘0"],
        keywords: ["actual size", "100%"],
      },
    ],
  },
  {
    id: "chats",
    label: "Chats",
    shortcuts: [
      {
        id: "new-chat",
        label: "New chat",
        keys: ["⌘T"],
        keywords: ["tab", "agent", "conversation"],
      },
      {
        id: "new-terminal-agent",
        label: "New terminal agent",
        keys: ["⇧⌘T"],
        keywords: ["tab", "shell"],
      },
      {
        id: "focus-composer",
        label: "Focus message box",
        keys: ["⌘K"],
        keywords: ["compose", "input", "prompt", "write"],
      },
      {
        id: "previous-message",
        label: "Previous message",
        keys: ["⌘↑"],
        keywords: ["jump", "scroll", "up"],
      },
      {
        id: "next-message",
        label: "Next message",
        keys: ["⌘↓"],
        keywords: ["jump", "scroll", "down"],
      },
      {
        id: "first-message",
        label: "First message",
        keys: ["⌘↖"],
        keywords: ["top", "home", "start"],
      },
      {
        id: "last-message",
        label: "Last message",
        keys: ["⌘↘"],
        keywords: ["bottom", "end", "latest"],
      },
      {
        id: "send-message",
        label: "Send message",
        keys: ["↵"],
        keywords: ["submit", "enter", "return"],
      },
      {
        id: "send-now",
        label: "Send now",
        keys: ["⌘↵"],
        keywords: ["submit", "queue", "flush"],
      },
      {
        id: "insert-line-break",
        label: "Insert line break",
        keys: ["⇧↵"],
        keywords: ["newline", "soft return"],
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    shortcuts: [
      {
        id: "run",
        label: "Run",
        keys: ["⌘R"],
        keywords: ["build", "start", "dev", "execute"],
      },
      {
        id: "open-worktree",
        label: "Open workspace in default app",
        keys: ["⌘O"],
        keywords: ["editor", "external", "worktree", "reveal"],
      },
      {
        id: "copy-workspace-path",
        label: "Copy workspace path",
        keys: ["⌘C"],
        keywords: ["worktree", "clipboard", "directory"],
      },
    ],
  },
];

/** The cmdk `value` a row filters on: label + chords + keywords + category
 *  + id, joined into one blob (cmdk lowercases and subsequence-matches).
 *  Category label is included so typing a category name (e.g. "view") matches
 *  all of its shortcuts. */
export function shortcutSearchValue(
  shortcut: ShortcutDef,
  category: ShortcutCategory,
): string {
  return [
    category.label,
    shortcut.label,
    shortcut.keys.join(" "),
    ...(shortcut.keywords ?? []),
    shortcut.id,
  ].join(" ");
}
