import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { parse } from "parse5";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_BATCH_CAPTURE_PIXELS,
  DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES,
  designBatchCaptureRequestSchema,
  designCaptureRasterSize,
  designThumbnailsRenderSchema,
  designThumbnailsReplySchema,
  type DesignBatchCaptureRequest,
} from "@zeros/protocol/design-capture";
import { designReplyForOlderRenderer } from "../options-shows-compat";
import { MAX_BRIDGE_FRAME_BYTES } from "@zeros/protocol/schemas";
import { setDesignCaptureConfig } from "../capture-client";
import { DesignCaptureAdmission } from "../capture-admission";
import { assertDesignBatchStylesheets, startDesignCaptureService, type DesignCaptureService } from "../capture-service";
import { DESIGN_DIRECTORY_NAME, initializeDesignDocument, prepareDesignNavigationFrames, readDesignNavigationSnapshot } from "../document";
import { designDirectoryNameFor } from "../directory-registry";
import { designDirectoryEntry } from "../metadata";
import { configureDesignFonts, resetDesignFontsForTests, settleDesignFontDownloadsForTests } from "../style-fonts";
import { readCanvas } from "../document-storage";
import { designIdentityCacheStatsForTests, resetDesignIdentityCacheForTests } from "../identity-cache";
import { prepareFrameRenderSource } from "../render-preparation";
import { sharedDesignParseStatsForTests } from "../shared-parse";
import { composeDesignThumbnailBatches, configureDesignThumbnailBatchTailwindForTests, readDesignThumbnails, renderDesignThumbnails } from "../thumbnail-batch";
import { currentDesignThumbnailPipeline, resetDesignThumbnailStoreForTests, settleDesignThumbnailStoreForTests, storeDesignThumbnail } from "../thumbnail-store";

