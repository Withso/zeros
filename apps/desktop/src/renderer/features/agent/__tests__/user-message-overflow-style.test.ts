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
  it("bounds user bubbles to their lane and shrinks unbroken text", () => {
    expect(code("../turn-container.tsx")).toContain("max-w-[min(768px,100%)]");

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

  it("keeps the sent-message reveal hover visible in both themes", () => {
    const turnContainer = code("../turn-container.tsx");

    expect(turnContainer).toContain(
      "group-hover/more:bg-bg1-hover dark:group-hover/more:bg-bg2-hover",
    );
  });

  it("keeps checkpoint rows on the hover token for their bg2 surface", () => {
    const checkpointRail = code("../checkpoint-rail.tsx");
    const hoverCard = code("../../../shared/ui/primitives/hover-card.tsx");

    expect(hoverCard).toContain("border-border2 bg-bg2 text-fg1");
    expect(checkpointRail).toContain('? "bg-bg2-hover text-fg1"');
    expect(checkpointRail).toContain(': "text-fg2 hover:bg-bg2-hover"');
  });
});
