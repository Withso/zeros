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

const README =
  "# Title\n\nRead `src/app.ts`, [the guide](guide.md), [the rules](../RULES.md) and [the site](https://example.com).\n\n```ts\nconst value = 1;\n```\n";
const render = (markdown: string, onOpenFile?: (path: string) => void) =>
  renderToStaticMarkup(
    createElement(MarkdownPreview, { markdown, path: "docs/README.md", onOpenFile }),
  );

describe("Files tab markdown preview", () => {
  it("renders with the chat's markdown: its size, prose runs and code cards", () => {
    const html = render(README, () => {});
    const root = /^<div class="([^"]*)"/.exec(html)?.[1].split(" ") ?? [];
    expect(root).toContain("zeros-agent-md");
    // The size and element styles come from `.zeros-agent-md`, not the column.
    expect(root.filter((name) => /^(text-(?!fg)|leading-|\[&)/.test(name))).toEqual(["leading-relaxed"]);
    expect(html).toContain('<div class="zeros-md-prose"><h1>Title</h1>');
    expect(html).toContain("zeros-md-codeblock");
    expect(html).toContain("const value = 1;");
    expect(html).not.toContain("<pre><code");
  });

  it("turns links to files into the chat's file references, resolved from the file's folder", () => {
    const html = render(README, () => {});
    expect(html).toContain(
      '<code class="zeros-md-filepath" data-file-path="docs/guide.md" title="docs/guide.md" role="link" tabindex="0">the guide</code>',
    );
    expect(html).toContain('data-file-path="RULES.md"');
    expect(html).toContain('<a href="https://example.com">the site</a>');
    // Inline code names no root, so it stays code.
    expect(html).toContain("<code>src/app.ts</code>");
  });

  it("keeps links as links when nothing can open them", () => {
    const html = render(README);
    expect(html).not.toContain("data-file-path");
    expect(html).toContain('<a href="guide.md">the guide</a>');
  });

  it("renders nothing for an empty file", () => {
    expect(render("", () => {})).toMatch(/^<div class="[^"]*zeros-agent-md[^"]*"><\/div>$/);
  });
});
