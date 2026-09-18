import { chromium } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  initializeDesignDocument,
  readDesignFrame,
  DESIGN_DIRECTORY_NAME,
} from "../document";

it("previews native HTML and CSS with normal flex and inline semantics, then refreshes native edits", async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), "zeros-native-design-browser-"),
  );
  const browser = await chromium.launch({ headless: true });
  try {
    await initializeDesignDocument(root);
    const folder = path.join(root, DESIGN_DIRECTORY_NAME);
    const html =
      '<!doctype html><html><head><link rel="stylesheet" href="tokens.css"><style>main { display:flex; gap:20px; } p { margin:0; }</style></head><body><main><p>First <span>inline</span> text</p><p>Second</p></main></body></html>';
    await writeFile(path.join(folder, "home.html"), html);
    await writeFile(
      path.join(folder, "canvas.json"),
      JSON.stringify({
        version: 1,
        frames: {
          home: {
            kind: "html",
            source: "home.html",
            title: "Home",
            x: 0,
            y: 0,
            width: 800,
            height: 600,
          },
        },
      }),
    );
    const frame = await readDesignFrame(root, "home.html");
    const page = await browser.newPage();
    await page.setContent(frame.srcDoc);
    const layout = await page.evaluate(() => ({
      direction: getComputedStyle(document.querySelector("main")!)
        .flexDirection,
      inline: getComputedStyle(document.querySelector("span")!).display,
      positions: Array.from(document.querySelectorAll("p"), (el) => ({
        x: el.getBoundingClientRect().x,
        y: el.getBoundingClientRect().y,
      })),
    }));
    expect(layout.direction).toBe("row");
    expect(layout.inline).toBe("inline");
    expect(layout.positions[1].x).toBeGreaterThan(layout.positions[0].x);
    expect(layout.positions[1].y).toBe(layout.positions[0].y);
    expect(await readFile(path.join(folder, "home.html"), "utf8")).toBe(html);
    await writeFile(
      path.join(folder, "home.html"),
      html.replace("Second", "Updated"),
    );
    const next = await readDesignFrame(root, "home.html");
    expect(next.sourceVersion).not.toBe(frame.sourceVersion);
    await page.setContent(next.srcDoc);
    expect(await page.locator("p").nth(1).textContent()).toBe("Updated");
    const customTokens =
      "/* authored legacy styling */\nbody [data-oid] { display: block; }";
    await writeFile(path.join(folder, "tokens.css"), customTokens);
    await initializeDesignDocument(root);
    expect(await readFile(path.join(folder, "tokens.css"), "utf8")).toBe(
      customTokens,
    );
  } finally {
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
