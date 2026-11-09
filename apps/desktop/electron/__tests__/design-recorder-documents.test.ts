import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { designRecorderDocument } from "../design-recorder-document";
import { createDesignRecorderDocuments } from "../design-recorder-documents";

const composed = (n: number) => `<!doctype html><html><head><link rel="stylesheet" href="zeros-sheet://css/abc"></head>` +
  `<body><main class="card"><h1>Frame ${n}</h1></main></body></html>`;
const active = `<!doctype html><html><head></head><body><script>alert(1)</script><h1 onclick="steal()">x</h1></body></html>`;

/** Vitest's Node can't run a TypeScript worker, so the test bundles it. */
let bundle: { directory: string; url: URL };
beforeAll(async () => {
  // Inside the checkout, so the bundle's external packages resolve from its node_modules.
  const cache = path.resolve(__dirname, "../../../../node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, "zeros-recorder-documents-"));
  const outfile = path.join(directory, "design-recorder-document-worker.mjs");
  await build({
    entryPoints: [path.join(__dirname, "../design-recorder-document-worker.ts")],
    bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "error",
    banner: { js: 'import { createRequire as __workerRequire } from "node:module"; const require = __workerRequire(import.meta.url);' },
  });
  bundle = { directory, url: pathToFileURL(outfile) };
}, 120_000);
afterAll(async () => { await rm(bundle.directory, { recursive: true, force: true }); });

describe("recorder documents on a worker thread", () => {
  it("prepares each frame's document exactly as the main thread does, many at once", async () => {
    const documents = createDesignRecorderDocuments({ workerFile: bundle.url });
    try {
      const inputs = Array.from({ length: 24 }, (_, n) => composed(n));
      const prepared = await Promise.all(inputs.map((html, n) => documents.prepare(html, n % 2 ? "dark" : "light")));
      const expected = await Promise.all(inputs.map((html, n) => designRecorderDocument(html, n % 2 ? "dark" : "light")));
      expect(prepared).toEqual(expected);
      // Active content is still removed off the main thread.
      const sanitized = await documents.prepare(active, "light");
      expect(sanitized).toBe(await designRecorderDocument(active, "light"));
      expect(sanitized).not.toContain("<script>alert");
    } finally {
      documents.stop();
    }
  }, 30_000);

  it("prepares on the main thread when the worker can't start or stops", async () => {
    const missing = createDesignRecorderDocuments({ workerFile: pathToFileURL(path.join(bundle.directory, "missing.mjs")) });
    expect(await missing.prepare(composed(1), "light")).toBe(await designRecorderDocument(composed(1), "light"));
    missing.stop();

    // A worker that exits as soon as it starts: what it held is prepared here.
    const exiting = path.join(bundle.directory, "exiting.mjs");
    await writeFile(exiting, "process.exit(0);\n");
    const stopping = createDesignRecorderDocuments({ workerFile: pathToFileURL(exiting) });
    const held = await Promise.all([1, 2, 3].map((n) => stopping.prepare(composed(n), "dark")));
    expect(held).toEqual(await Promise.all([1, 2, 3].map((n) => designRecorderDocument(composed(n), "dark"))));
    stopping.stop();

    const none = createDesignRecorderDocuments();
    expect(await none.prepare(composed(2), "light")).toBe(await designRecorderDocument(composed(2), "light"));
    none.stop();
  }, 30_000);

  it("answers requests still held when it stops", async () => {
    const documents = createDesignRecorderDocuments({ workerFile: bundle.url });
    const held = documents.prepare(composed(7), "light");
    documents.stop();
    expect(await held).toBe(await designRecorderDocument(composed(7), "light"));
  }, 30_000);
});
