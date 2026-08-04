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
//   • StateField holds the DecorationSet and maps it through every edit so
//     colors stay positioned during the async tokenize gap,
//   • a StateEffect installs fresh tokens,
//   • a ViewPlugin drives the async work with a DEBOUNCE + a GENERATION counter
//     (stale results from edits/theme/lang switches mid-flight are dropped),
//   • all dispatches happen in a deferred task (never inside CM's update cycle),
//   • a large-file guard skips Shiki (editor still works, no color),
//   • the editor BACKGROUND is always the app surface (--bg1) regardless
//     of code theme; only the base/token text colors come from the theme, so the
//     editor matches the transparent-on-app-bg diff + code-block surfaces.
//
// We hand-roll this instead of depending on @cmshiki/* (experimental, 1
// maintainer) — see project_files_tab_editor memory.
// ──────────────────────────────────────────────────────────

import {
  Facet,
  RangeSetBuilder,
  StateEffect,
  StateField,
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
import { highlightToTokens } from "@/zeros/agent/renderers/syntax";

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
/** Re-check cadence while the editor sits in a hidden retained layer — see
 *  the visibility gate in run(). */
const HIDDEN_RETRY_MS = 1_000;

export interface ShikiConfig {
  /** Shiki bundled language id, or null → no color (plain + Lezer structure). */
  lang: string | null;
  /** Shiki theme name. */
  theme: string;
}

const DEFAULT_CONFIG: ShikiConfig = {
  lang: null,
  theme: "github-dark-default",
};

const shikiConfig = Facet.define<ShikiConfig, ShikiConfig>({
  combine: (vals) => vals[vals.length - 1] ?? DEFAULT_CONFIG,
});

const setDecos = StateEffect.define<DecorationSet>();

const shikiField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    // Keep colors positioned during the async tokenize gap.
    decos = decos.map(tr.changes);
    for (const e of tr.effects) if (e.is(setDecos)) decos = e.value;
    return decos;
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
      // Dispatching decorations re-enters CodeMirror's measure loop, and a
      // visibility:hidden retained deck can never stabilize its viewport —
      // each dispatch re-arms another rAF measure pass and eventually logs
      // "Measure loop restarted more than 5 times", a permanent hidden-layout
      // treadmill. Park the (re)tokenize until the editor is actually
      // rendered; one idle timeout per hidden editor is far cheaper than a
      // hidden relayout, and the first visible retry paints within a second.
      const dom = view.dom;
      if (
        typeof dom.checkVisibility === "function" &&
        !dom.checkVisibility()
      ) {
        if (this.timer != null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          void this.run(view);
        }, HIDDEN_RETRY_MS);
        return;
      }
      const myGen = ++this.gen; // race guard
      const cfg = view.state.facet(shikiConfig);
      const doc = view.state.doc;

      // No language, or too big → clear color + base style overrides.
      if (!cfg.lang || doc.lines > MAX_LINES || doc.length > MAX_CHARS) {
        if (myGen === this.gen) {
          this.applyBase(view, null);
          view.dispatch({ effects: setDecos.of(Decoration.none) });
        }
        return;
      }

      const code = doc.toString(); // the EXACT string we map tokens back onto
      const res = await highlightToTokens(code, cfg.lang, cfg.theme);

      // Drop stale: a newer run started, or the doc changed under us.
      if (myGen !== this.gen || view.state.doc.toString() !== code) return;

      if (!res) {
        this.applyBase(view, null);
        view.dispatch({ effects: setDecos.of(Decoration.none) });
        return;
      }
      this.applyBase(view, res);
      view.dispatch({
        effects: setDecos.of(
          buildShikiDecorations(res.tokens, view.state.doc.length),
        ),
      });
    }

    // Base (non-token / Shiki-uncolored) text uses the THEME foreground so it
    // matches exactly (Shiki tokens override per-token on top). The BACKGROUND is
    // always the app surface (the editor chrome's --bg1) regardless of
    // code theme — every code surface keeps ONE consistent bg; only the text
    // colors change. Cleared so an earlier theme's paint never lingers and so the
    // foreground resets (→ chrome defaults) when there's no result.
    private applyBase(
      view: EditorView,
      res: { fg?: string } | null,
    ) {
      view.contentDOM.style.color = res?.fg ?? "";
      view.dom.style.backgroundColor = "";
      view.scrollDOM.style.backgroundColor = "";
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
