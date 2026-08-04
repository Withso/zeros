// ──────────────────────────────────────────────────────────
// Shiki color layer for CodeMirror (the hybrid)
// ──────────────────────────────────────────────────────────
//
// Paints the editor using SHIKI tokens as inline-color mark decorations, so the
// editor's colors are byte-identical to the diff view + code blocks (all Shiki).
// The Lezer LanguageSupport stays (folding/indent/brackets); we just add this
// color layer on top — Shiki's inline `style="color:…"` overrides any base
// HighlightStyle. Built to the verified spec:
//   • whole-doc tokenization (occasional manual edits, not heavy typing),
//   • the StateField's `create` tokenizes SYNCHRONOUSLY off the warm shared
//     highlighter, so the FIRST painted frame already wears the code theme —
//     opening or switching files must never flash unthemed text and repaint
//     (@uiw/react-codemirror builds the state in a layout effect, i.e. before
//     paint, so decorations produced here are in that first frame),
//   • the field also maps its decorations through every edit so colors stay
//     positioned during an async tokenize gap,
//   • a StateEffect installs fresh tokens,
//   • a ViewPlugin drives the async work with a DEBOUNCE + a GENERATION counter
//     (stale results from edits/theme/lang switches mid-flight are dropped), and
//     SKIPS it entirely when `create` already produced a complete paint,
//   • all dispatches happen in a deferred task (never inside CM's update cycle),
//   • a large-file guard skips Shiki (editor still works, no color); a file that
//     is merely too big to tokenize synchronously still gets its LEADING lines
//     themed on first paint, with the complete pass swapping in right after,
//   • the editor BACKGROUND is always the app surface (--bg1) regardless
//     of code theme; only the base/token text colors come from the theme, so the
//     editor matches the transparent-on-app-bg diff + code-block surfaces. The
//     base foreground is applied by the chrome theme (see theme.ts) rather than
//     imperatively here, so it too lands on the first paint.
//
// We hand-roll this instead of depending on @cmshiki/* (experimental, 1
// maintainer) — see project_files_tab_editor memory.
// ──────────────────────────────────────────────────────────

