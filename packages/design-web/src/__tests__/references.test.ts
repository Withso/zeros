import { describe, expect, it } from "vitest";
import {
  designCssUrlReferences,
  designSrcsetReferences,
  resolveDesignLocalReference,
  rebaseDesignReference,
  rebaseDesignCssReferences,
  rebaseDesignHtmlReferences,
} from "../references";

describe("reference scanner spans", () => {
  it("retains quoted URL offsets, surrounding whitespace and parentheses", () => {
    const source = '/* ignored */ URL(  "  assets/a(b).png?q#p  "  )';
    expect(designCssUrlReferences(source)).toEqual([
      {
        start: 23,
        end: 42,
        url: "assets/a(b).png?q#p",
        functionStart: 14,
        functionEnd: 48,
      },
    ]);
  });

  it("keeps URL identifier boundaries", () => {
    const source = "noturl(a) -url(a) _url(a) \\url(a) .url(assets/a.png)";
    expect(designCssUrlReferences(source)).toEqual([
      {
        start: 39,
        end: 51,
        url: "assets/a.png",
        functionStart: 35,
        functionEnd: 52,
      },
    ]);
  });

  it.each([
    [
      'url( "a" trailing)',
      [
        {
          start: 6,
          end: 18,
          url: '"a" trailing',
          functionStart: 0,
          functionEnd: 18,
        },
      ],
    ],
    [
      'url("unclosed ) url(next.png)',
      [
        {
          start: 5,
          end: 14,
          url: '"unclosed',
          functionStart: 0,
          functionEnd: 15,
        },
        {
          start: 20,
          end: 28,
          url: "next.png",
          functionStart: 16,
          functionEnd: 29,
        },
      ],
    ],
    [
      '"unclosed url(inside.png)',
      [
        {
          start: 14,
          end: 24,
          url: "inside.png",
          functionStart: 10,
          functionEnd: 25,
        },
      ],
    ],
    [
      "/* unclosed url(inside.png)",
      [
        {
          start: 16,
          end: 26,
          url: "inside.png",
          functionStart: 12,
          functionEnd: 27,
        },
      ],
    ],
  ])(
    "preserves the public scanner's malformed-value fallback: %s",
    (source, expected) => {
      expect(designCssUrlReferences(source)).toEqual(expected);
    },
  );

  it("preserves whitespace around migrated and rendered references", () => {
    const source = "\u00a0\u2003assets/a.png?q#p \u2029\ufeff";
    for (const options of [
      {},
      { strict: true, movedFiles: { "home.html": "page-1/home.html" } },
    ]) {
      expect(
        rebaseDesignReference(source, "home.html", "page-1/home.html", options),
      ).toBe("\u00a0\u2003../assets/a.png?q#p \u2029\ufeff");
    }
  });

  it.each([false, true])(
    "retains splice precedence for overlapping import/declaration spans (strict: %s)",
    (strict) => {
      const source =
        '.a{background:url(assets/a.png)} @import "tokens.css" { .b{background:url(assets/b.png)}}';
      const options = strict
        ? { strict: true, movedFiles: { "home.html": "page-1/home.html" } }
        : {};
      const expected =
        '.a{background:url(../assets/a.png)} @import "' +
        (strict ? "../tokens.css" : "tokens.css") +
        '" { .b{background:url(../assets/b.pngpng)}}';
      expect(
        rebaseDesignCssReferences(
          source,
          "home.html",
          "page-1/home.html",
          options,
        ),
      ).toBe(expected);
      expect(
        rebaseDesignHtmlReferences(
          "<style>" + source + "</style>",
          "home.html",
          "page-1/home.html",
          options,
        ),
      ).toBe("<style>" + expected + "</style>");
    },
  );

  it("retains srcset URL spans and data-URL commas", () => {
    const source =
      " \tassets/a.png 1x, data:image/png;base64,AA 2x, assets/b.png, ";
    expect(
      designSrcsetReferences(source).map(({ start, end, url }) => ({
        start,
        end,
        url,
        raw: source.slice(start, end),
      })),
    ).toEqual([
      { start: 2, end: 14, url: "assets/a.png", raw: "assets/a.png" },
      {
        start: 19,
        end: 43,
        url: "data:image/png;base64,AA",
        raw: "data:image/png;base64,AA",
      },
      { start: 48, end: 60, url: "assets/b.png", raw: "assets/b.png" },
    ]);
  });

  it.each([
    "im/**/age(home.html)",
    'im"discarded"age(home.html)',
    "u\\72l(home.html)",
  ])("preserves strict unsupported-function detection: %s", (source) =>
    expect(() => designCssUrlReferences(source, true)).toThrow(
      /unsupported|ambiguous/,
    ),
  );
});

