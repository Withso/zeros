import { memo, useMemo, type SyntheticEvent } from "react";

import { renderMarkdownSegments } from "@/renderer/features/agent/markdown";
import { MarkdownCodeBlock } from "@/renderer/features/agent/renderers/markdown-code-block";
import { markdownLinkTarget } from "./markdown-links";

function linkedFile(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest("[data-file-path]")?.getAttribute("data-file-path") || null;
}

/** A `.md` file reads like an agent answer: the chat's markdown
 *  (`.zeros-agent-md`) in a centred column, fences as highlighted code cards.
 *  Its links to files are the chat's file references, resolved from `path`,
 *  and open through `onOpenFile`; without it they stay links. Inline code
 *  stays code, since a document's paths have no one root. */
export const MarkdownPreview = memo(function MarkdownPreview({
  markdown,
  path,
  onOpenFile,
  onWarmFile,
}: {
  markdown: string;
  path: string;
  onOpenFile?: (path: string) => void;
  onWarmFile?: (path: string) => void;
}) {
  const linked = onOpenFile !== undefined;
  const segments = useMemo(
    () =>
      renderMarkdownSegments(markdown, {
        fileLink: (href) => (linked ? markdownLinkTarget(href, path) : null),
      }),
    [markdown, path, linked],
  );
  const open = (event: SyntheticEvent) => {
    const file = linkedFile(event.target);
    if (!file || !onOpenFile) return;
    event.preventDefault();
    onOpenFile(file);
  };
  const warm = (event: SyntheticEvent) => {
    const file = linkedFile(event.target);
    if (file) onWarmFile?.(file);
  };
  return (
    <div
      className="zeros-agent-md text-fg1 mx-auto max-w-3xl min-w-0 select-text leading-relaxed"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") open(event);
      }}
      onPointerOver={warm}
      onFocus={warm}
    >
      {segments.map((segment, index) =>
        segment.type === "code" ? (
          <MarkdownCodeBlock key={index} code={segment.code} lang={segment.lang} />
        ) : (
          <div
            key={index}
            className="zeros-md-prose"
            dangerouslySetInnerHTML={{ __html: segment.html }}
          />
        ),
      )}
    </div>
  );
});
