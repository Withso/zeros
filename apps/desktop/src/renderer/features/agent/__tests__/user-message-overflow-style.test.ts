import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("narrow transcript message overflow", () => {
  it("bounds user bubbles to their lane and wraps unbroken text", () => {
    // The row caps at the 800px lane; the bubble sits at its right edge and
    // caps at 7/8 of it, so unbroken text wraps inside that.
    const turnContainer = code("../turn-container.tsx");
    expect(turnContainer).toContain(
      '"zeros-agent-turn-prompt group/usermsg relative flex w-full max-w-[800px] min-w-0 flex-col items-end"',
    );
    expect(turnContainer).toContain('"w-fit max-w-7/8 min-w-0 cursor-text px-3 py-2 select-text"');

    const textMessage = code("../renderers/text-message.tsx");
    expect(textMessage.match(/wrap-anywhere/g)).toHaveLength(2);
  });

  it("lets inline pills shrink with the user bubble", () => {
    expect(code("../composer-editor/pill-views.tsx")).toContain(
      '"inline-flex h-5 max-w-[calc(100%-3px)]',
    );
  });

  it("breaks unbroken markdown tokens without changing table min-content", () => {
    expect(
      source("../../../../../../../styles/global/runtime-content.css"),
    ).toMatch(
      /\.zeros-agent-md\s*\{[^}]*overflow-wrap:\s*break-word;/,
    );
  });

  it("folds a long sent message behind its own Show more, never a reveal overlay", () => {
    const turnContainer = code("../turn-container.tsx");

    expect(turnContainer).toContain("<PromptFold surfaceActive={surfaceActive}>");
    expect(turnContainer).not.toContain("ClampedUserPrompt");
    expect(turnContainer).not.toContain("max-h-[600px]");
    expect(turnContainer).not.toContain("group/more");
  });

  it("keeps checkpoint rows on the hover their floating surface binds", () => {
    const checkpointRail = code("../checkpoint-rail.tsx");
    const hoverCard = code("../../../shared/ui/primitives/hover-card.tsx");

    expect(hoverCard).toContain("FLOATING_SURFACE");
    expect(checkpointRail).toContain('? "bg-(--surface-hover) text-fg1"');
    expect(checkpointRail).toContain(': "text-fg2 hover:bg-(--surface-hover)"');
  });
});
