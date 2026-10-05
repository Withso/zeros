import { describe, expect, it } from "vitest";
import { resolveDesignLocalReference, rebaseDesignCssReferences, rebaseDesignHtmlReferences } from "../references";

describe("contained source-relative Design references", () => {
  it.each([
    ["../tokens.css", "page-1/home.html", "tokens.css"],
    ["./local.png?size=2#pixel", "page-1/home.html", "page-1/local.png"],
    ["../assets/image.png", "styles/theme.css", "assets/image.png"],
    ["?theme=night#top", "page-1/home.html", "page-1/home.html"],
  ])("resolves %s from %s", (url, owner, expected) => {
    expect(resolveDesignLocalReference(url, owner)).toBe(expected);
  });
  it.each(["../../outside.png", "../%2e%2e/outside.png", "..\\outside.png", "/outside.png", "https://example.com/image.png", "//example.com/image.png", "../%00.png", "../%5c.png"])(
    "rejects escaping or ambiguous references: %s", (url) => {
      expect(resolveDesignLocalReference(url, "page-1/home.html")).toBeNull();
    },
  );
  it("rebases supported HTML references surgically, retaining query/hash and unrelated bytes", () => {
    const html = '<!doctype html>\n<html><body><!-- src="assets/fake.png" --><img src=assets/a.png?x=1#p srcset="assets/a.png 1x, assets/b.png 2x"><a href="#title">Title</a><div style="background:url(assets/a.png)"></div></body></html>';
    const result = rebaseDesignHtmlReferences(html, "", "page-1/home.html");
    expect(result).toBe(html.replace("src=assets/a.png?x=1#p", "src=../assets/a.png?x=1#p").replace('srcset="assets/a.png 1x, assets/b.png 2x"', 'srcset="../assets/a.png 1x, ../assets/b.png 2x"').replace("url(assets/a.png)", "url(../assets/a.png)"));
  });
  it("keeps CSS whitespace and comments while rebasing declaration URLs", () => {
    const css = '/* url(assets/fake.png) */\n.a { background : url( "assets/a.png?q#h" ) ; color: red }\n';
    expect(rebaseDesignCssReferences(css, "", "page-1/home.html")).toBe(css.replace('"assets/a.png?q#h"', '"../assets/a.png?q#h"'));
  });

  it("leaves URL-like text in strings and declaration comments untouched", () => {
    const css = '.a { content: "url(assets/a.png)"; background: /* url(assets/fake.png) */ url("assets/a(b).png") }';
    expect(rebaseDesignCssReferences(css, "", "page-1/home.html")).toBe(css.replace('url("assets/a(b).png")', 'url("../assets/a(b).png")'));
  });
});

describe("migration reference rebasing", () => {
  const options = { movedFiles: { "home.html": "page-1/home.html", "details.html": "page-1/details.html" }, strict: true };

  it("maps moved targets, shared assets and imports while preserving authored bytes", () => {
    const source = '<!doctype html>\n<!-- href="home.html" -->\n<link href="tokens.css"><a href="details.html?q=1&amp;other=2#part">Details</a><img srcset="assets/a.png 1x, data:image/png;base64,AA 2x"><video poster="assets/a.png"></video><div style="background: url(assets/a.png)"></div><style>/* url(fake.png) */ @import "shared.css" screen; .a { content:"url(fake.png)"; background:url("assets/a(b).png") }</style><template><a href=details.html>Details</a></template>';
    expect(rebaseDesignHtmlReferences(source, "home.html", "page-1/home.html", options)).toBe(source
      .replace('href="tokens.css"', 'href="../tokens.css"')
      .replace('srcset="assets/a.png', 'srcset="../assets/a.png')
      .replace('poster="assets/a.png"', 'poster="../assets/a.png"')
      .replace("url(assets/a.png)", "url(../assets/a.png)")
      .replace('@import "shared.css"', '@import "../shared.css"')
      .replace('url("assets/a(b).png")', 'url("../assets/a(b).png")'));
  });

  it("updates stationary inbound HTML and CSS with the same helper", () => {
    const html = '<!-- home.html --><a href=home.html?q#part>Home</a><img srcset="details.html 1x, assets/a.png 2x">';
    expect(rebaseDesignHtmlReferences(html, "notes.html", "notes.html", options)).toBe(html.replace("href=home.html", "href=page-1/home.html").replace('srcset="details.html', 'srcset="page-1/details.html'));
    const css = '/* home.html */ @import "../home.html" screen; @import url( "../details.html?q#h" ); .a { background:url("../home.html#icon"); content:"url(../home.html)" }';
    expect(rebaseDesignCssReferences(css, "styles/theme.css", "styles/theme.css", options)).toBe(css.replace('@import "../home.html"', '@import "../page-1/home.html"').replace('"../details.html?q#h"', '"../page-1/details.html?q#h"').replace('url("../home.html#icon")', 'url("../page-1/home.html#icon")'));
  });

  it("retains absolute, data, protocol-relative, mail and fragment URLs", () => {
    const source = '<a href="#section">A</a><a href="mailto:a@example.test">B</a><img src="//example.test/a.png"><img src="https://example.test/a.png"><img src="data:image/png;base64,AA">';
    expect(rebaseDesignHtmlReferences(source, "home.html", "page-1/home.html", options)).toBe(source);
  });

  it("preserves encoded query suffixes and unrelated HTML entity spellings", () => {
    const source = '<a href="home.html?q=1&#38;other=2#top" title="&#65;">Home</a>';
    expect(rebaseDesignHtmlReferences(source, "notes.html", "notes.html", options)).toBe(source.replace('href="home.html', 'href="page-1/home.html'));
  });

  it("retains a directory URL's trailing slash and suffix when its containing frame moves", () => {
    const source = '<a href="assets/?size=1&amp;other=2#top">Assets</a>';
    expect(rebaseDesignHtmlReferences(source, "home.html", "page-1/home.html", options)).toBe(source.replace('href="assets/', 'href="../assets/'));
  });

  it("uses only registered own targets when a URL matches an object prototype name", () => {
    const source = '<a href="constructor">Docs</a><a href="__proto__">More docs</a>';
    expect(rebaseDesignHtmlReferences(source, "home.html", "page-1/home.html", options)).toBe(source
      .replace('href="constructor"', 'href="../constructor"')
      .replace('href="__proto__"', 'href="../__proto__"'));
  });

  it("rebases CSS inside a style element whose parser location reaches EOF", () => {
    const source = '<style>.a { background:url(assets/a.png) }';
    expect(rebaseDesignHtmlReferences(source, "home.html", "page-1/home.html", options)).toBe(source.replace("url(assets/a.png)", "url(../assets/a.png)"));
  });

  it.each([
    '<base href="./"><img src="assets/a.png">',
    '<img src="../outside.png">',
    '<img src="assets/%2e%2e/a.png">',
    '<style>.a { background:url(h\\6fme.html) }</style>',
    '<style>@import "h\\6fme.html";</style>',
    '<style>.a { background:url(var(--image)) }</style>',
    '<style>.a { background:image-set("home.html" 1x) }</style>',
  ])("rejects references whose migration cannot be proved safe: %s", (source) => {
    expect(() => rebaseDesignHtmlReferences(source, "home.html", "page-1/home.html", options)).toThrow(/safely|unsupported|ambiguous|escape/i);
  });
});
