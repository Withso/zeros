import postcss from "postcss";
import { describe, expect, it } from "vitest";
import {
  concatDesignCssIndexes,
  designFrameFeatures,
  designSelectorFeatures,
  designUnicodeRanges,
  indexDesignCss,
  measureDesignFrameSources,
  parseAndIndexDesignCss,
  pruneDesignFrameSources,
  splitDesignCss,
} from "../style-prune";

function prune(css: string | string[], html: string, stylesheets: string[] = []): string[] {
  const sources = Array.isArray(css) ? css : [css];
  return pruneDesignFrameSources(sources.map(parseAndIndexDesignCss), designFrameFeatures(html, { stylesheets }));
}

describe("what a selector needs", () => {
  it("lists classes, ids and element names outside functional pseudo-classes", () => {
    expect(designSelectorFeatures(".card .title > h2")).toEqual([".card", ".title", "h2"]);
    expect(designSelectorFeatures("#main.Card")).toEqual(["#main", ".card"]);
    expect(designSelectorFeatures(":root")).toEqual([]);
    expect(designSelectorFeatures("html body")).toEqual([]);
    expect(designSelectorFeatures('[data-zd-theme="dark"] .card')).toEqual([".card"]);
    expect(designSelectorFeatures(":where([data-zd-theme=\"dark\"]) &")).toEqual([]);
    expect(designSelectorFeatures("details[open] > summary")).toEqual(["details", "summary"]);
    expect(designSelectorFeatures("a:not(.active):hover")).toEqual(["a"]);
    expect(designSelectorFeatures(":is(.x, .y) .z")).toEqual([".z"]);
    expect(designSelectorFeatures("*")).toEqual([]);
    expect(designSelectorFeatures("::before")).toEqual([]);
    expect(designSelectorFeatures("input::placeholder")).toEqual(["input"]);
    expect(designSelectorFeatures("svg|rect")).toEqual(["rect"]);
  });

  it("decodes escaped class names as Tailwind writes them", () => {
    expect(designSelectorFeatures(".hover\\:bg-brand:hover")).toEqual([".hover:bg-brand"]);
    expect(designSelectorFeatures(".w-1\\/2")).toEqual([".w-1/2"]);
    expect(designSelectorFeatures(".\\[\\&_p\\]\\:mt-2 p")).toEqual([".[&_p]:mt-2", "p"]);
    expect(designSelectorFeatures(".\\31 0")).toEqual([".10"]);
  });

  it("keeps what it cannot read", () => {
    expect(designSelectorFeatures('[data-x="unterminated')).toBeNull();
    expect(designSelectorFeatures("50%")).toBeNull();
  });

  it("reads unicode-range lists and wildcards", () => {
    expect(designUnicodeRanges("U+0000-00FF, U+0131, U+4??")).toEqual([0, 0xff, 0x131, 0x131, 0x400, 0x4ff]);
    expect(designUnicodeRanges("bogus")).toBeNull();
  });
});

