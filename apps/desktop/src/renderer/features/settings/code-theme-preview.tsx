
import { HighlightedCode } from "@/renderer/features/agent/renderers/highlighted-code";

const SAMPLE = `const user = await fetch(\`/api/users/\${id}\`);
const data = await user.json();
return { name: data.name, active: true };`;

const LINES = SAMPLE.split("\n").length;

// Use the shared highlighter without changing the background so the preview matches code surfaces.
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
