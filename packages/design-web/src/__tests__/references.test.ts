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