describe("indexing a stylesheet", () => {
  it("produces the same CSS as postcss", () => {
    const source = "@charset \"utf-8\";\n:root { --a: 1 }\n@media (min-width: 1px) { .a { color: red } @supports (display: grid) { .b { display: grid } } }\n.c { .d & { order: 1 } }";
    const root = postcss.parse(source);
    expect(indexDesignCss(root).css).toBe(root.toString());
  });

  it("splits only after top-level statements, never inside strings, comments or URLs", () => {
    const css = '.a { content: "}"; } /* } */ .b { background: url(data:x;{}) } @media (x) { .c { order: 1 } .d { order: 2 } } .e { order: 3 }';
    const pieces = splitDesignCss(css, 1);
    expect(pieces.join("")).toBe(css);
    expect(pieces.map((piece) => piece.trim())).toEqual([
      '.a { content: "}"; }',
      "/* } */ .b { background: url(data:x;{}) }",
      "@media (x) { .c { order: 1 } .d { order: 2 } }",
      ".e { order: 3 }",
    ]);
    expect(splitDesignCss(css, 10_000)).toEqual([css]);
  });

  it("prunes pieces joined into one index exactly as the whole stylesheet", () => {
    const css = [
      ":root { --font: 'Brand', serif; --unused-font: 'Other' }",
      "@font-face { font-family: Brand; src: url(a.woff2) }",
      "@font-face { font-family: Other; src: url(b.woff2) }",
      "@layer base { .unused { order: 1 } }",
      "@media (min-width: 1px) { .card { font-family: var(--font) } .gone { order: 2 } }",
      "@keyframes spin { to { rotate: 1turn } }",
      ".card { animation: spin 1s }",
    ].join("\n");
    const frame = designFrameFeatures('<div class="card"></div>');
    const whole = pruneDesignFrameSources([parseAndIndexDesignCss(css)], frame);
    const joined = concatDesignCssIndexes(splitDesignCss(css, 1).map(parseAndIndexDesignCss));
    expect(joined.css.replace(/\s+/g, " ")).toBe(parseAndIndexDesignCss(css).css.replace(/\s+/g, " "));
    const pruned = pruneDesignFrameSources([joined], frame);
    expect(pruned[0]!.replace(/\s+/g, " ")).toBe(whole[0]!.replace(/\s+/g, " "));
    expect(pruned[0]).toContain("Brand");
    expect(pruned[0]).not.toContain("url(b.woff2)");
    expect(pruned[0]).toContain("@keyframes spin");
    expect(measureDesignFrameSources([joined], frame)).toEqual([pruned[0]!.length]);
  });
});

