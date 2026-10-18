import { afterEach, describe, expect, it, vi } from "vitest";
import { marked } from "marked";

// These assertions measure parsing and immutable segments. DOM sanitization
// remains in the shared renderer and is exercised by the browser harness.
vi.mock("dompurify", () => ({ default: { addHook() {}, sanitize: (html: string) => html } }));
import { createStreamingMarkdownRenderer, renderMarkdownSegments } from "../markdown";

afterEach(() => vi.restoreAllMocks());

describe("Local streaming markdown", () => {
  it("parses a closed code prefix once while the tail grows", () => {
    const prefix = `A complete example:\n\n\`\`\`ts\n${"const value = 1;\n".repeat(1_000)}\`\`\`\n\n`;
    const parse = createStreamingMarkdownRenderer();
    const lexer = vi.spyOn(marked, "lexer");
    const first = parse(`${prefix}Tail`);
    for (let index = 1; index <= 100; index++) {
      const rendered = parse(`${prefix}Tail${"x".repeat(index)}`);
      expect(rendered[1]).toEqual(first[1]);
    }
    const chars = lexer.mock.calls.reduce((sum, [input]) => sum + input.length, 0);
    console.info(JSON.stringify({ streamedUpdates: 100, lexedCharacters: chars, inputCharacters: prefix.length + 104 }));
    expect(chars).toBeLessThan(prefix.length * 2);
    expect(parse(`${prefix}Tail${"x".repeat(100)}`)[1]).toBe(first[1]);
  });

  it.each([
    "Paragraph\n\n```ts\nconst value = [];\n```\n\nNext **paragraph**",
    "~~~text\nfirst\n~~~~\n\n| a | b |\n| - | - |\n| 1 | 2 |\n",
    "```text\nfirst\n```\n\n```text\nsecond\n```\n\nlast",
    "An unresolved [ref].\n\n```text\nvalue\n```\n\n[ref]: https://example.test\n",
    "[ref]: https://example.test\n\n```text\nvalue\n```\n\nThe [ref].",
    "- A list\n\n  ```ts\n  const value = 1;\n  ```\n\n  More in the list",
    "> quoted\n> ```\n> code\n> ```\n\nrest",
    "```text\r\nfirst\r\n```\r\n\r\nrest",
    "```text\nfirst\n```not-a-close\nlast",
    "<div>\n```text\nnot a fence\n```\n</div>\n\nrest",
  ])("matches the existing renderer at every append boundary: %s", (input) => {
    const parse = createStreamingMarkdownRenderer();
    for (let length = 0; length <= input.length; length++) {
      const text = input.slice(0, length);
      expect(parse(text)).toEqual(renderMarkdownSegments(text));
    }
  });

  it("releases a cached prefix on correction, truncation and replacement", () => {
    const parse = createStreamingMarkdownRenderer();
    for (const input of ["```ts\nlet a = 1;\n```\n\nTail", "Corrected", "Correct", "", "```ts\nlet b = 2;\n```\n\nNew"])
      expect(parse(input)).toEqual(renderMarkdownSegments(input));
  });

  it("keeps the ordinary cloud/static parser stateless", () => {
    const lexer = vi.spyOn(marked, "lexer");
    const input = "```ts\nconst value = 1;\n```\n\nTail";
    renderMarkdownSegments(input);
    renderMarkdownSegments(`${input} grows`);
    expect(lexer.mock.calls.map(([text]) => text)).toEqual([input, `${input} grows`]);
  });
});
