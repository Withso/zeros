import { chromium } from "@playwright/test";
import { afterAll, describe, expect, it } from "vitest";

import { DesignApi } from "../api";
import {
  PlaywrightDesignRenderer,
  type PlaywrightBrowserTypeLike,
} from "../playwright";
import { InMemoryDesignDocumentRepository } from "../api";

const HTML = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body><main data-oid="root"><article data-oid="card">Responsive</article></main></body>
</html>`;

const CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; max-width: 100%; overflow-x: hidden; }
main { min-height: 100vh; width: 100%; padding: 48px; background: #fff; }
article { width: 100%; min-height: 120px; padding: 24px; background: #2563eb; color: white; }
@media (max-width: 600px) { main { padding: 12px; } }
`;

describe("Playwright headless design renderer", () => {
  const renderer = new PlaywrightDesignRenderer({
    browserType: chromium as unknown as PlaywrightBrowserTypeLike,
  });

  afterAll(async () => {
    await renderer.close();
  });

  it("rasterizes the same authored document at desktop and mobile viewports", async () => {
    const repository = new InMemoryDesignDocumentRepository([
      {
        documentId: "responsive-document",
        entryFile: "index.html",
        files: { "index.html": HTML, "styles.css": CSS },
        frames: {
          "index.html": { x: 0, y: 0, width: 1_440, height: 900, z: 0 },
        },
      },
    ]);
    const api = new DesignApi(repository, {
      authorization: { kind: "trusted-in-process" },
      renderer,
    });
    const opened = await api.open("responsive-document");
    const [desktop, mobile] = await Promise.all([
      api.render({
        documentId: "responsive-document",
        expectedRevision: opened.revision,
        viewport: { width: 1_440, height: 900 },
      }),
      api.render({
        documentId: "responsive-document",
        expectedRevision: opened.revision,
        viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
      }),
    ]);

    expect([...desktop.bytes.slice(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);
    expect(mobile).toMatchObject({
      mimeType: "image/png",
      width: 390,
      height: 844,
      revision: opened.revision,
      metadata: {
        viewportProfile: "mobile",
        deviceScaleFactor: 2,
      },
    });
    expect(Number(mobile.metadata?.contentWidth)).toBeLessThanOrEqual(390);
    expect(mobile.bytes.byteLength).toBeGreaterThan(1_000);
  });
});
