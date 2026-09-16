// ──────────────────────────────────────────────────────────
// CodeThemePreview — live sample of the selected code theme
// ──────────────────────────────────────────────────────────
//
// Renders a fixed TS snippet through the SAME highlighter every code surface
// uses (HighlightedCode → syntax.ts). It has no surface of its own — it sits
// on the Appearance card — and, like every code surface, the background never
// changes with the code theme; only the syntax TOKEN colors do. The picker only offers themes matching the
// current app variant (dark themes on the dark bg, light on light), so the
// preview always shows readable pairings, exactly as they render in the code
// blocks, diffs, editor, and terminal. Updates live as the picker (or the app
// theme) changes — HighlightedCode reads useCodeTheme.
// ──────────────────────────────────────────────────────────

import { HighlightedCode } from "@/renderer/features/agent/renderers/highlighted-code";

// Three lines, chosen to show a keyword, a call, a template string, a
// property access, and a literal — enough to tell code themes apart.
const SAMPLE = `const user = await fetch(\`/api/users/\${id}\`);
const data = await user.json();
return { name: data.name, active: true };`;

const LINES = SAMPLE.split("\n").length;

/** Inline preview row for the Appearance card: NO surface of its own (no
 *  fill, border, or rounding — the diff-tinted / boxed variants were dropped
 *  2026-09-14), just a muted 1..N gutter and the highlighted lines sitting
 *  directly on the card. */
export function CodeThemePreview() {
  return (
    <div className="flex font-mono text-xs leading-[1.6]">
      <div
        aria-hidden
        className="text-fg2/45 shrink-0 pr-4 pl-2 text-right tabular-nums select-none"
      >
        {Array.from({ length: LINES }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <HighlightedCode
        code={SAMPLE}
        lang="ts"
        className="min-w-0 flex-1 overflow-x-auto [&_.line]:!leading-[1.6] [&_code]:!leading-[1.6] [&_pre]:!p-0 [&_pre]:!leading-[1.6]"
      />
    </div>
  );
}