describe("pruning per frame", () => {
  it("keeps rules the frame can match, in order, inside their wrappers", () => {
    const [css] = prune(
      ":root { --gap: 4px }\n.card { padding: var(--gap) }\n.unused { color: red }\n@media (min-width: 640px) { .card { margin: 0 } .unused { margin: 1px } }\n@media print { .unused { display: none } }\nh2 { font-weight: 600 }\nh3 { font-weight: 500 }\n[data-zd-theme=\"dark\"] .card { color: white }",
      '<main class="card"><h2>Title</h2></main>',
    );
    expect(css).toBe(":root { --gap: 4px }\n.card { padding: var(--gap) }\n@media (min-width: 640px) {\n.card { margin: 0 }\n}\nh2 { font-weight: 600 }\n[data-zd-theme=\"dark\"] .card { color: white }");
  });

  it("keeps a pruned named layer's place in the layer order", () => {
    const [css] = prune("@layer base { .unused { color: red } }\n@layer components { .card { order: 1 } }", '<div class="card"></div>');
    expect(css).toBe("@layer base;\n@layer components;\n@layer components {\n.card { order: 1 }\n}");
  });

  it("keeps every statement that is not a rule", () => {
    const [css] = prune("@layer theme, base;\n@property --tw-x { syntax: \"*\"; inherits: false }\n@page { margin: 1cm }\n.unused { order: 1 }", "<p></p>");
    expect(css).toBe("@layer theme, base;\n@property --tw-x { syntax: \"*\"; inherits: false }\n@page { margin: 1cm }");
  });

  it("keeps font faces for families the kept CSS reaches through custom properties", () => {
    const fonts = "@font-face { font-family: 'Geist Variable'; src: url(data:font/woff2;base64,AA) }\n@font-face { font-family: 'Geist Mono Variable'; src: url(data:font/woff2;base64,BB) }";
    const app = ":root { --font-sans: 'Geist Variable', sans-serif; --font-mono: 'Geist Mono Variable', monospace; --default-font-family: var(--font-sans) }\nhtml { font-family: var(--default-font-family) }\ncode { font-family: var(--font-mono) }";
    const [prose] = prune([fonts, app], "<p>Hi</p>");
    expect(prose).toContain("'Geist Variable'");
    expect(prose).not.toContain("Geist Mono");
    const [code] = prune([fonts, app], "<p><code>x</code></p>");
    expect(code).toContain("Geist Mono");
  });

  it("keeps font faces the frame's own stylesheets or markup name", () => {
    const fonts = "@font-face { font-family: Brand; src: url(a.woff2) }";
    expect(prune(fonts, "<p>x</p>")[0]).toBe("");
    expect(prune(fonts, '<p style="font-family: Brand, serif">x</p>')[0]).toContain("Brand");
    expect(prune(fonts, "<p>x</p>", ["body { font-family: \"Brand\" }"])[0]).toContain("Brand");
  });

  it("keeps only the subsets whose unicode-range covers the frame's text", () => {
    const fonts = [
      "@font-face { font-family: Acme; src: url(cyrillic.woff2); unicode-range: U+0400-045F }",
      "@font-face { font-family: Acme; src: url(latin-ext.woff2); unicode-range: U+0100-024F }",
      "@font-face { font-family: Acme; src: url(latin.woff2); unicode-range: U+0000-00FF }",
      "body { font-family: Acme }",
    ].join("\n");
    const ascii = prune(fonts, "<p>Hello</p>")[0]!;
    expect(ascii).toContain("latin.woff2");
    expect(ascii).not.toContain("cyrillic");
    expect(ascii).not.toContain("latin-ext");
    expect(prune(fonts, "<p>Привет</p>")[0]).toContain("cyrillic.woff2");
    expect(prune(fonts, "<p>&#x0141;&oacute;dź</p>")[0]).toContain("latin-ext.woff2");
    // An entity it cannot read keeps every subset.
    expect(prune(fonts, "<p>&unknownentity;</p>")[0]).toContain("cyrillic.woff2");
  });

  it("keeps keyframes the kept CSS names, including through custom properties", () => {
    const css = ":root { --animate-spin: spin 1s linear infinite }\n@keyframes spin { to { rotate: 360deg } }\n@keyframes pulse { 50% { opacity: .5 } }\n.animate-spin { animation: var(--animate-spin) }\n.animate-pulse { animation: pulse 2s infinite }";
    const [kept] = prune(css, '<i class="animate-spin"></i>');
    expect(kept).toContain("@keyframes spin");
    expect(kept).not.toContain("@keyframes pulse");
  });

  it("keeps characters from kept content values", () => {
    const css = "@font-face { font-family: Icons; src: url(arrows.woff2); unicode-range: U+2190-21FF }\n.next::after { content: \"\\2192\"; font-family: Icons }";
    expect(prune(css, '<a class="next"></a>')[0]).toContain("arrows.woff2");
    expect(prune(css, "<a></a>")[0]).toBe("");
  });
});

describe("a frame's features", () => {
  it("reads classes, ids, elements, variables and characters from markup", () => {
    const features = designFrameFeatures('<!doctype html><main id="Root" class="card  Card--big [&amp;_p]:mt-2"><svg><linearGradient/></svg><p style="color: var(--fg1)">Café &rarr;</p></main>');
    expect([...features.classes].sort()).toEqual(["[&_p]:mt-2", "card", "card--big"]);
    expect([...features.ids]).toEqual(["root"]);
    expect([...features.tags].sort()).toEqual(["body", "head", "html", "lineargradient", "main", "p", "svg"]);
    expect([...features.variables]).toEqual(["--fg1"]);
    expect(features.codePoints).toEqual([0xe9, 0x2192]);
  });

  it("changes its signature only when pruning could change", () => {
    const one = designFrameFeatures('<p class="a">Hello</p>');
    expect(designFrameFeatures('<p class="a">World</p>').signature).toBe(one.signature);
    expect(designFrameFeatures('<p class="b">Hello</p>').signature).not.toBe(one.signature);
    expect(designFrameFeatures('<p class="a">Héllo</p>').signature).not.toBe(one.signature);
  });
});