/** A valid RGBA PNG of the given size; the capture service checks each picture's dimensions. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk("IEND", Buffer.alloc(0))]);
}

const links = (html: string) => [...html.matchAll(/href="zeros-capture:\/\/css\/([a-f0-9]{64})"/g)].map((match) => match[1]!);

describe("batch Design thumbnails", () => {
  let root: string;
  let folder: string;
  let directoryId: string;
  const services: DesignCaptureService[] = [];
  const frame = (file: string, classes: string, attributes = "") =>
    `<!doctype html><html${attributes}><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="m" class="${classes}">x</main></body></html>`;
  let registered = 0;
  const register = async (files: string[]) => {
    const file = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    for (const source of files) {
      const id = `frame_${registered++}`;
      canvas.frames[id] = { kind: "html", source, title: source, x: registered * 400, y: 0, width: 320, height: 200 };
      canvas.pages[0].frames.push(id);
    }
    canvas.styles = [
      { id: "app", title: "App", kind: "css", path: "styles/app.css" },
      { id: "tw", title: "Tailwind", kind: "tailwind", path: "styles/tw.css" },
    ];
    await writeFile(file, JSON.stringify(canvas, null, 2));
  };
  const versions = async (files: string[]) => {
    const navigation = await readDesignNavigationSnapshot(root);
    const versions = new Map<string, string>();
    for (let start = 0; start < files.length; start += 16)
      for (const entry of (await prepareDesignNavigationFrames(root, navigation.catalogRevision, files.slice(start, start + 16))).frames)
        versions.set(entry.file, entry.sourceVersion!);
    return versions;
  };
  const input = (frames: Array<{ file: string; sourceVersion: string }>, maxDimension = 128) =>
    ({ workspaceId: "w", directoryId, theme: null, colorScheme: "light" as const, maxDimension, frames });

  beforeEach(async () => {
    resetDesignThumbnailStoreForTests();
    registered = 0;
    root = await mkdtemp(path.join(tmpdir(), "zeros-thumbnails-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await initializeDesignDocument(root);
    directoryId = designDirectoryEntry(root, designDirectoryNameFor(root))!.id;
    await mkdir(path.join(folder, "page-1"), { recursive: true });
    await mkdir(path.join(root, "styles"), { recursive: true });
    await writeFile(path.join(folder, "tokens.css"), ".hero { color: red; }");
    await writeFile(path.join(root, "styles/app.css"), ".card { padding: 1px; } .unused { margin: 9px; }");
    await writeFile(path.join(root, "styles/tw.css"), '@import "tailwindcss";');
    await writeFile(path.join(folder, "page-1/a.html"), frame("a", "hero card p-3", ' data-zd-theme="dark"'));
    await writeFile(path.join(folder, "page-1/b.html"), frame("b", "hero m-2"));
    await register(["page-1/a.html", "page-1/b.html"]);
  });
  afterEach(async () => {
    setDesignCaptureConfig(undefined);
    await Promise.all(services.splice(0).map((service) => service.stop()));
    await settleDesignFontDownloadsForTests();
    resetDesignFontsForTests();
    await settleDesignThumbnailStoreForTests();
    resetDesignThumbnailStoreForTests();
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it("links every frame of a folder to the same sheets except its own Tailwind utilities", async () => {
    const current = await versions(["page-1/a.html", "page-1/b.html"]);
    const { batches, stale, failed } = await composeDesignThumbnailBatches(root, input([...current].map(([file, sourceVersion]) => ({ file, sourceVersion }))));
    expect({ stale, failed, batches: batches.length }).toEqual({ stale: [], failed: [], batches: 1 });
    const request = designBatchCaptureRequestSchema.parse(batches[0]!.request);
    assertDesignBatchStylesheets(request);
    const [a, b] = request.items.map((item) => item.html);
    const shared = links(a!).filter((hash) => links(b!).includes(hash));
    const css = (hash: string) => request.stylesheets[hash]!;
    expect(shared.some((hash) => css(hash).includes(".hero"))).toBe(true);
    // Imported sources are whole, not pruned to one frame's classes.
    expect(shared.some((hash) => css(hash).includes(".unused"))).toBe(true);
    const own = (html: string) => links(html).filter((hash) => !shared.includes(hash)).map(css).join("\n");
    expect(own(a!)).toContain(".p-3");
    expect(own(a!)).not.toContain(".m-2");
    expect(own(b!)).toContain(".m-2");
    for (const html of [a!, b!]) {
      expect(html).not.toMatch(/<style[^>]*data-zeros-sheet="[^"]*"><\/style>/);
      expect(html).not.toContain("<script");
    }
    // The base theme replaces an authored one, as on the canvas.
    expect(a).not.toContain('data-zd-theme="dark"');
    expect(batches[0]!.frames.get(request.items[0]!.id)).toEqual({ file: "page-1/a.html", sourceVersion: current.get("page-1/a.html") });
  });

  it("links placeholders by their parsed location, keeping one inside SVG inline as the canvas does", async () => {
    await writeFile(path.join(folder, "odd<style.css"), ".odd { color: blue; }");
    await writeFile(path.join(folder, "icons.css"), ".icon { fill: red; }");
    await writeFile(path.join(folder, "page-1/a.html"), '<!doctype html><html><head><link rel="stylesheet" href="../odd<style.css"></head>' +
      '<body><main data-oid="m" class="odd">x<svg data-oid="s"><link rel="stylesheet" href="../icons.css"/><path class="icon" d="M0 0"/></svg></main></body></html>');
    const current = await versions(["page-1/a.html"]);
    const { batches, failed } = await composeDesignThumbnailBatches(root, input([{ file: "page-1/a.html", sourceVersion: current.get("page-1/a.html")! }]));
    expect(failed).toEqual([]);
    const request = batches[0]!.request;
    const document = parse(request.items[0]!.html);
    const elements: Array<{ tagName: string; namespaceURI: string; attrs: Array<{ name: string; value: string }>; childNodes?: Array<{ value?: string }> }> = [];
    const walk = (node: { childNodes?: unknown[]; tagName?: string }) => {
      if (node.tagName) elements.push(node as (typeof elements)[number]);
      for (const child of node.childNodes ?? []) walk(child as { childNodes?: unknown[] });
    };
    walk(document as never);
    const placeholders = elements.filter((element) => element.attrs.some((attribute) => attribute.name === "data-zeros-sheet"));
    const linked = placeholders.filter((element) => element.tagName === "link");
    const inline = placeholders.filter((element) => element.tagName === "style");
    expect(linked.map((element) => request.stylesheets[links(`href="${element.attrs.find((attribute) => attribute.name === "href")!.value}"`)[0]!]))
      .toContainEqual(expect.stringContaining(".odd"));
    expect(linked.find((element) => request.stylesheets[links(`href="${element.attrs.find((attribute) => attribute.name === "href")!.value}"`)[0]!]?.includes(".odd"))!
      .attrs.find((attribute) => attribute.name === "data-zeros-source")?.value).toBe("odd<style.css");
    expect(inline).toHaveLength(1);
    expect(inline[0]!.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(inline[0]!.childNodes?.map((child) => child.value).join("")).toContain(".icon");
    expect(elements.filter((element) => element.tagName === "main" || element.tagName === "path")).toHaveLength(2);
  });

  it("links sheets and themes the root without parsing a frame again, inline SVG icons included", async () => {
    const file = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    canvas.themes = [{ id: "light", base: true }, { id: "dusk" }];
    await writeFile(file, JSON.stringify(canvas, null, 2));
    await writeFile(path.join(folder, "page-1/b.html"), "<!doctype html><!-- before the root --><html data-zd-theme=\"light\"><head><link rel=\"stylesheet\" href=\"../tokens.css\"></head><body><main data-oid=\"m\" class=\"hero\">x<svg data-oid=\"i\" viewBox=\"0 0 4 4\"><path d=\"M0 0h4\"/></svg></main></body></html>");
    const current = await versions(["page-1/a.html", "page-1/b.html"]);
    const frames = [...current].map(([frameFile, sourceVersion]) => ({ file: frameFile, sourceVersion }));
    await composeDesignThumbnailBatches(root, input(frames));
    const parsed = async (run: () => Promise<unknown>) => {
      const before = sharedDesignParseStatsForTests().parses;
      await run();
      return sharedDesignParseStatsForTests().parses - before;
    };
    const document = await readCanvas(root);
    const prepare = await parsed(async () => {
      for (const frame of frames) {
        const source = await readFile(path.join(folder, frame.file), "utf8");
        await prepareFrameRenderSource(root, source, { width: 320, height: 200 }, undefined, undefined, frame.file, document, { parts: true });
      }
    });
    let request!: DesignBatchCaptureRequest;
    const compose = await parsed(async () => { request = (await composeDesignThumbnailBatches(root, { ...input(frames), theme: "dusk" })).batches[0]!.request; });
    expect(compose).toBe(prepare);
    for (const item of request.items) {
      const rootElement = parse(item.html).childNodes.find((node) => (node as { tagName?: string }).tagName === "html") as { attrs: Array<{ name: string; value: string }> };
      expect(rootElement.attrs.filter((attribute) => attribute.name === "data-zd-theme")).toEqual([{ name: "data-zd-theme", value: "dusk" }]);
      expect(links(item.html).length).toBeGreaterThan(0);
      expect(item.html).not.toMatch(/<style[^>]*data-zeros-sheet="[^"]*"><\/style>/);
    }
  });

  it("gives each frame the App fonts its own chosen sources import", async () => {
    configureDesignFonts({
      cacheDirectory: () => path.join(root, "fonts"),
      fetch: (async (request: string | URL | Request) => {
        const url = String(request);
        const family = /family=([A-Za-z]+)/.exec(url)?.[1];
        if (url.startsWith("https://fonts.googleapis.com/") && family)
          return new Response(`@font-face { font-family: '${family}'; src: url(https://fonts.gstatic.com/s/${family}.woff2) format('woff2'); }`);
        if (url.startsWith("https://fonts.gstatic.com/")) return new Response(Buffer.from("font"));
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
    for (const family of ["Acme", "Beta"])
      await writeFile(path.join(root, `styles/${family}.css`), `@import url("https://fonts.googleapis.com/css2?family=${family}");\n.${family} { font-family: ${family}; }`);
    const file = path.join(folder, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(file, "utf8"));
    canvas.styles = ["Acme", "Beta"].map((id) => ({ id, title: id, kind: "css", path: `styles/${id}.css` }));
    canvas.frames.frame_0.styles = ["Acme"];
    canvas.frames.frame_1.styles = ["Acme", "Beta"];
    await writeFile(file, JSON.stringify(canvas, null, 2));
    await versions(["page-1/a.html", "page-1/b.html"]);
    await settleDesignFontDownloadsForTests();
    const current = await versions(["page-1/a.html", "page-1/b.html"]);
    const { batches, failed } = await composeDesignThumbnailBatches(root, input([...current].map(([file, sourceVersion]) => ({ file, sourceVersion }))));
    expect(failed).toEqual([]);
    const request = batches[0]!.request;
    const [a, b] = request.items.map((item) => links(item.html).map((hash) => request.stylesheets[hash]!).join("\n"));
    expect(a).toContain("font-family: 'Acme'");
    expect(a).not.toContain("font-family: 'Beta'");
    expect(b).toContain("font-family: 'Acme'");
    expect(b).toContain("font-family: 'Beta'");
  });

  it("carries a frame's own pruned CSS when its whole sources exceed one request", async () => {
    await writeFile(path.join(root, "styles/app.css"), `.card { padding: 1px; } .unused { --x: "${"x".repeat(DESIGN_BATCH_CAPTURE_STYLESHEET_BYTES)}"; }`);
    const current = await versions(["page-1/a.html"]);
    const { batches, failed } = await composeDesignThumbnailBatches(root, input([{ file: "page-1/a.html", sourceVersion: current.get("page-1/a.html")! }]));
    expect(failed).toEqual([]);
    const request = designBatchCaptureRequestSchema.parse(batches[0]!.request);
    const css = Object.values(request.stylesheets).join("\n");
    expect(css).toContain(".card");
    expect(css).not.toContain(".unused");
  });

  it("links one Tailwind sheet for the whole batch when enabled, holding every frame's utilities", async () => {
    const current = await versions(["page-1/a.html", "page-1/b.html"]);
    const frames = [...current].map(([file, sourceVersion]) => ({ file, sourceVersion }));
    const perFrame = designBatchCaptureRequestSchema.parse((await composeDesignThumbnailBatches(root, input(frames))).batches[0]!.request);
    configureDesignThumbnailBatchTailwindForTests(true);
    try {
      const request = designBatchCaptureRequestSchema.parse((await composeDesignThumbnailBatches(root, input(frames))).batches[0]!.request);
      assertDesignBatchStylesheets(request);
      const [a, b] = request.items.map((item) => links(item.html));
      const shared = a!.filter((hash) => b!.includes(hash)).map((hash) => request.stylesheets[hash]!);
      expect(shared.some((css) => css.includes(".p-3") && css.includes(".m-2"))).toBe(true);
      expect(Object.keys(request.stylesheets).length).toBe(Object.keys(perFrame.stylesheets).length - 1);
      expect(a!.length).toBe(links(perFrame.items[0]!.html).length);
    } finally {
      configureDesignThumbnailBatchTailwindForTests(false);
    }
  });

  it("returns a frame whose source moved on as stale with its version, and an unknown frame as failed", async () => {
    const current = await versions(["page-1/a.html"]);
    const { batches, stale, failed } = await composeDesignThumbnailBatches(root, input([
      { file: "page-1/a.html", sourceVersion: "0".repeat(24) },
      { file: "page-1/missing.html", sourceVersion: "1".repeat(24) },
    ]));
    expect(batches).toEqual([]);
    expect(stale).toEqual([{ file: "page-1/a.html", sourceVersion: current.get("page-1/a.html") }]);
    expect(failed).toEqual([{ file: "page-1/missing.html", error: expect.any(String) }]);
    await expect(composeDesignThumbnailBatches(root, { ...input([]), directoryId: "design_other", frames: [{ file: "page-1/a.html", sourceVersion: "0".repeat(24) }] }))
      .rejects.toThrow(/directory changed/);
  });

  it("splits frames across requests the capture host admits", async () => {
    const files = Array.from({ length: 12 }, (_, index) => `page-1/f${index}.html`);
    for (const file of files) await writeFile(path.join(folder, file), frame(file, "hero"));
    await register(files);
    const current = await versions(files);
    const { batches } = await composeDesignThumbnailBatches(root, input(files.map((file) => ({ file, sourceVersion: current.get(file)! })), 1280));
    const perBatch = Math.floor(DESIGN_BATCH_CAPTURE_PIXELS / (1280 * 1280));
    expect(batches.map((batch) => batch.request.items.length)).toEqual([perBatch, files.length - perBatch]);
    for (const batch of batches) assertDesignBatchStylesheets(designBatchCaptureRequestSchema.parse(batch.request));
  });

  it("renders through the capture service, waiting out a busy slot, and maps pictures back to frames", async () => {
    const current = await versions(["page-1/a.html", "page-1/b.html"]);
    const renderBatch = vi.fn(async (request: DesignBatchCaptureRequest) => ({ renderer: "fixture",
      items: request.items.map((item) => {
        const raster = designCaptureRasterSize(item.viewport, item.maxDimension);
        return { id: item.id, bytes: png(raster.width, raster.height) };
      }) }));
    const admission = new DesignCaptureAdmission();
    const service = await startDesignCaptureService(vi.fn(), admission, renderBatch);
    services.push(service);
    setDesignCaptureConfig({ url: service.url, token: service.token });
    // An explicit capture holds the one slot briefly; the batch waits for it.
    const owner = {};
    expect(admission.reserve(owner, "explicit", true)).toBe(true);
    setTimeout(() => admission.release(owner, "explicit"), 300);
    const reply = await renderDesignThumbnails(root, input([...current].map(([file, sourceVersion]) => ({ file, sourceVersion }))));
    expect(reply.pipeline).toBe("thumbnails-1:fixture");
    expect(reply.stale).toEqual([]);
    expect(reply.failed).toEqual([]);
    expect(reply.pictures.map((picture) => [picture.file, picture.sourceVersion, picture.width, picture.height])).toEqual([
      ["page-1/a.html", current.get("page-1/a.html"), 128, 80],
      ["page-1/b.html", current.get("page-1/b.html"), 128, 80],
    ]);
    expect(renderBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps its reply within one bridge frame, deferring pictures past the budget without capturing more", async () => {
    const files = Array.from({ length: 30 }, (_, index) => `page-1/g${index}.html`);
    for (const file of files) await writeFile(path.join(folder, file), frame(file, "hero"));
    await register(files);
    const current = await versions(files);
    const capture = vi.fn(async (request: DesignBatchCaptureRequest) => ({ version: 1 as const, revision: request.revision, renderer: "big",
      // Near the host's 1 MiB PNG bound: a noisy detail picture.
      items: request.items.map((item) => ({ id: item.id, width: 1280, height: 800, data: "A".repeat(1_300_000) })) }));
    const reply = await renderDesignThumbnails(root, input(files.map((file) => ({ file, sourceVersion: current.get(file)! })), 1280), { capture });
    expect(JSON.stringify(reply).length).toBeLessThan(MAX_BRIDGE_FRAME_BYTES - 1024 * 1024);
    expect(reply.pictures.length).toBeGreaterThan(0);
    expect([...reply.pictures.map((picture) => picture.file), ...reply.deferred.map((frame) => frame.file)].sort()).toEqual([...files].sort());
    expect(reply.deferred).toContainEqual({ file: files.at(-1), sourceVersion: current.get(files.at(-1)!) });
    // Batches after the budget is spent are not captured at all.
    expect(capture.mock.calls.length).toBeLessThan(Math.ceil(files.length / Math.floor(DESIGN_BATCH_CAPTURE_PIXELS / (1280 * 1280))));
  });

  it("fails frames a reply leaves out, names by path, or a restarted renderer drew, keeping the first pipeline", async () => {
    const files = Array.from({ length: 12 }, (_, index) => `page-1/f${index}.html`);
    for (const file of files) await writeFile(path.join(folder, file), frame(file, "hero"));
    await register(files);
    const current = await versions(files);
    let call = 0;
    const reply = await renderDesignThumbnails(root, input(files.map((file) => ({ file, sourceVersion: current.get(file)! })), 1280), {
      capture: async (request) => ({ version: 1, revision: request.revision, renderer: `host-${call++}`,
        items: [{ id: request.items[0]!.id, error: `Could not read ${root}/x.png` },
          ...request.items.slice(2).map((item) => ({ id: item.id, width: 1280, height: 800, data: png(1, 1).toString("base64") }))] }),
    });
    const perBatch = Math.floor(DESIGN_BATCH_CAPTURE_PIXELS / (1280 * 1280));
    expect(reply.pipeline).toBe("thumbnails-1:host-0");
    expect(reply.pictures.map((picture) => picture.file)).toEqual(files.slice(2, perBatch));
    expect(reply.failed).toEqual([
      { file: files[0], error: "This frame could not be pictured." },
      { file: files[1], error: "Design capture returned no picture for this frame." },
      { file: files[perBatch], error: "This frame could not be pictured." },
      { file: files[perBatch + 1], error: "Design capture returned no picture for this frame." },
      ...files.slice(perBatch + 2).map((file) => ({ file, error: "The capture renderer changed; try again." })),
    ]);
  });

  it("captures concurrent batches one at a time, and lets a cancelled one leave the line at once", async () => {
    const current = await versions(["page-1/a.html", "page-1/b.html"]);
    const frames = [...current].map(([file, sourceVersion]) => ({ file, sourceVersion }));
    let inFlight = 0, most = 0;
    const release: Array<() => void> = [];
    const capture = vi.fn(async (request: DesignBatchCaptureRequest) => {
      most = Math.max(most, ++inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight--;
      return { version: 1 as const, revision: request.revision, renderer: "turns", items: request.items.map((item) => {
        const raster = designCaptureRasterSize(item.viewport, item.maxDimension);
        return { id: item.id, width: raster.width, height: raster.height, data: png(raster.width, raster.height).toString("base64") };
      }) };
    });
    const first = renderDesignThumbnails(root, input([frames[0]!]), { capture });
    const second = renderDesignThumbnails(root, input([frames[1]!]), { capture });
    const cancelled = new AbortController();
    const third = renderDesignThumbnails(root, input(frames), { capture, signal: cancelled.signal });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    cancelled.abort(new Error("cancelled"));
    await expect(third).rejects.toThrow(/cancelled/);
    expect(capture).toHaveBeenCalledTimes(1);
    release.shift()!();
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    release.shift()!();
    expect((await first).pictures).toHaveLength(1);
    expect((await second).pictures).toHaveLength(1);
    expect(most).toBe(1);
  });

  describe("with the thumbnail store", () => {
    const named = (renderer: string) => setDesignCaptureConfig({ url: "http://127.0.0.1:9/", token: "a".repeat(64), renderer });
    const host = (renderer: string, size = 64) => vi.fn(async (request: DesignBatchCaptureRequest) => ({ version: 1 as const, revision: request.revision, renderer,
      items: request.items.map((item) => {
        const raster = designCaptureRasterSize(item.viewport, item.maxDimension);
        const bytes = png(raster.width, raster.height);
        return { id: item.id, width: raster.width, height: raster.height, data: Buffer.concat([bytes, Buffer.alloc(Math.max(0, size - bytes.length))]).toString("base64") };
      }) }));
    const many = async (count: number) => {
      const files = Array.from({ length: count }, (_, index) => `page-1/s${index}.html`);
      for (const file of files) await writeFile(path.join(folder, file), frame(file, "hero"));
      await register(files);
      const current = await versions(files);
      return files.map((file) => ({ file, sourceVersion: current.get(file)! }));
    };

    it("answers from the store when the host's pipeline is named at launch, and stores deferred pictures for the next ask", async () => {
      named("fixture");
      const frames = await many(30);
      const first = host("fixture", 900_000);
      const reply = await renderDesignThumbnails(root, input(frames, 1280), { capture: first });
      expect(reply.pipeline).toBe("thumbnails-1:fixture");
      expect(reply.deferred.length).toBeGreaterThan(0);
      const captured = first.mock.calls.flatMap(([request]) => request.items.length);
      const again = host("fixture", 900_000);
      const next = await renderDesignThumbnails(root, input(reply.deferred, 1280), { capture: again });
      // Deferred pictures that were captured come from the store; only frames never captured are drawn.
      const drawn = again.mock.calls.flatMap(([request]) => request.items).length;
      expect(drawn).toBe(frames.length - captured.reduce((total, count) => total + count, 0));
      expect(next.pictures.length + next.deferred.length).toBe(reply.deferred.length);
      const third = host("fixture");
      const repeat = await renderDesignThumbnails(root, input(frames.slice(0, 3)), { capture: third });
      expect(third).toHaveBeenCalledTimes(1);
      const hits = host("fixture");
      expect((await renderDesignThumbnails(root, input(frames.slice(0, 3)), { capture: hits })).pictures).toEqual(repeat.pictures);
      expect(hits).not.toHaveBeenCalled();
    });

    it("prepares a frame sent without its version once, returning the record design.frames.prepare would", async () => {
      await writeFile(path.join(folder, "page-1/b.html"), frame("b", "hero m-2 card").replace("x</main>",
        `x<img data-oid="i" src="data:image/png;base64,${png(2, 2).toString("base64")}"><svg data-oid="s" viewBox="0 0 4 4"><path d="M0 0h4"/></svg></main>`));
      const navigation = await readDesignNavigationSnapshot(root);
      const files = ["page-1/a.html", "page-1/b.html"];
      const unversioned = { ...input(files.map((file) => ({ file })) as never), catalogRevision: navigation.catalogRevision };
      const capture = host("fixture");
      // Both cold: neither may lean on the other's remembered identities.
      resetDesignIdentityCacheForTests();
      const reply = await renderDesignThumbnails(root, unversioned, { capture });
      resetDesignIdentityCacheForTests();
      const expected = await prepareDesignNavigationFrames(root, navigation.catalogRevision, files);
      expect(expected.frames.every((entry) => entry.surfaceCost)).toBe(true);
      expect(reply.prepared).toEqual(expected.frames);
      // The fused build remembers identities, so a later preparation of those frames is warm.
      resetDesignIdentityCacheForTests();
      await renderDesignThumbnails(root, unversioned, { capture });
      const before = designIdentityCacheStatsForTests();
      expect((await prepareDesignNavigationFrames(root, navigation.catalogRevision, files)).frames).toEqual(expected.frames);
      expect(designIdentityCacheStatsForTests().hits - before.hits).toBe(files.length);
      expect(reply.pictures.map((picture) => [picture.file, picture.sourceVersion])).toEqual(expected.frames.map((entry) => [entry.file, entry.sourceVersion]));
      expect(reply.stale).toEqual([]);
      // Without the caller's catalog revision, the pictures still come but no records.
      const elsewhere = await renderDesignThumbnails(root, { ...unversioned, catalogRevision: "0".repeat(64) }, { capture });
      expect(elsewhere.prepared).toBeUndefined();
      expect(elsewhere.pictures).toHaveLength(2);
      expect(() => designThumbnailsRenderSchema.parse({ ...unversioned, catalogRevision: undefined })).toThrow(/catalog revision/);
    });

    it("tells a renderer that never negotiated it no prepared record shows nothing", async () => {
      const canvasFile = path.join(folder, "meta/canvas.json");
      const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
      canvas.frames.frame_0.component = "chip";
      await writeFile(canvasFile, JSON.stringify(canvas, null, 2));
      // The main's own template fails and it has no last good render.
      await writeFile(path.join(folder, "page-1/a.html"),
        '<html><head><template data-zd-options>\n<zd-option name="label" type="text" default="Chip"></zd-option>\n</template></head><body data-oid="a"><b data-oid="r">{{ label + }}</b></body></html>');
      await writeFile(path.join(folder, "page-1/b.html"), '<html><body data-oid="b"><zd-chip data-oid="ws"></zd-chip></body></html>');
      const navigation = await readDesignNavigationSnapshot(root);
      const files = ["page-1/a.html", "page-1/b.html"];
      const reply = await renderDesignThumbnails(root, { ...input(files.map((file) => ({ file })) as never), catalogRevision: navigation.catalogRevision },
        { capture: host("fixture") });
      expect(reply.prepared?.find((entry) => entry.file === "page-1/a.html")?.component?.notApplied).toBe("nothing");
      const older = designThumbnailsReplySchema.parse(designReplyForOlderRenderer(reply));
      expect(JSON.stringify(older)).not.toContain('"nothing"');
      expect(older.prepared?.map((entry) => entry.component?.notApplied ?? entry.instances?.notApplied)).toEqual(["defaults", "defaults"]);
    });

    it("lets the host's pipeline win over a wrong name, asking again for pictures stored under the name", async () => {
      named("named");
      const frames = await many(3);
      await renderDesignThumbnails(root, input(frames.slice(0, 2)), { capture: host("named") });
      const actual = host("actual");
      const reply = await renderDesignThumbnails(root, input([frames[0]!, frames[2]!]), { capture: actual });
      expect(reply.pipeline).toBe("thumbnails-1:actual");
      expect(reply.pictures.map((picture) => picture.file)).toEqual([frames[2]!.file]);
      expect(reply.deferred).toEqual([frames[0]]);
      expect(await currentDesignThumbnailPipeline()).toEqual({ pipeline: "thumbnails-1:actual", exact: false });
      const again = host("actual");
      expect((await renderDesignThumbnails(root, input([frames[0]!]), { capture: again })).pictures).toHaveLength(1);
      expect(again).toHaveBeenCalledTimes(1);
    });

    it("reads each frame's newest stored picture for covers at open, keyed by frame id", async () => {
      const current = await versions(["page-1/a.html", "page-1/b.html"]);
      await renderDesignThumbnails(root, input([...current].map(([file, sourceVersion]) => ({ file, sourceVersion }))), { capture: host("fixture") });
      await writeFile(path.join(folder, "page-1/a.html"), frame("a", "hero changed"));
      // Moving b to another file keeps its frame id, so its picture follows.
      await writeFile(path.join(folder, "page-1/moved.html"), frame("b", "hero m-2"));
      await rm(path.join(folder, "page-1/b.html"));
      const file = path.join(folder, "meta/canvas.json");
      const canvas = JSON.parse(await readFile(file, "utf8"));
      canvas.frames.frame_1.source = "page-1/moved.html";
      await writeFile(file, JSON.stringify(canvas, null, 2));
      await writeFile(path.join(folder, "page-1/c.html"), frame("c", "hero"));
      await register(["page-1/c.html"]);
      const read = { workspaceId: "w", directoryId, theme: null, colorScheme: "light" as const, maxDimension: 128 };
      const reply = await readDesignThumbnails(root, { ...read, frames: [{ file: "page-1/a.html" }, { file: "page-1/moved.html" }, { file: "page-1/c.html" }, { file: "page-1/none.html" }] });
      expect(reply.pipeline).toBe("thumbnails-1:fixture");
      expect(reply.pictures.map((picture) => [picture.file, picture.sourceVersion, picture.pipeline])).toEqual([
        ["page-1/a.html", current.get("page-1/a.html"), "thumbnails-1:fixture"],
        ["page-1/moved.html", current.get("page-1/b.html"), "thumbnails-1:fixture"],
      ]);
      expect(reply.missing).toEqual(["page-1/c.html", "page-1/none.html"]);
      expect(reply.deferred).toEqual([]);
      // Another size, theme or color scheme is another picture.
      expect((await readDesignThumbnails(root, { ...read, colorScheme: "dark", frames: [{ file: "page-1/a.html" }] })).missing).toEqual(["page-1/a.html"]);
      await expect(readDesignThumbnails(root, { ...read, directoryId: "design_other", frames: [{ file: "page-1/a.html" }] })).rejects.toThrow(/directory changed/);
    });

    it("keeps a read within one bridge frame, deferring frames it did not look up", async () => {
      const frames = await many(16);
      const big = Buffer.alloc(1_000_000);
      png(1280, 800).copy(big);
      for (const [index] of frames.entries())
        await storeDesignThumbnail(root, directoryId, `frame_${index + 2}`, { theme: null, colorScheme: "light", maxDimension: 1280 },
          { sourceVersion: frames[index]!.sourceVersion, pipeline: "thumbnails-1:x", bytes: big });
      const reply = await readDesignThumbnails(root, { workspaceId: "w", directoryId, theme: null, colorScheme: "light", maxDimension: 1280,
        frames: frames.map(({ file }) => ({ file })) });
      expect(JSON.stringify(reply).length).toBeLessThan(MAX_BRIDGE_FRAME_BYTES - 1024 * 1024);
      expect(reply.pictures.length).toBeGreaterThan(0);
      expect(reply.missing).toEqual([]);
      expect([...reply.pictures.map((picture) => picture.file), ...reply.deferred]).toEqual(frames.map(({ file }) => file));
    });
  });
});
