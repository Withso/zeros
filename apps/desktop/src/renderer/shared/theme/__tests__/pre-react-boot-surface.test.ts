import { readFileSync } from "node:fs";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  dismissStartupLoader,
  isStartupLoaderMounted,
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
const halftoneLayers = (markup: string) =>
  Array.from(
    markup.matchAll(
      /class=(?:"|')(zeros-boot-halftone-layer zeros-boot-halftone--[^"']+)(?:"|')/g,
    ),
    ([, className]) => className,
  );
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
  it("paints a halftone real Zeros silhouette before the renderer executes", () => {
    expect(rootOffset).toBeGreaterThan(-1);
    expect(moduleEntryOffset).toBeGreaterThan(rootOffset);
    expect(bootOffset).toBeGreaterThan(-1);
    expect(bootOffset).toBeLessThan(rootOffset);
    expect(bootMarkup).toContain('role="status"');
    expect(bootMarkup).toContain('aria-live="polite"');
    expect(bootMarkup).toContain('aria-label="Loading Zeros"');
    expect(html).toContain('href="/apps/desktop/src/assets/zeros-logo.png"');
    expect(bootMarkup).toContain('class="zeros-boot-logo"');
    expect(bootMarkup).toContain('class="zeros-boot-halftone"');
    expect(bootMarkup).toContain('aria-hidden="true"');
    expect(bootMarkup).not.toContain("<img");
    expect(bootMarkup).not.toContain("zeros-boot-ascii");
    expect(halftoneLayers(bootMarkup)).toHaveLength(5);
    expect(visibleText(bootMarkup)).toBe("");
    expect(beforeRenderer).not.toContain("Starting Zeros");
    expect(beforeRenderer).toContain('<div id="root"></div>');
  });

  it("carries dependency-free critical styles for every boot theme", () => {
    expect(bootStyles).not.toBe("");
    expect(bootStyles).toContain("#zeros-boot");
    expect(bootStyles).toContain('[data-theme="light"]');
    expect(bootStyles).toContain('[data-theme-palette="orka-black"]');
    expect(bootStyles).toContain("--zeros-boot-ink-strong");
    expect(bootStyles).toContain("--zeros-boot-ink-mid");
    expect(bootStyles).toContain("--zeros-boot-ink-soft");
    expect(bootStyles).toContain(
      'url("/apps/desktop/src/assets/zeros-logo.png")',
    );
    expect(bootStyles).toContain("radial-gradient(");
    expect(bootStyles).toContain("conic-gradient(");
    expect(bootStyles).toContain("repeating-linear-gradient(");
    expect(bootStyles).toContain("@keyframes zeros-boot-halftone-drift");
    expect(bootStyles).toContain("translate3d(-0.45px, 0.15px, 0)");
    expect(bootStyles).not.toContain("zeros-boot-ascii");
    expect(bootStyles).not.toContain("scale(");
    expect(bootStyles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(bootStyles).toMatch(/\.zeros-boot-logo\s*\{[^}]*width:\s*80px;/s);
    expect(bootStyles).toMatch(/\.zeros-boot-logo\s*\{[^}]*height:\s*80px;/s);
    expect(bootStyles).toMatch(
      /prefers-reduced-motion:[^)]+\)[\s\S]*?\.zeros-boot-halftone-layer\s*\{[^}]*animation:\s*none;/,
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

  it("renders the React-only recovery fallback with the same halftone mark", () => {
    const markup = renderToStaticMarkup(createElement(StartupLogoLoader));

    expect(markup).toContain('id="zeros-boot"');
    expect(markup).toContain('class="zeros-boot-logo"');
    expect(markup).toContain('class="zeros-boot-halftone"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('aria-label="Loading Zeros"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("zeros-boot-ascii");
    expect(markup).not.toContain("Starting Zeros");
    expect(visibleText(markup)).toBe("");
    expect(halftoneLayers(markup)).toEqual(halftoneLayers(bootMarkup));
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
