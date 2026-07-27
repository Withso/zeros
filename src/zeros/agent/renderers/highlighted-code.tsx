// ──────────────────────────────────────────────────────────
// HighlightedCode — shiki-highlighted code, flash-free
// ──────────────────────────────────────────────────────────
//
// One component for every "render code with colors" surface (the Files-tab
// viewer, the agent's expandable tool output, …). It leans on the shared
// highlighter in syntax.ts:
//
//   • If the highlighter is already WARM (see warmHighlighter / the idle
//     warm-up), `highlightSync` returns the colored HTML during render — so
//     the very first paint is highlighted, NO white flash.
//   • If it's still cold, we render a plain (escaped) placeholder and swap in
//     the colored HTML once the async worker call resolves. We also kick a
//     warm-up so the NEXT view is synchronous.
//   • Results are cached in syntax.ts, so a re-open / re-render is instant.
//
// The consumer owns the surrounding chrome (bg, padding, wrap-vs-scroll) via
// `className`; this component only neutralizes shiki's own <pre> background and
// margin so it sits flush inside that chrome.
// ──────────────────────────────────────────────────────────

import { memo, useEffect, useMemo, useState } from "react";

import { cn } from "@/zeros/ui/cn";
import { highlightCode, highlightSync, plainCode, warmHighlighter } from "./syntax";
import { useCodeTheme } from "@/zeros/appearance/use-code-theme";
import { resolveCodeTheme } from "@/zeros/appearance/code-themes";

// Locked line-height shared by the gutter column and the code column so the
// numbers line up 1:1 with the code rows (matches the Files-tab viewer).
const CODE_LEADING = "leading-[1.6]";

interface HighlightedCodeProps {
  code: string;
  /** A shiki language id (see getLang). `text` renders plain, no highlighting. */
  lang: string;
  /** Outer wrapper classes — bg / padding / wrap / scroll live here. */
  className?: string;
}

// Lines coloured SYNCHRONOUSLY for a large file's first paint — enough to cover
// the viewport (plus a few screens of scroll) while the worker colours the whole
// file. A few hundred lines highlight in a few ms; the full file would block the
// main thread for hundreds.
const HEAD_HL_LINES = 240;

/** Index of the `n`-th `\n` in `s`, or -1 if there are fewer than `n`. Slices
 *  the leading lines without splitting the whole (possibly huge) string. */
function nthNewlineIndex(s: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    idx = s.indexOf("\n", idx + 1);
    if (idx === -1) return -1;
  }
  return idx;
}

/** Colour just the leading `n` lines (cheap) and keep the remainder as escaped
 *  plain text — so a large file paints an instantly-coloured viewport with the
 *  rest present for scrolling. Null when the file is small enough for the normal
 *  path, there's nothing to colour, or the highlighter is still cold. */
function highlightHead(
  code: string,
  lang: string,
  n: number,
  theme: string,
): { colored: string; restHtml: string } | null {
  if (lang === "text") return null;
  const nl = nthNewlineIndex(code, n);
  if (nl === -1) return null; // fewer than n lines — small enough already
  const colored = highlightSync(code.slice(0, nl), lang, theme);
  if (colored === null) return null; // highlighter still cold → caller shows plain
  // Drop a single trailing newline so the plain tail doesn't render a phantom
  // final line (shiki doesn't paint one) — keeps lines 1:1 with the gutter.
  let rest = code.slice(nl + 1);
  if (rest.endsWith("\n")) rest = rest.slice(0, -1);
  return { colored, restHtml: rest === "" ? "" : plainCode(rest) };
}

