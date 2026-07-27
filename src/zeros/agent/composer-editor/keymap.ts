// ──────────────────────────────────────────────────────────
// keymap.ts — composer submit / newline keybindings
// ──────────────────────────────────────────────────────────
//
// priority:1000 so Enter beats the paragraph default. Enter (and ⌘/Ctrl+
// Enter) submit; Shift+Enter splits to a new line. IME composition is
// respected by ProseMirror's keymap plumbing, so Enter while composing a
// CJK candidate commits the candidate instead of submitting.
//
// The optional hooks (onArrowUp / onArrowDown / onModEnter / onDeleteKey)
// drive the queued-messages card's virtual selection from inside the
// editor: each returns true to CONSUME the key (selection moved / row
// acted on) or false to fall through to the editor default (caret
// movement, character deletion). Suggestion pickers run at higher
// priority, so an open @/slash menu still owns the arrows first.
// ──────────────────────────────────────────────────────────

import { Extension } from "@tiptap/core";

export interface ComposerKeymapOptions {
  /** Plain Enter / ⌘Enter → submit the composer. */
  onSubmit: () => void;
  /** Escape → caller handler (e.g. cancel edit-in-place, drop the queue
   *  selection). Only fires when a suggestion picker did NOT already consume
   *  Escape (the Suggestion plugins run at higher priority, so an open menu
   *  eats Escape first). Return `false` to fall through to the editor
   *  default; void/true = consumed (back-compat with void handlers). */
  onEscape?: () => void | boolean;
  /** ⌘/Ctrl+Enter — tried BEFORE onSubmit (e.g. "send queued row now").
   *  Return false to fall through to onSubmit. */
  onModEnter?: () => boolean;
  onArrowUp?: () => boolean;
  onArrowDown?: () => boolean;
  /** Backspace/Delete — e.g. delete the selected queued row. */
  onDeleteKey?: () => boolean;
}

export const ComposerKeymap = Extension.create<ComposerKeymapOptions>({
  name: "composerKeymap",
  priority: 1000,

  addOptions() {
    return {
      onSubmit: () => {},
      onEscape: undefined,
      onModEnter: undefined,
      onArrowUp: undefined,
      onArrowDown: undefined,
      onDeleteKey: undefined,
    };
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => {
        this.options.onSubmit();
        return true;
      },
      "Mod-Enter": () => {
        if (this.options.onModEnter?.()) return true;
        this.options.onSubmit();
        return true;
      },
      // Soft newline. No HardBreak node in the minimal set → split to a new
      // paragraph (CSS keeps paragraphs tight so it reads as one newline);
      // serializeComposer joins blocks with "\n".
      "Shift-Enter": () => this.editor.commands.splitBlock(),
      ArrowUp: () => this.options.onArrowUp?.() ?? false,
      ArrowDown: () => this.options.onArrowDown?.() ?? false,
      Backspace: () => this.options.onDeleteKey?.() ?? false,
      Delete: () => this.options.onDeleteKey?.() ?? false,
      Escape: () => {
        if (this.options.onEscape) {
          return this.options.onEscape() !== false;
        }
        return false;
      },
    };
  },
});