import {
  Facet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { ThemedToken } from "shiki";
import {
  highlightToTokens,
  SYNC_TOKENIZE_MAX,
  tokenizeSync,
  type TokenizedCode,
} from "@/zeros/agent/renderers/syntax";

// Shiki FontStyle bitmask (shikijs/vscode-textmate): Italic=1, Bold=2,
// Underline=4, Strikethrough=8.
const FS_ITALIC = 1;
const FS_BOLD = 2;
const FS_UNDERLINE = 4;
const FS_STRIKE = 8;

// Skip Shiki above these (keeps typing snappy on huge files; the editor still
// works, just uncolored). Re-checked on every doc change.
const MAX_LINES = 5_000;
const MAX_CHARS = 300_000;
const DEBOUNCE_MS = 75;
// Files too big to tokenize synchronously still theme this many leading lines on
// the first paint (~5ms) — more than a viewport — while the full pass runs.
const FIRST_PAINT_HEAD_LINES = 240;

export interface ShikiConfig {
  /** Shiki bundled language id, or null → no color (plain + Lezer structure). */
  lang: string | null;
  /** Shiki theme name. */
  theme: string;
  /** False for an editor that mounts OFFSCREEN (the file viewer keeps one behind
   *  the Diff / Markdown-preview surface so drafts survive view switches). There
   *  is no first paint to get right, so skip the synchronous tokenize and let the
   *  deferred pass do the work — the toggle into Edit is themed either way. */
  syncFirstPaint?: boolean;
}

const DEFAULT_CONFIG: ShikiConfig = {
  lang: null,
  theme: "github-dark-default",
};

const shikiConfig = Facet.define<ShikiConfig, ShikiConfig>({
  combine: (vals) => vals[vals.length - 1] ?? DEFAULT_CONFIG,
});

/** The field's value: the decorations plus the config they are a COMPLETE paint
 *  of. `complete` is null when nothing is painted, when only the head lines are
 *  (a big file's first paint), or when the doc changed under the paint — i.e.
 *  exactly when the async pass still owes the editor a result. */
interface ShikiPaint {
  decos: DecorationSet;
  complete: ShikiConfig | null;
}

const NO_PAINT: ShikiPaint = { decos: Decoration.none, complete: null };

const setPaint = StateEffect.define<ShikiPaint>();

const shikiField = StateField.define<ShikiPaint>({
  create: (state) => firstPaint(state),
  update(paint, tr) {
    let decos = paint.decos;
    let complete = paint.complete;
    // Keep colors positioned during the async tokenize gap; an edit also
    // invalidates "complete" so the plugin re-tokenizes.
    if (tr.docChanged) {
      decos = decos.map(tr.changes);
      complete = null;
    }
    for (const e of tr.effects) {
      if (e.is(setPaint)) {
        decos = e.value.decos;
        complete = e.value.complete;
      }
    }
    return decos === paint.decos && complete === paint.complete
      ? paint
      : { decos, complete };
  },
  provide: (f) => EditorView.decorations.from(f, (paint) => paint.decos),
});

/** Tokenize the initial document on the spot when the shared highlighter can
 *  answer synchronously. NB: only `create` may read facets like this — a
 *  StateField's `update` must never touch `tr.state` (it would re-enter state
 *  construction), which is why a lang/theme switch is handled by the plugin
 *  below instead. That's the right split anyway: a switch repaints from already
 *  correct colors, whereas a fresh mount would otherwise start unthemed. */
function firstPaint(state: EditorState): ShikiPaint {
  const cfg = state.facet(shikiConfig);
  const doc = state.doc;
  if (
    cfg.syncFirstPaint === false ||
    !cfg.lang ||
    doc.lines > MAX_LINES ||
    doc.length > MAX_CHARS
  ) {
    return NO_PAINT;
  }
  const partial = doc.length > SYNC_TOKENIZE_MAX;
  // For a large document, materialize only the head we will tokenize. Calling
  // doc.toString() here used to allocate all 60–300k characters merely so
  // tokenizeSync could scan back to the 240th newline and discard the tail.
  const headLine = partial
    ? doc.line(Math.min(FIRST_PAINT_HEAD_LINES, doc.lines))
    : null;
  let code = headLine ? doc.sliceString(0, headLine.to) : doc.toString();
  // Preserve tokenizeSync's long-line guard: when the first 240 lines alone
  // exceed its budget, include only their terminating line break so its
  // headLines path can find the same boundary it found in the whole document.
  const headOptions =
    headLine && code.length > SYNC_TOKENIZE_MAX && headLine.number < doc.lines
      ? { headLines: FIRST_PAINT_HEAD_LINES }
      : undefined;
  if (headOptions && headLine) {
    code += doc.sliceString(headLine.to, doc.line(headLine.number + 1).from);
  }
  const res = tokenizeSync(code, cfg.lang, cfg.theme, headOptions);
  if (!res) return NO_PAINT;
  return {
    decos: buildShikiDecorations(res.tokens, doc.length),
    complete: partial ? null : cfg,
  };
}

/** Whether a stored complete-paint marker still describes `cfg`. */
function paintMatches(complete: ShikiConfig | null, cfg: ShikiConfig): boolean {
  return (
    complete !== null &&
    complete.lang === cfg.lang &&
    complete.theme === cfg.theme
  );
}

// Cache identical Decoration objects so the RangeSet can structure-share.
const markCache = new Map<string, Decoration>();
function markFor(tok: ThemedToken): Decoration | null {
  const fs = tok.fontStyle ?? 0;
  const decls: string[] = [];
  if (tok.color) decls.push(`color:${tok.color}`);
  if (fs & FS_ITALIC) decls.push("font-style:italic");
  if (fs & FS_BOLD) decls.push("font-weight:bold");
  const td: string[] = [];
  if (fs & FS_UNDERLINE) td.push("underline");
  if (fs & FS_STRIKE) td.push("line-through");
  if (td.length) decls.push(`text-decoration:${td.join(" ")}`);
  if (decls.length === 0) return null; // nothing to style → inherit
  const style = decls.join(";");
  let deco = markCache.get(style);
  if (!deco) {
    deco = Decoration.mark({ attributes: { style } });
    markCache.set(style, deco);
  }
  return deco;
}

export function buildShikiDecorations(
  tokens: ThemedToken[][],
  docLen: number,
): DecorationSet {
  // Shiki tokens are in document order with absolute UTF-16 offsets (== CM
  // positions), so RangeSetBuilder's sorted-input contract is satisfied.
  const b = new RangeSetBuilder<Decoration>();
  for (const line of tokens) {
    for (const tok of line) {
      const from = tok.offset;
      const to = from + tok.content.length;
      if (to <= from || from < 0 || to > docLen) continue; // empty/stale guard
      const deco = markFor(tok);
      if (deco) b.add(from, to, deco);
    }
  }
  return b.finish();
}

const shikiPlugin = ViewPlugin.fromClass(
  class {
    private gen = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(view: EditorView) {
      this.schedule(view, true);
    }

    update(u: ViewUpdate) {
      const a = u.startState.facet(shikiConfig);
      const b = u.state.facet(shikiConfig);
      const cfgChanged = a.lang !== b.lang || a.theme !== b.theme;
      // A theme/lang switch isn't an edit — re-tokenize immediately (still
      // deferred via setTimeout, so still safe). Only real doc edits debounce.
      if (cfgChanged) this.schedule(u.view, true);
      else if (u.docChanged) this.schedule(u.view, false);
    }

    // Always defer (even "immediate") so we never dispatch inside CM's update
    // cycle (the constructor + update() both run inside it).
    private schedule(view: EditorView, immediate: boolean) {
      if (this.timer != null) clearTimeout(this.timer);
      this.timer = setTimeout(
        () => {
          this.timer = null;
          void this.run(view);
        },
        immediate ? 0 : DEBOUNCE_MS,
      );
    }

    private async run(view: EditorView) {
      const myGen = ++this.gen; // race guard
      const cfg = view.state.facet(shikiConfig);
      const doc = view.state.doc;

      // The synchronous first paint (or an earlier async pass) already covers
      // this exact config — nothing to redo, and no redundant dispatch.
      if (paintMatches(view.state.field(shikiField).complete, cfg)) return;

      // No language, or too big → clear color (the base foreground stays the
      // theme's, supplied by the chrome theme).
      if (!cfg.lang || doc.lines > MAX_LINES || doc.length > MAX_CHARS) {
        if (myGen === this.gen) {
          view.dispatch({
            effects: setPaint.of({ decos: Decoration.none, complete: cfg }),
          });
        }
        return;
      }

      const code = doc.toString(); // the EXACT string we map tokens back onto
      const res: TokenizedCode | null = await highlightToTokens(
        code,
        cfg.lang,
        cfg.theme,
      );

      // Drop stale: a newer run started, or the doc changed under us. CM's Text
      // is immutable and only replaced by a doc-changing transaction, so
      // identity IS "the doc changed" — and it costs nothing, unlike
      // re-stringifying a 300k-char document on every completion.
      if (myGen !== this.gen || view.state.doc !== doc) return;

      view.dispatch({
        effects: setPaint.of({
          decos: res
            ? buildShikiDecorations(res.tokens, doc.length)
            : Decoration.none,
          // A missing grammar is settled, not pending: mark it complete so a
          // plain file doesn't re-tokenize on every keystroke.
          complete: cfg,
        }),
      });
    }

    destroy() {
      this.gen++; // any in-flight tokenize result will be dropped
      if (this.timer != null) clearTimeout(this.timer);
    }
  },
);

/** The Shiki color layer. Recreate (new config) to switch language/theme — the
 *  field + plugin are module-level so they persist across reconfigure; only the
 *  facet value changes, and the plugin re-tokenizes on the diff. */
export function shikiColors(config: ShikiConfig): Extension {
  return [shikiConfig.of(config), shikiField, shikiPlugin];
}
