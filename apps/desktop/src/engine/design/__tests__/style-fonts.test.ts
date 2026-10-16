import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureDesignFonts,
  fontVariablesCss,
  googleFontsCss,
  googleFontsCssUrl,
  isGoogleFontsCssUrl,
  readDesignFontCatalog,
  resetDesignFontsForTests,
  retryDesignFonts,
  settleDesignFontDownloadsForTests,
} from "../style-fonts";

const GOOGLE_CSS = [
  "/* cyrillic */",
  "@font-face { font-family: 'Acme'; src: url(https://fonts.gstatic.com/s/inter/v1/cyrillic.woff2) format('woff2'); unicode-range: U+0400-045F; }",
  "/* latin */",
  "@font-face { font-family: 'Acme'; src: url(https://fonts.gstatic.com/s/inter/v1/latin.woff2) format('woff2'); unicode-range: U+0000-00FF; }",
].join("\n");

const roots: string[] = [];
let cache = "";
let calls: string[] = [];

function googleFetch(css = GOOGLE_CSS): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://fonts.googleapis.com/")) return new Response(css);
    if (url.startsWith("https://fonts.gstatic.com/")) return new Response(Buffer.from(`font:${url.split("/").pop()}`));
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  cache = mkdtempSync(path.join(tmpdir(), "zeros-design-fonts-"));
  roots.push(cache);
  calls = [];
  configureDesignFonts({ fetch: googleFetch(), cacheDirectory: () => cache });
});
afterEach(async () => {
  await settleDesignFontDownloadsForTests();
  resetDesignFontsForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("declared fonts", () => {
  it("keeps valid Google and local fonts and explains the rest", () => {
    const catalog = readDesignFontCatalog({
      fonts: [
        { family: "Geist", provider: "google", variable: "--font-geist-sans", weights: "100..900", subsets: ["latin", "BAD"] },
        { family: "Brand", provider: "local", path: "public/fonts/Brand.woff2", weight: "700", style: "italic", fallback: "system-ui, sans-serif" },
        { family: "Escape", provider: "local", path: "../outside.woff2" },
        { family: "Script", provider: "local", path: "fonts/brand.js" },
        { family: "x</style>", provider: "google" },
        { family: "Inter" },
      ],
    });
    expect(catalog.fonts).toEqual([
      { family: "Geist", provider: "google", variable: "--font-geist-sans", weights: "100..900", subsets: ["latin"] },
      { family: "Brand", provider: "local", path: "public/fonts/Brand.woff2", weight: "700", style: "italic", fallback: "system-ui, sans-serif" },
    ]);
    expect(catalog.errors).toEqual([
      'Font "Escape": a local font names a .woff2, .woff, .ttf or .otf file inside the repository.',
      'Font "Script": a local font names a .woff2, .woff, .ttf or .otf file inside the repository.',
      'Font 5 needs a family (letters, digits, spaces, _ or -) and a provider, "google" or "local".',
      'Font 6 needs a family (letters, digits, spaces, _ or -) and a provider, "google" or "local".',
    ]);
    expect(readDesignFontCatalog({ fonts: "Inter" }).errors).toEqual(["meta/canvas.json `fonts` must be a list."]);
    expect(readDesignFontCatalog({})).toEqual({ fonts: [], errors: [] });
  });

  it("asks Google for the declared axes and sets next/font's variables", () => {
    expect(googleFontsCssUrl({ family: "Geist Mono", provider: "google", weights: "100..900" }))
      .toBe("https://fonts.googleapis.com/css2?family=Geist+Mono:wght@100..900&display=swap");
    expect(googleFontsCssUrl({ family: "Inter", provider: "google", weights: "400;700", italic: true }))
      .toBe("https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;1,400;0,700;1,700&display=swap");
    expect(fontVariablesCss([
      { family: "Geist", provider: "google", variable: "--font-geist-sans" },
      { family: "Brand", provider: "local", path: "a.woff2", fallback: "serif" },
      { family: "Mono", provider: "google", variable: "--font-mono", fallback: "monospace" },
    ])).toBe(':root { --font-geist-sans: "Geist", sans-serif; --font-mono: "Mono", monospace; }');
  });

  it("recognises only Google's stylesheet API as a font import", () => {
    expect(isGoogleFontsCssUrl("https://fonts.googleapis.com/css2?family=Inter")).toBe(true);
    expect(isGoogleFontsCssUrl("//fonts.googleapis.com/css?family=Roboto")).toBe(true);
    expect(isGoogleFontsCssUrl("https://fonts.googleapis.com.evil.example/css2?family=Inter")).toBe(false);
    expect(isGoogleFontsCssUrl("https://fonts.googleapis.com/icon?family=Material+Icons")).toBe(false);
    expect(isGoogleFontsCssUrl("https://cdn.example/fonts.css")).toBe(false);
  });
});

describe("downloading Google Fonts", () => {
  const url = "https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap";

  it("downloads once in the background, embeds the files and refreshes the waiting canvases", async () => {
    const ready: string[][] = [];
    configureDesignFonts({ onReady: (waiting) => ready.push([...waiting]) });
    expect(await googleFontsCss(url, "/repo/a", ["latin"])).toEqual({ state: "pending" });
    expect(await googleFontsCss(url, "/repo/b", ["latin"])).toEqual({ state: "pending" });
    await settleDesignFontDownloadsForTests();
    expect(ready).toEqual([["/repo/a", "/repo/b"]]);
    const state = await googleFontsCss(url, "/repo/a", ["latin"]);
    expect(state.state).toBe("ready");
    if (state.state !== "ready") return;
    // Only the requested subset, inlined, without Google's subset comments.
    expect(state.css).toContain(`url("data:font/woff2;base64,${Buffer.from("font:latin.woff2").toString("base64")}")`);
    expect(state.css).not.toContain("cyrillic");
    expect(state.css).not.toContain("gstatic");
    expect(calls).toEqual([url, "https://fonts.gstatic.com/s/inter/v1/latin.woff2"]);
    // The CSS stays on disk; a later engine reads it without the network.
    expect(readdirSync(cache)).toHaveLength(1);
    resetDesignFontsForTests();
    configureDesignFonts({ fetch: googleFetch(), cacheDirectory: () => cache });
    calls = [];
    expect((await googleFontsCss(url, "/repo/a", ["latin"])).state).toBe("ready");
    expect(calls).toEqual([]);
  });

  it("keeps a stylesheet filtered to other subsets apart", async () => {
    await googleFontsCss(url, "/repo/a", ["latin"]);
    await googleFontsCss(url, "/repo/a");
    await settleDesignFontDownloadsForTests();
    const latin = await googleFontsCss(url, "/repo/a", ["latin"]);
    const every = await googleFontsCss(url, "/repo/a");
    expect(latin.state === "ready" && latin.css.includes("cyrillic.woff2")).toBe(false);
    expect(every.state === "ready" && every.css).toContain(Buffer.from("font:cyrillic.woff2").toString("base64"));
    expect(readdirSync(cache)).toHaveLength(2);
  });

  it("downloads again when the cache was cleared", async () => {
    await googleFontsCss(url, "/repo/a");
    await settleDesignFontDownloadsForTests();
    rmSync(cache, { recursive: true, force: true });
    expect(await googleFontsCss(url, "/repo/a")).toEqual({ state: "pending" });
    await settleDesignFontDownloadsForTests();
    expect((await googleFontsCss(url, "/repo/a")).state).toBe("ready");
    expect(existsSync(cache)).toBe(true);
  });

  it("fetches font files from Google's font host only", async () => {
    configureDesignFonts({ fetch: googleFetch("@font-face { font-family: 'X'; src: url(https://attacker.example/x.woff2); }") });
    await googleFontsCss(url, "/repo/a");
    await settleDesignFontDownloadsForTests();
    expect(await googleFontsCss(url, "/repo/a")).toEqual({ state: "failed", error: "attacker.example is not a Google Fonts host." });
    expect(calls).toEqual([url]);
  });

  it("remembers a failure until Update retries it", async () => {
    configureDesignFonts({ fetch: (async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch });
    await googleFontsCss(url, "/repo/a");
    await settleDesignFontDownloadsForTests();
    expect(await googleFontsCss(url, "/repo/a")).toEqual({ state: "failed", error: "Google Fonts answered 503." });
    configureDesignFonts({ fetch: googleFetch() });
    expect((await googleFontsCss(url, "/repo/a")).state).toBe("failed");
    retryDesignFonts();
    expect(await googleFontsCss(url, "/repo/a")).toEqual({ state: "pending" });
    await settleDesignFontDownloadsForTests();
    expect((await googleFontsCss(url, "/repo/a")).state).toBe("ready");
  });

  it("words network failures for the theme editor", async () => {
    configureDesignFonts({ fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    await googleFontsCss(url, "/repo/a");
    await settleDesignFontDownloadsForTests();
    expect(await googleFontsCss(url, "/repo/a")).toEqual({ state: "failed", error: "Could not reach Google Fonts." });
    retryDesignFonts();
    configureDesignFonts({ fetch: (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as unknown as typeof fetch });
    await googleFontsCss(url, "/repo/a");
    await settleDesignFontDownloadsForTests();
    expect(await googleFontsCss(url, "/repo/a")).toEqual({ state: "failed", error: "Google Fonts did not answer within 20 seconds." });
  });

  it("refuses an oversized font file", async () => {
    configureDesignFonts({
      fetch: (async (input: string | URL | Request) => String(input).includes("gstatic")
        ? new Response(Buffer.alloc(4 * 1024 * 1024 + 1))
        : new Response(GOOGLE_CSS)) as typeof fetch,
    });
    await googleFontsCss(url, "/repo/a", ["latin"]);
    await settleDesignFontDownloadsForTests();
    expect(await googleFontsCss(url, "/repo/a", ["latin"])).toEqual({ state: "failed", error: "A Google Fonts response was too large." });
  });

  it("never writes a cache file outside its directory", async () => {
    writeFileSync(path.join(cache, "unrelated.txt"), "kept");
    await googleFontsCss(url, "/repo/a");
    await settleDesignFontDownloadsForTests();
    expect(readdirSync(cache).sort()).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.css$/), "unrelated.txt"]);
  });
});
