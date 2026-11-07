import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// DOMPurify needs a DOM; the chat's sanitizer is exercised by the browser
// harnesses. These assertions pin what the Files tab mounts for a `.md` file.
vi.mock("dompurify", () => ({ default: { addHook() {}, sanitize: (html: string) => html } }));
vi.mock("@/renderer/features/agent/renderers/highlighted-code", () => ({
  HighlightedCode: ({ code }: { code: string }) => code,
}));

import { MarkdownPreview } from "../markdown-preview";

const README = "# Title\n\nRead `src/app.ts` and [the guide](docs/guide.md).\n\n```ts\nconst value = 1;\n```\n";
const render = (markdown: string) =>
  renderToStaticMarkup(createElement(MarkdownPreview, { markdown }));

describe("Files tab markdown preview", () => {
  it("renders with the chat's markdown: its size, prose runs and code cards", () => {
    const html = render(README);
    const root = /^<div class="([^"]*)"/.exec(html)?.[1].split(" ") ?? [];
    expect(root).toContain("zeros-agent-md");
    // The size and element styles come from `.zeros-agent-md`, not the column.
    expect(root.filter((name) => /^(text-(?!fg)|leading-|\[&)/.test(name))).toEqual(["leading-relaxed"]);
    expect(html).toContain('<div class="zeros-md-prose"><h1>Title</h1>');
    expect(html).toContain("zeros-md-codeblock");
    expect(html).toContain("const value = 1;");
    expect(html).not.toContain("<pre><code");
  });

  it("keeps file references as code and links, which nothing in the preview opens", () => {
    const html = render(README);
    expect(html).not.toContain("data-file-path");
    expect(html).toContain("<code>src/app.ts</code>");
    expect(html).toContain('<a href="docs/guide.md">the guide</a>');
  });

  it("renders nothing for an empty file", () => {
    expect(render("")).toMatch(/^<div class="[^"]*zeros-agent-md[^"]*"><\/div>$/);
  });
});
