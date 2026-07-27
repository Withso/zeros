// ──────────────────────────────────────────────────────────
// CodeThemePreview — live sample of the selected code theme
// ──────────────────────────────────────────────────────────
//
// Renders a fixed TS snippet through the SAME highlighter every code surface
// uses (HighlightedCode → syntax.ts). The card sits on the app surface (bg2):
// like every code surface, the background never changes with the code theme —
// only the syntax TOKEN colors do. The picker only offers themes matching the
// current app variant (dark themes on the dark bg, light on light), so the
// preview always shows readable pairings, exactly as they render in the code
// blocks, diffs, editor, and terminal. Updates live as the picker (or the app
// theme) changes — HighlightedCode reads useCodeTheme.
// ──────────────────────────────────────────────────────────

import { HighlightedCode } from "@/zeros/agent/renderers/highlighted-code";

const SAMPLE = `// Fetch user data
async function getUser(id: number): Promise<User> {
  const response = await fetch(\`/api/users/\${id}\`);
  const data = response.json();
  return { name: data.name, active: true };
}`;

export function CodeThemePreview() {
  return (
    <div className="overflow-hidden rounded-lg border border-border1 bg-bg2">
      <HighlightedCode
        code={SAMPLE}
        lang="ts"
        className="overflow-x-auto px-4 py-3.5 font-mono text-xs leading-[1.6]"
      />
    </div>
  );
}