export const HighlightedCode = memo(function HighlightedCode({
  code,
  lang,
  className,
}: HighlightedCodeProps) {
  // Re-highlight when the user's code theme changes. Resolve the shiki theme
  // NAME and thread it through so the memo/effect deps are honest (the syntax
  // cache is keyed by theme, so each theme caches separately).
  const themeName = resolveCodeTheme(useCodeTheme()).shiki;
  // Sync attempt, recomputed when (code, lang, theme) changes. When the
  // highlighter is warm AND the file is small enough this IS the colored HTML
  // during render — first paint shows colors, no flash. `null` while the
  // highlighter is cold OR the file is too large to colour on the main thread.
  const sync = useMemo(
    () => highlightSync(code, lang, themeName),
    [code, lang, themeName],
  );
  // Large-but-warm file: `sync` is null (a full highlight would block the main
  // thread), but the LEADING lines can still be coloured synchronously — they
  // cover the viewport, so first paint is coloured + correct with no plain
  // flash. The worker then colours the whole file and we swap to it (seamless:
  // the head lines are identical, the tail fills in below the fold).
  const head = useMemo(
    () =>
      sync === null ? highlightHead(code, lang, HEAD_HL_LINES, themeName) : null,
    [sync, code, lang, themeName],
  );
  const [asyncHtml, setAsyncHtml] = useState<string | null>(null);

  useEffect(() => {
    if (sync !== null) return; // already colored synchronously
    // Cold / large path: warm for next time + colour the whole file in the
    // worker (off the main thread), then swap in.
    setAsyncHtml(null);
    void warmHighlighter();
    let cancelled = false;
    void highlightCode(code, lang, themeName).then((out) => {
      if (!cancelled) setAsyncHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, sync, themeName]);

  const cls = cn("[&_pre]:m-0 [&_pre]:!bg-transparent", className);

  // Fully coloured: a small file synchronously, or the worker finished the big one.
  const full = sync ?? asyncHtml;
  if (full !== null) {
    return (
      <div
        className={cls}
        // shiki escapes its own output.
        dangerouslySetInnerHTML={{ __html: full }}
      />
    );
  }

  // Big file, first paint: coloured leading lines + plain remainder. Both render
  // as flush shiki <pre> ([&_pre]:m-0), so the viewport is coloured + correct
  // immediately and the full content is present for scroll.
  if (head !== null) {
    return (
      <div className={cls}>
        <div dangerouslySetInnerHTML={{ __html: head.colored }} />
        {head.restHtml !== "" && (
          <div dangerouslySetInnerHTML={{ __html: head.restHtml }} />
        )}
      </div>
    );
  }

  // Cold highlighter (rare — before the idle warm-up): plain placeholder, swapped
  // to colour once the worker resolves.
  return (
    <div className={cls} dangerouslySetInnerHTML={{ __html: plainCode(code) }} />
  );
});

interface CodeWithGutterProps {
  code: string;
  lang: string;
  /** First line number (1-based) — the ACTUAL line the read started at, so a
   *  partial read shows e.g. 1222–1280 instead of 1–60. */
  startLine?: number;
  /** Height cap before the body scrolls in place. */
  maxHeightClass?: string;
  className?: string;
}

/** Highlighted code with a sticky line-number gutter starting at `startLine`.
 *  Lines DON'T wrap (horizontal scroll) so each code row maps 1:1 to its gutter
 *  number. Used by the Read tool's expanded body. */
export const CodeWithGutter = memo(function CodeWithGutter({
  code,
  lang,
  startLine = 1,
  maxHeightClass = "max-h-[320px]",
  className,
}: CodeWithGutterProps) {
  const lineCount = useMemo(() => {
    const trimmed = code.endsWith("\n") ? code.slice(0, -1) : code;
    return trimmed.length === 0 ? 1 : trimmed.split("\n").length;
  }, [code]);
  const gutter = useMemo(
    () => Array.from({ length: lineCount }, (_, i) => startLine + i),
    [lineCount, startLine],
  );

  return (
    <div
      className={cn(
        "flex overflow-auto rounded-md bg-bg2/60 font-mono text-sm",
        CODE_LEADING,
        maxHeightClass,
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          "sticky left-0 z-10 shrink-0 select-none border-r border-border1 bg-bg2/60 px-2 py-2 text-right tabular-nums text-fg2/45",
          CODE_LEADING,
        )}
      >
        {gutter.map((n) => (
          <div key={n}>{n}</div>
        ))}
      </div>
      <HighlightedCode
        code={code}
        lang={lang}
        className="min-w-0 flex-1 px-3 py-2 text-fg1 [&_pre]:!p-0 [&_pre]:!leading-[1.6] [&_code]:!leading-[1.6] [&_.line]:!leading-[1.6]"
      />
    </div>
  );
});
