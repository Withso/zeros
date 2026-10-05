import { chromium } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import {
  initializeDesignDocument,
  readDesignFrame,
  DESIGN_DIRECTORY_NAME,
} from "../document";
import { primeDesignDirectoryName, forgetDesignDirectoryName } from "../directory-registry";
import { pagesCanvas, pagesDirectory, pagesManifest } from "./pages-fixtures";

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

it("renders independent page frames with shared, local and component resources in a browser", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-native-pages-browser-"));
  const browser = await chromium.launch({ headless: true });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==", "base64");
  const write = async (file: string, source: string | Buffer) => {
    const target = path.join(root, pagesDirectory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, source);
  };
  try {
    await write("meta/design.toml", pagesManifest);
    await write("meta/canvas.json", JSON.stringify(pagesCanvas));
    await write("tokens.css", '.shared { color: rgb(255, 0, 0); background-image: url("./assets/shared.png"); }');
    await write("page-1/styles.css", ".local { padding: 12px; }");
    await write("assets/shared.png", image);
    await write("page-1/local.png", image);
    await write("components/card.html", '<!doctype html><html><head></head><body><article><img src="./assets/shared.png"><slot></slot></article></body></html>');
    await write("page-1/home.html", '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><link rel="stylesheet" href="./styles.css"></head><body><main data-oid="home" class="shared local">Screens<zd-card data-oid="card"><img data-oid="local" src="./local.png"></zd-card></main></body></html>');
    await write("checkout/home.html", '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="checkout" class="shared">Checkout</main></body></html>');
    primeDesignDirectoryName(root, pagesDirectory);
    const page = await browser.newPage();
    for (const [file, text, padding] of [["page-1/home.html", "Screens", "12px"], ["checkout/home.html", "Checkout", "0px"]]) {
      const frame = await readDesignFrame(root, file);
      await page.setContent(frame.srcDoc);
      await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth === 1));
      expect(await page.locator("main").textContent()).toBe(text);
      expect(await page.locator("main").evaluate((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, padding: style.padding, background: style.backgroundImage };
      })).toMatchObject({ color: "rgb(255, 0, 0)", padding, background: expect.stringContaining("data:image/png;base64,") });
    }
  } finally {
    forgetDesignDirectoryName(root);
    await browser.close();
    await rm(root, { recursive: true, force: true });
  }
});
