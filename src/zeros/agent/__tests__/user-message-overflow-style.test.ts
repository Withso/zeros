import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("narrow transcript message overflow", () => {
  it("bounds user bubbles to their lane and shrinks unbroken text", () => {
    expect(code("src/zeros/agent/turn-container.tsx")).toContain(
      "max-w-[min(768px,100%)]",
    );

    const textMessage = code("src/zeros/agent/renderers/text-message.tsx");
    expect(textMessage.match(/wrap-anywhere/g)).toHaveLength(2);
  });

  it("lets inline pills shrink with the user bubble", () => {
    expect(code("src/zeros/agent/composer-editor/pill-views.tsx")).toContain(
      '"inline-flex h-5 max-w-full',
    );
  });

  it("breaks unbroken markdown tokens without changing table min-content", () => {
    expect(source("styles/globals.css")).toMatch(
      /\.zeros-agent-md\s*\{[^}]*overflow-wrap:\s*break-word;/,
    );
  });
});
