import { chromium, type Browser, type Page } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DesignApi } from "@zeros/design-web";
import { createDesignCaptureRenderer } from "../capture-client";
import { DesignDraftStore, designDocumentIdForFrame } from "../design-api";
import { createDesignFrame, initializeDesignDocument, readDesignFrameRenderSourceFromSource, readDesignWebDocumentState } from "../document";
import { designDirectoryNameFor, forgetDesignDirectoryName } from "../directory-registry";
import { withDesignTheme } from "../source";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });

function readInk(page: Page) {
  return page.locator("main").evaluate(element =>
    getComputedStyle(element).color.match(/\d+/g)?.map(Number),
  );
}

async function fixture(css: string, base: string | null, mapping: Record<string, string>) {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-theme-render-"));
  await initializeDesignDocument(root);
  const frame = await createDesignFrame(root, { title: "Theme" });
  const directory = designDirectoryNameFor(root);
  const html = "<!doctype html><html><head></head><body><main>Theme</main></body></html>";
  await writeFile(path.join(root, directory, frame.file), html);
  await writeFile(path.join(root, "app.css"), css);
  const file = path.join(root, directory, "meta/canvas.json");
  const canvas = JSON.parse(await readFile(file, "utf8"));
  canvas.themes = ["light", "dark"].map(id => ({ id, label: id, ...(id === base ? { base: true } : {}) }));
  canvas.styles = [{ id: "app", kind: "css", path: "app.css", themes: mapping }];
  await writeFile(file, JSON.stringify(canvas));
  return { root, frame: frame.file, html, async close() {
    forgetDesignDirectoryName(root);
    await rm(root, { recursive: true, force: true });
  } };
}

it.each([":root", "html", ":is(:root)", "main"])(
  "preserves a nested color-scheme override on %s",
  async selector => {
    const css = `${selector} { --ink: white; @media (prefers-color-scheme: dark) { --ink: black; } } main { color: var(--ink); }`;
    const value = await fixture(css, null, { dark: "@media (prefers-color-scheme: dark)" });
    const page = await browser.newPage({ colorScheme: "dark" });
    try {
      await page.setContent(`<style>${css}</style><main>Original</main>`);
      expect(await readInk(page)).toEqual([0, 0, 0]);
      const rendered = await readDesignFrameRenderSourceFromSource(value.root, value.frame, value.html);
      // Choosing a theme must work independently of the host's color scheme.
      await page.emulateMedia({ colorScheme: "light" });
      await page.setContent(withDesignTheme(rendered.html, "dark"));
      expect(await readInk(page)).toEqual([0, 0, 0]);
      await page.setContent(withDesignTheme(rendered.html, "light"));
      expect(await readInk(page)).toEqual([255, 255, 255]);
    } finally {
      await page.close();
      await value.close();
    }
  },
);

it.each(["dark", null])("API capture uses the declared default %s and preserves explicit composed themes", async base => {
  const value = await fixture("main { color: white; } .dark main { color: black; }", base, { dark: ".dark" });
  const page = await browser.newPage({ viewport: { width: 16, height: 16 } });
  try {
    const renderer = createDesignCaptureRenderer(value.root, { url: "http://127.0.0.1:1", token: "a".repeat(64) }, (async (_url, request) => {
      const input = JSON.parse(request!.body as string);
      await page.setContent(input.html);
      const bytes = await page.screenshot();
      return new Response(JSON.stringify({ version: 1, revision: input.revision, width: 16, height: 16, data: bytes.toString("base64"), renderer: "fixture-chromium" }));
    }) as typeof fetch)!;
    const state = await readDesignWebDocumentState(value.root, value.frame);
    const api = new DesignApi(new DesignDraftStore(value.root), { authorization: { kind: "trusted-in-process" }, renderer });
    const viewport = { width: 16, height: 16, deviceScaleFactor: 1, colorScheme: "light" as const, reducedMotion: "reduce" as const };
    const artifact = await api.render({ documentId: designDocumentIdForFrame(value.frame), expectedRevision: state.revision, viewport });
    expect(artifact.revision).toBe(state.revision);
    expect(await readInk(page)).toEqual(base === "dark" ? [0, 0, 0] : [255, 255, 255]);
    const composed = await readDesignFrameRenderSourceFromSource(value.root, value.frame, value.html);
    await renderer.renderComposed!({ state, viewport, html: withDesignTheme(composed.html, "light"), sourceVersion: composed.sourceVersion });
    expect(await readInk(page)).toEqual([255, 255, 255]);
  } finally {
    await page.close();
    await value.close();
  }
});
