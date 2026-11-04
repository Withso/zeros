import { readFileSync } from "node:fs";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  dismissStartupLoader,
  isStartupLoaderMounted,
  STARTUP_LOGO_WEAVE_ROWS,
  StartupLogoLoader,
} from "../../ui/startup-loader";

const html = readFileSync("index.html", "utf8");
const moduleEntry =
  '<script type="module" src="/apps/desktop/src/renderer/main.tsx"></script>';
const moduleEntryOffset = html.indexOf(moduleEntry);
const rootOffset = html.indexOf('<div id="root"');
const bootOffset = html.indexOf('id="zeros-boot"');
const beforeRenderer = html.slice(html.indexOf("<body>"), moduleEntryOffset);
const bootMarkup =
  beforeRenderer.match(/<div\s+id="zeros-boot"[\s\S]*?<\/div>/)?.[0] ?? "";
const bootStyles =
  html.match(/<style id="zeros-boot-styles">([\s\S]*?)<\/style>/)?.[1] ?? "";
/** The text a user would actually read, via a real HTML parse. Stripping tags
 *  with `replace(/<[^>]+>/g, "")` is an incomplete sanitizer (CodeQL
 *  js/incomplete-multi-character-sanitization) and genuinely wrong here: an
 *  unterminated `<script src=x` or a `>` inside an attribute value survives
 *  the pass and reappears as "text". Parsing has neither blind spot. */
const visibleText = (markup: string) => {
  const text: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    // `in`, not `nodeName === "#text"`: parse5 types Element.nodeName as a
    // plain string, so the literal never narrows. Only TextNode has `value`
    // (a comment carries `data`), which is the check document.ts already uses.
    if ("value" in node) text.push(node.value);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  parseFragment(markup).childNodes.forEach(visit);
  return text.join("").trim();
};
/** The Island Z's mask rows, as `class|path` pairs in document order. */
const weaveRows = (markup: string) =>
  Array.from(
    markup.matchAll(/<path\b[^>]*\bclass="(zeros-boot-row-[^"]+)"[^>]*\bd="([^"]+)"/g),
    ([, className, d]) => `${className}|${d}`,
  );
const tokenValue = (theme: "dark" | "light", name: string) => {
  const css = readFileSync("styles/zeros-tokens.css", "utf8");
  const start = theme === "dark" ? css.indexOf(":root {") : css.indexOf('\n[data-theme="light"] {');
  const block = css.slice(start);
  return block.match(new RegExp(`--${name}:\\s*hsl\\([^)]*\\);\\s*/\\*\\s*(#[0-9A-Fa-f]{6})`))?.[1]?.toLowerCase();
};
const authGate = readFileSync(
  "apps/desktop/src/renderer/features/auth/auth-gate.tsx",
  "utf8",
);
const authContext = readFileSync(
  "apps/desktop/src/renderer/features/auth/auth-context.tsx",
  "utf8",
);
const rendererEntry = readFileSync(
  "apps/desktop/src/renderer/main.tsx",
  "utf8",
);
const errorBoundary = readFileSync(
  "apps/desktop/src/renderer/shared/ui/error-boundary.tsx",
  "utf8",
);