describe("contained source-relative Design references", () => {
  it.each([
    ["../tokens.css", "page-1/home.html", "tokens.css"],
    ["./local.png?size=2#pixel", "page-1/home.html", "page-1/local.png"],
    ["../assets/image.png", "styles/theme.css", "assets/image.png"],
    ["?theme=night#top", "page-1/home.html", "page-1/home.html"],
  ])("resolves %s from %s", (url, owner, expected) => {
    expect(resolveDesignLocalReference(url, owner)).toBe(expected);
  });
  it.each([
    "../../outside.png",
    "../%2e%2e/outside.png",
    "..\\outside.png",
    "/outside.png",
    "https://example.com/image.png",
    "//example.com/image.png",
    "../%00.png",
    "../%5c.png",
  ])("rejects escaping or ambiguous references: %s", (url) => {
    expect(resolveDesignLocalReference(url, "page-1/home.html")).toBeNull();
  });
  it("rebases supported HTML references surgically, retaining query/hash and unrelated bytes", () => {
    const html =
      '<!doctype html>\n<html><body><!-- src="assets/fake.png" --><img src=assets/a.png?x=1#p srcset="assets/a.png 1x, assets/b.png 2x"><a href="#title">Title</a><div style="background:url(assets/a.png)"></div></body></html>';
    const result = rebaseDesignHtmlReferences(html, "", "page-1/home.html");
    expect(result).toBe(
      html
        .replace("src=assets/a.png?x=1#p", "src=../assets/a.png?x=1#p")
        .replace(
          'srcset="assets/a.png 1x, assets/b.png 2x"',
          'srcset="../assets/a.png 1x, ../assets/b.png 2x"',
        )
        .replace("url(assets/a.png)", "url(../assets/a.png)"),
    );
  });
  it("keeps CSS whitespace and comments while rebasing declaration URLs", () => {
    const css =
      '/* url(assets/fake.png) */\n.a { background : url( "assets/a.png?q#h" ) ; color: red }\n';
    expect(rebaseDesignCssReferences(css, "", "page-1/home.html")).toBe(
      css.replace('"assets/a.png?q#h"', '"../assets/a.png?q#h"'),
    );
  });

  it("leaves URL-like text in strings and declaration comments untouched", () => {
    const css =
      '.a { content: "url(assets/a.png)"; background: /* url(assets/fake.png) */ url("assets/a(b).png") }';
    expect(rebaseDesignCssReferences(css, "", "page-1/home.html")).toBe(
      css.replace('url("assets/a(b).png")', 'url("../assets/a(b).png")'),
    );
  });
});

describe("frame transfer reference rebasing", () => {
  it("keeps normalized shared dependencies when no migration move plan is supplied", () => {
    const source =
      '<link href="../tokens.css"><a href="local.html">Local</a><style>.a { background:url(../assets/a.png) }</style><div style="background:url(../assets/a.png)"></div>';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "page-1/home.html",
        "checkout/home-copy.html",
        { strict: true },
      ),
    ).toBe(source.replace('href="local.html"', 'href="../page-1/local.html"'));
  });

  it("keeps query-only links targeting the original frame on same-page copies", () => {
    const source = '<a href="?theme=night#top">Theme</a>';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "page-1/home.html",
        "page-1/home-copy.html",
        { strict: true },
      ),
    ).toBe(source.replace('href="?', 'href="home.html?'));
  });
});

