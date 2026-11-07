import { memo, useMemo } from "react";

import { renderMarkdownSegments } from "@/renderer/features/agent/markdown";
import { MarkdownCodeBlock } from "@/renderer/features/agent/renderers/markdown-code-block";

/** A `.md` file reads like an agent answer: the chat's markdown
 *  (`.zeros-agent-md`) in a centred column, fences as highlighted code cards.
 *  File references stay plain code and links; nothing here opens a chip. */
export const MarkdownPreview = memo(function MarkdownPreview({
  markdown,
}: {
  markdown: string;
}) {
  const segments = useMemo(
    () => renderMarkdownSegments(markdown, { fileReferences: false }),
    [markdown],
  );
  return (
    <div className="zeros-agent-md text-fg1 mx-auto max-w-3xl min-w-0 select-text leading-relaxed">
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