describe("pre-React boot surface", () => {
  it("paints the Island Z before the renderer executes", () => {
    expect(rootOffset).toBeGreaterThan(-1);
    expect(moduleEntryOffset).toBeGreaterThan(rootOffset);
    expect(bootOffset).toBeGreaterThan(-1);
    expect(bootOffset).toBeLessThan(rootOffset);
    expect(bootMarkup).toContain('role="status"');
    expect(bootMarkup).toContain('aria-live="polite"');
    expect(bootMarkup).toContain('aria-label="Loading Zeros"');
    expect(bootMarkup).toMatch(/<svg class="zeros-boot-mark" viewBox="0 0 4 4" aria-hidden="true">/);
    expect(bootMarkup).toContain('mask="url(#zeros-boot-weave)" fill="url(#zeros-boot-fade)"');
    expect(weaveRows(bootMarkup)).toEqual(STARTUP_LOGO_WEAVE_ROWS.map((row) => `${row.className}|${row.d}`));
    // The old four-blob PNG mask and its halftone layers are gone.
    expect(html).not.toContain("zeros-logo.png");
    expect(bootMarkup).not.toContain("halftone");
    expect(bootMarkup).not.toContain("<img");
    expect(visibleText(bootMarkup)).toBe("");
    expect(beforeRenderer).not.toContain("Starting Zeros");
    expect(beforeRenderer).toContain('<div id="root"></div>');
  });

  it("colours the boot from token names whose fallbacks equal bg1, fg1 and fg3", () => {
    expect(bootStyles).not.toBe("");
    expect(bootStyles).toContain("#zeros-boot");
    expect(bootStyles).not.toContain("data-theme-palette");
    const dark = bootStyles.slice(bootStyles.indexOf(":root {"), bootStyles.indexOf(":root[data-theme=\"light\"]"));
    const light = bootStyles.slice(bootStyles.indexOf(":root[data-theme=\"light\"]"));
    for (const [block, theme] of [[dark, "dark"], [light, "light"]] as const) {
      expect(block).toContain(`--zeros-boot-bg: var(--bg1, ${tokenValue(theme, "bg1")})`);
      expect(block).toContain(`--zeros-boot-top: var(--fg1, ${tokenValue(theme, "fg1")})`);
      expect(block).toContain(`--zeros-boot-bottom: var(--fg3, ${tokenValue(theme, "fg3")})`);
    }
  });

  it("runs the Weave on a 72 ms beat in one 1.8 s loop and rests under reduced motion", () => {
    expect(bootStyles).toMatch(/\.zeros-boot-mark\s*\{[^}]*width:\s*64px;[^}]*height:\s*64px;/s);
    expect(bootStyles).toMatch(/\.zeros-boot-row-r\s*\{\s*animation:\s*zeros-boot-weave-r 1\.8s infinite;/);
    expect(bootStyles).toMatch(/\.zeros-boot-row-l\s*\{\s*animation:\s*zeros-boot-weave-l 1\.8s infinite;/);
    for (const [beat, delay] of [[1, "72ms"], [2, "144ms"], [3, "216ms"]] as const)
      expect(bootStyles).toMatch(new RegExp(`\\.zeros-boot-beat-${beat}\\s*\\{\\s*animation-delay:\\s*${delay};`));
    expect(bootStyles).toContain("@keyframes zeros-boot-weave-r");
    expect(bootStyles).toContain("@keyframes zeros-boot-weave-l");
    expect(bootStyles).toMatch(/100% \{ transform: translateX\(4px\); \}/);
    expect(bootStyles).toMatch(/100% \{ transform: translateX\(-4px\); \}/);
    expect(bootStyles).toMatch(
      /prefers-reduced-motion:[^)]+\)[\s\S]*?\.zeros-boot-row-r,\s*\.zeros-boot-row-l\s*\{[^}]*animation:\s*none;/,
    );
  });

  it("keeps one startup surface through auth instead of swapping to a spinner", () => {
    expect(authGate).not.toContain("ZerosSpinner");
    expect(authGate).toContain("isStartupLoaderMounted");
    expect(authGate).toContain("useDismissStartupLoader");
    expect(authGate).toMatch(
      /isStartupLoaderMounted\(\)\s*\?\s*null\s*:\s*<StartupLogoLoader\s*\/>/,
    );
    expect(authContext).toContain("useDismissStartupLoader");
    expect(rendererEntry).toContain("dismissStartupLoader");
    expect(errorBoundary).toContain("dismissStartupLoader");
  });

  it("renders the React-only recovery fallback with the same Island Z", () => {
    const markup = renderToStaticMarkup(createElement(StartupLogoLoader));

    expect(markup).toContain('id="zeros-boot"');
    expect(markup).toContain('class="zeros-boot-mark"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('aria-label="Loading Zeros"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("Starting Zeros");
    expect(visibleText(markup)).toBe("");
    expect(weaveRows(markup)).toEqual(weaveRows(bootMarkup));
  });

  it("dismisses only the exact startup-loader node", () => {
    let loader: { remove(): void } | null = {
      remove() {
        loader = null;
      },
    };
    const loaderDocument = {
      getElementById(id: string) {
        return id === "zeros-boot" ? loader : null;
      },
    } as Parameters<typeof isStartupLoaderMounted>[0];

    expect(isStartupLoaderMounted(loaderDocument)).toBe(true);
    dismissStartupLoader(loaderDocument);
    expect(isStartupLoaderMounted(loaderDocument)).toBe(false);
  });
});
