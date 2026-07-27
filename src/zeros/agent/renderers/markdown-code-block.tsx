// ──────────────────────────────────────────────────────────
// MarkdownCodeBlock — a fenced code block in agent output
// ──────────────────────────────────────────────────────────
//
// Every ``` fence in the agent's reply renders through here: shiki-
// highlighted (the user's unified code theme, resolved per app variant, via
// HighlightedCode / syntax.ts) inside a bordered card (--border2) with a
// copy button that fades in on hover. Non-code "structure" fences (dir
// trees, shell transcripts, the `text` language, or no language) render
// plain but keep the same card chrome + copy affordance.
//
// The card margin + colours live in styles/globals.css under
// `.zeros-agent-md .zeros-md-codeblock` so the chat's first/last-child
// margin resets win over them; this file owns only the layout/interaction.
// ──────────────────────────────────────────────────────────

import { memo } from "react";

import { CodeBlockCopyButton } from "@/zeros/ui/primitives/elements/code-block";
import { HighlightedCode } from "./highlighted-code";

export const MarkdownCodeBlock = memo(function MarkdownCodeBlock({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  // Drop a single trailing newline so the card never shows an empty last row.
  const body = code.endsWith("\n") ? code.slice(0, -1) : code;

  return (
    <div className="zeros-md-codeblock group/md-code relative overflow-hidden rounded-lg border border-border2 bg-bg2">
      <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity duration-150 group-hover/md-code:opacity-100 focus-within:opacity-100">
        <CodeBlockCopyButton
          text={body}
          className="bg-bg2/70 backdrop-blur-sm hover:bg-bg2-hover"
        />
      </div>
      <HighlightedCode
        code={body}
        lang={lang || "text"}
        className="overflow-x-auto px-4 py-3 font-mono text-xs leading-[1.6] text-fg1 [&_code]:!bg-transparent [&_pre]:!bg-transparent"
      />
    </div>
  );
});