describe("migration reference rebasing", () => {
  const options = {
    movedFiles: {
      "home.html": "page-1/home.html",
      "details.html": "page-1/details.html",
    },
    strict: true,
  };

  it("maps moved targets, shared assets and imports while preserving authored bytes", () => {
    const source =
      '<!doctype html>\n<!-- href="home.html" -->\n<link href="tokens.css"><a href="details.html?q=1&amp;other=2#part">Details</a><img srcset="assets/a.png 1x, data:image/png;base64,AA 2x"><video poster="assets/a.png"></video><div style="background: url(assets/a.png)"></div><style>/* url(fake.png) */ @import "shared.css" screen; .a { content:"url(fake.png)"; background:url("assets/a(b).png") }</style><template><a href=details.html>Details</a></template>';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(
      source
        .replace('href="tokens.css"', 'href="../tokens.css"')
        .replace('srcset="assets/a.png', 'srcset="../assets/a.png')
        .replace('poster="assets/a.png"', 'poster="../assets/a.png"')
        .replace("url(assets/a.png)", "url(../assets/a.png)")
        .replace('@import "shared.css"', '@import "../shared.css"')
        .replace('url("assets/a(b).png")', 'url("../assets/a(b).png")'),
    );
  });

  it("updates stationary inbound HTML and CSS with the same helper", () => {
    const html =
      '<!-- home.html --><a href=home.html?q#part>Home</a><img srcset="details.html 1x, assets/a.png 2x">';
    expect(
      rebaseDesignHtmlReferences(html, "notes.html", "notes.html", options),
    ).toBe(
      html
        .replace("href=home.html", "href=page-1/home.html")
        .replace('srcset="details.html', 'srcset="page-1/details.html'),
    );
    const css =
      '/* home.html */ @import "../home.html" screen; @import url( "../details.html?q#h" ); .a { background:url("../home.html#icon"); content:"url(../home.html)" }';
    expect(
      rebaseDesignCssReferences(
        css,
        "styles/theme.css",
        "styles/theme.css",
        options,
      ),
    ).toBe(
      css
        .replace('@import "../home.html"', '@import "../page-1/home.html"')
        .replace('"../details.html?q#h"', '"../page-1/details.html?q#h"')
        .replace('url("../home.html#icon")', 'url("../page-1/home.html#icon")'),
    );
  });

  it("retains absolute, data, protocol-relative, mail and fragment URLs", () => {
    const source =
      '<a href="#section">A</a><a href="mailto:a@example.test">B</a><img src="//example.test/a.png"><img src="https://example.test/a.png"><img src="data:image/png;base64,AA">';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(source);
  });

  it("preserves encoded query suffixes and unrelated HTML entity spellings", () => {
    const source =
      '<a href="home.html?q=1&#38;other=2#top" title="&#65;">Home</a>';
    expect(
      rebaseDesignHtmlReferences(source, "notes.html", "notes.html", options),
    ).toBe(source.replace('href="home.html', 'href="page-1/home.html'));
  });

  it("retains a directory URL's trailing slash and suffix when its containing frame moves", () => {
    const source = '<a href="assets/?size=1&amp;other=2#top">Assets</a>';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(source.replace('href="assets/', 'href="../assets/'));
  });

  it("uses only registered own targets when a URL matches an object prototype name", () => {
    const source =
      '<a href="constructor">Docs</a><a href="__proto__">More docs</a>';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(
      source
        .replace('href="constructor"', 'href="../constructor"')
        .replace('href="__proto__"', 'href="../__proto__"'),
    );
  });

  it("rebases CSS inside a style element whose parser location reaches EOF", () => {
    const source = "<style>.a { background:url(assets/a.png) }";
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(source.replace("url(assets/a.png)", "url(../assets/a.png)"));
  });

  it("leaves stationary references outside the Design root byte-identical", () => {
    const css =
      "@font-face { src: url(../../apps/web/public/fonts/Inter.woff2) }";
    expect(
      rebaseDesignCssReferences(css, "tokens.css", "tokens.css", options),
    ).toBe(css);
    const html =
      '<a href="../README.md">Readme</a><a href="home.html">Home</a><img src="../outside/logo.png">';
    expect(
      rebaseDesignHtmlReferences(html, "notes.html", "notes.html", options),
    ).toBe(html.replace('href="home.html"', 'href="page-1/home.html"'));
  });

  it("preserves outside relative targets lexically when their containing frame moves", () => {
    const html =
      '<img src="../outside/logo.png?q=1#top"><a href="../../README.md">Readme</a>';
    expect(
      rebaseDesignHtmlReferences(
        html,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(
      html
        .replace('src="../outside/', 'src="../../outside/')
        .replace('href="../../README.md"', 'href="../../../README.md"'),
    );
    expect(
      resolveDesignLocalReference("../../outside/logo.png", "page-1/home.html"),
    ).toBeNull();
  });

  it.each([
    ["assets/Hero%20Image.png", "../assets/Hero%20Image.png"],
    ["assets/Hero Image.png", "../assets/Hero Image.png"],
    ["assets/r&amp;d.png", "../assets/r&amp;d.png"],
    ["ass&#101;ts/a.png", "../ass&#101;ts/a.png"],
    ["ass&#x65;ts/a.png", "../ass&#x65;ts/a.png"],
    ["assets/bad%escape.png", "../assets/bad%escape.png"],
    ["./tokens.css?v=1#x", "../tokens.css?v=1#x"],
    ["../outside/a%20b.png", "../../outside/a%20b.png"],
    ["assets/../assets/./a%20b.png", "../assets/../assets/./a%20b.png"],
    ["././assets/a.png", ".././assets/a.png"],
  ])("adjusts depth without changing %s", (url, expected) => {
    const source = `<img src="${url}" title="Keep &#65;">`;
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(source.replace(`src="${url}"`, `src="${expected}"`));
  });

  it("preserves encoded srcset candidates and their descriptors", () => {
    const source =
      '<img srcset="assets/Hero%20Image.png 1x, ass&#101;ts/a.png?x=1&amp;y=2#top 2x">';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(
      source
        .replace('srcset="assets/', 'srcset="../assets/')
        .replace(", ass&#101;", ", ../ass&#101;"),
    );
  });

  it.each([
    `<div style='background: url("assets/a%20b.png")'></div>`,
    '<style>.a { background: url("assets/a%20b.png") }</style>',
    '<div style="background: url(&quot;assets/a%20b.png&quot;)"></div>',
    '<div style="background: url(ass&#101;ts/a.png)"></div>',
  ])("preserves authored CSS URL spellings: %s", (source) => {
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(
      source
        .replace("assets/a%20b.png", "../assets/a%20b.png")
        .replace("ass&#101;ts/a.png", "../ass&#101;ts/a.png"),
    );
  });

  it.each([
    "details.html",
    "deta%69ls.html",
    "deta&#105;ls.html",
    "deta&#x69;ls.html",
  ])(
    "detects the moved target of %s before preserving other spellings",
    (url) => {
      const source = `<a href="${url}?x=1&amp;y=2#top">Details</a>`;
      expect(
        rebaseDesignHtmlReferences(
          source,
          "home.html",
          "page-1/home.html",
          options,
        ),
      ).toBe(source.replace(url, "details.html"));
    },
  );

  it("detects encoded stationary inbound targets without changing unrelated URLs", () => {
    const source =
      '<a href="h%6fme.html">Home</a><a href="deta&#105;ls.html">Details</a><img src="assets/Hero%20Image.png">';
    expect(
      rebaseDesignHtmlReferences(source, "notes.html", "notes.html", options),
    ).toBe(
      source
        .replace("h%6fme.html", "page-1/home.html")
        .replace("deta&#105;ls.html", "page-1/details.html"),
    );
    const css =
      '@import "h%6fme.html"; .a { background: url("assets/a%20b.png") }';
    expect(
      rebaseDesignCssReferences(css, "tokens.css", "tokens.css", options),
    ).toBe(css.replace("h%6fme.html", "page-1/home.html"));
  });

  it.each([
    "https&#58;//example.test/a.png",
    "&sol;outside.png",
    "&num;section",
  ])("keeps decoded absolute/scheme/fragment URLs unchanged: %s", (url) => {
    const source = `<a href="${url}">Link</a>`;
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(source);
  });

  it("rejects decoded case aliases of moved files", () => {
    expect(() =>
      rebaseDesignHtmlReferences(
        '<a href="H%4fME.html">Home</a>',
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toThrow(/safely|ambiguous/i);
  });

  it.each([
    '<img src="assets/%2e%2e/a.png">',
    '<img src="assets/%2E/a.png">',
    '<img src="assets/a%2fb.png">',
    '<img src="assets/a%5cb.png">',
    '<img src="assets/a%01b.png">',
    '<img src="..\\outside.png">',
    '<img src="assets/\u0001a.png">',
    "<style>.a { background:url(h\\6fme.html) }</style>",
    '<style>@import "h\\6fme.html";</style>',
    "<style>.a { background:url(var(--image)) }</style>",
  ])("retains excluded reference spellings in moved frames: %s", (source) => {
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(source);
  });

  it("rebases URL tokens when a moved frame has malformed style CSS", () => {
    const source =
      '<style>.a { background:url(assets/a.png); broken {</style><div style="background:url(../outside/logo.png); broken {"></div>';
    expect(
      rebaseDesignHtmlReferences(
        source,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(
      source
        .replace("url(assets/a.png)", "url(../assets/a.png)")
        .replace("url(../outside/logo.png)", "url(../../outside/logo.png)"),
    );
  });

  it("skips unrelated malformed stationary CSS before parsing", () => {
    const source = ".a { background:url(../../outside/logo.png); broken {";
    expect(
      rebaseDesignCssReferences(source, "tokens.css", "tokens.css", options),
    ).toBe(source);
  });

  it("keeps unrelated references in a malformed stationary stylesheet containing a frame name", () => {
    const source =
      "/* home.html */ .a { background:url(../../outside/logo.png); broken {";
    expect(
      rebaseDesignCssReferences(source, "tokens.css", "tokens.css", options),
    ).toBe(source);
  });

  it("does not treat unsupported-looking text in CSS comments or strings as a moved reference", () => {
    const source =
      '/* image-set("home.html" 1x) */ .a { content: \'image-set("home.html" 1x)\' }';
    expect(
      rebaseDesignCssReferences(source, "tokens.css", "tokens.css", options),
    ).toBe(source);
    const malformed = ".a { color:red } /* url(HOME.html)";
    expect(
      rebaseDesignCssReferences(
        malformed,
        "home.html",
        "page-1/home.html",
        options,
      ),
    ).toBe(malformed);
  });

  it.each([
    '<base href="./"><img src="assets/a.png">',
    '<a href="HOME.html">Home</a>',
    '<style>.a { background:image-set("home.html" 1x) }</style>',
  ])(
    "rejects references whose migration cannot be proved safe: %s",
    (source) => {
      expect(() =>
        rebaseDesignHtmlReferences(
          source,
          "home.html",
          "page-1/home.html",
          options,
        ),
      ).toThrow(/safely|unsupported|ambiguous|escape/i);
    },
  );
});
