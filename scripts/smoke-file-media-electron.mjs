// Real Chromium custom-protocol playback, ranges, canvas copy and download.
// Runs on macOS, or Linux with DISPLAY (for example xvfb-run). Cloud identity
// and transport are simulated. Linux uses the real standalone worker reader;
// macOS uses the Local reader as its cloud-response fixture because the worker
// intentionally requires Linux descriptor paths. Qualify both hosts.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { _electron as electron, expect } from "@playwright/test";
import { previewPdf, previewDocx } from "./document-preview-fixtures.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cloudFileReader = process.platform === "linux" ? "worker" : "local-fixture";
const packaged = process.argv.includes("--packaged");
const root = await fs.mkdtemp(path.join(os.tmpdir(), "zeros-media-electron-"));
const workspace = path.join(root, "workspace"), profile = path.join(root, "profile");
const listener = createServer();
await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const output = path.join(repo, ".context", "packaged-file-media");
const url = packaged
  ? `${pathToFileURL(path.join(output, "apps/desktop/src/renderer/harnesses/harness-file-media.html")).href}?native-media`
  : `http://127.0.0.1:${port}/apps/desktop/src/renderer/harnesses/harness-file-media.html?native-media`;
const vite = packaged ? null : spawn("pnpm", ["exec", "vite", "--mode", "ui-smoke", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: repo, stdio: "ignore", detached: true });
let app;
const errors = [], reports = [];
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
// A valid, sparse ten-minute WebM: the original VP8 keyframe repeated once a
// second, indexed by Cues, with legal EBML Void padding in each cluster. Unlike
// appending junk to a two-second clip, Chromium can seek by time and file offset.
async function sparseVideo(file, template) {
  const vint = value => {
    const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value) | (1n << 56n)); return bytes;
  };
  const uint = (value, length = 8) => {
    const bytes = Buffer.alloc(length);
    for (let i = length - 1, n = BigInt(value); i >= 0; i--, n >>= 8n) bytes[i] = Number(n & 255n);
    return bytes;
  };
  const element = (id, body) => Buffer.concat([Buffer.from(id, "hex"), vint(body.length), body]);
  const elements = bytes => {
    const parts = [];
    for (let offset = 0; offset < bytes.length;) {
      const start = offset;
      let idLength = 1; while (!(bytes[offset] & (1 << (8 - idLength)))) idLength++;
      const id = bytes.subarray(offset, offset += idLength).toString("hex");
      let sizeLength = 1; while (!(bytes[offset] & (1 << (8 - sizeLength)))) sizeLength++;
      let size = BigInt(bytes[offset] & ((1 << (8 - sizeLength)) - 1));
      for (let index = 1; index < sizeLength; index++) size = (size << 8n) | BigInt(bytes[offset + index]);
      offset += sizeLength;
      const end = offset + Number(size);
      parts.push({ id, body: bytes.subarray(offset, end), raw: bytes.subarray(start, end) }); offset = end;
    }
    return parts;
  };
  const top = elements(template), segment = elements(top.find(item => item.id === "18538067").body);
  const duration = Buffer.alloc(8); duration.writeDoubleBE(600_000);
  const info = element("1549a966", Buffer.concat(elements(segment.find(item => item.id === "1549a966").body)
    .map(item => item.id === "4489" ? element(item.id, duration) : item.raw)));
  const tracks = segment.find(item => item.id === "1654ae6b").raw;
  const block = elements(segment.find(item => item.id === "1f43b675").body).find(item => item.id === "a3").body;
  const frameCount = 600, bytes = 200_000_000;
  const cues = (start, slot) => element("1c53bb6b", Buffer.concat(Array.from({ length: frameCount }, (_, index) =>
    element("bb", Buffer.concat([element("b3", uint(index * 1000)), element("b7", Buffer.concat([
      element("f7", uint(1, 1)), element("f1", uint(start + index * slot)),
    ]))])))));
  const prefix = top[0].raw, segmentOffset = prefix.length + 12;
  const clusterStart = info.length + tracks.length + cues(0, 0).length;
  const slot = Math.floor((bytes - segmentOffset - clusterStart) / frameCount);
  const fileHandle = await fs.open(file, "w");
  try {
    await fileHandle.write(Buffer.concat([prefix, Buffer.from("18538067", "hex"), vint(bytes - segmentOffset), info, tracks, cues(clusterStart, slot)]));
    for (let index = 0; index < frameCount; index++) {
      const offset = segmentOffset + clusterStart + index * slot;
      const length = index === frameCount - 1 ? bytes - offset : slot;
      const body = Buffer.concat([element("e7", uint(index * 1000)), element("a3", block)]);
      const header = Buffer.concat([Buffer.from("1f43b675", "hex"), vint(length - 12), body, Buffer.from("ec", "hex"), vint(length - 12 - body.length - 9)]);
      await fileHandle.write(header, 0, header.length, offset);
    }
    await fileHandle.truncate(bytes);
  } finally { await fileHandle.close(); }
}
try {
  if (packaged) {
    const { build: buildRenderer, loadConfigFromFile } = await import("vite");
    const { config } = await loadConfigFromFile({ command: "build", mode: "production" }, path.join(repo, "vite.config.ts"));
    await buildRenderer({ ...config, configFile: false, logLevel: "warn", build: {
      ...config.build, outDir: output, emptyOutDir: true,
      rollupOptions: { ...config.build.rollupOptions, input: path.join(repo, "apps/desktop/src/renderer/harnesses/harness-file-media.html") },
    } });
  }
  await fs.mkdir(workspace); await fs.mkdir(profile);
  await fs.writeFile(path.join(workspace, "report.pdf"), previewPdf());
  await fs.writeFile(path.join(workspace, "report.docx"), previewDocx());
  const malformedWord = previewDocx({ documentXml: "<document><body></document>" });
  await fs.writeFile(path.join(workspace, "invalid-xml.docx"), malformedWord);
  const fixture = await fs.readFile(path.join(repo, "apps/desktop/src/renderer/harnesses/harness-file-media-fixtures.ts"), "utf8");
  const video = Buffer.from(fixture.match(/base64,([A-Za-z0-9+/=]+)/)[1], "base64");
  await sparseVideo(path.join(workspace, "clip.webm"), video);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await fs.writeFile(path.join(workspace, "sample.png"), png);
  await fs.writeFile(path.join(workspace, "large.png"), png);
  await fs.truncate(path.join(workspace, "large.png"), 6 * 1024 * 1024);
  const preload = path.join(root, "preload.cjs"), main = path.join(root, "main.cjs");
  await build({ entryPoints: [path.join(repo, "apps/desktop/electron/preload.ts")], outfile: preload, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
  await build({ stdin: { resolveDir: repo, loader: "ts", contents: `
    import { app, BrowserWindow, dialog, ipcMain, session } from "electron";
    import { registerFileMediaProtocolPrivileges, installFileMediaProtocol, openFileMediaSource, closeFileMediaSource, replyFileMediaRange, downloadFileMediaSource } from "./apps/desktop/electron/file-media-protocol";
    import { readWorkspaceFile } from "./apps/desktop/src/engine/files/read-file";
    import { readWorkspaceMediaRange } from "./apps/desktop/src/engine/files/file-media";
    import { FileService } from "./apps/cloud-worker/src/workspace/files";
    import { WorkspaceScope } from "./apps/cloud-worker/src/workspace/scope";
    const root = ${JSON.stringify(workspace)};
    const cloud = new FileService(new WorkspaceScope({ id: "22222222-2222-4222-8222-222222222222", organizationId: "11111111-1111-4111-8111-111111111111", checkoutPath: root, repository: "fixture/media", branch: "fixture", baseBranch: "main" }));
    globalThis.mediaReads = [];
    app.setPath("userData", ${JSON.stringify(profile)});
    registerFileMediaProtocolPrivileges();
    app.whenReady().then(async () => {
      installFileMediaProtocol();
      ipcMain.on("zeros:local-development", event => { event.returnValue = false; });
      ipcMain.handle("zeros:attachment-source-maintenance", () => []);
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(true));
      const window = new BrowserWindow({ width: 1000, height: 700, show: true, webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, sandbox: true } });
      ipcMain.handle("zeros:invoke", async (event, { cmd, args = {} }) => {
        if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("Wrong renderer");
        if (cmd === "file_media_open") return openFileMediaSource(args, event);
        if (cmd === "file_media_close") return closeFileMediaSource(args, event);
        if (cmd === "file_media_reply") return replyFileMediaRange(args, event);
        if (cmd === "file_media_download") return downloadFileMediaSource(args, event);
        if (cmd !== "read_file" && cmd !== "read_file_range") return {};
        const placement = String(args.cwd).startsWith("cloud://") ? "cloud" : "local";
        globalThis.mediaReads.push({ placement, cmd, offset: args.offset, length: args.length, path: args.path, streamMedia: args.streamMedia });
        if (placement === "cloud" && ${JSON.stringify(cloudFileReader)} === "worker") return cloud.handle(cmd === "read_file" ? "file.read" : "file.readRange", { ...args, cwd: root, workspaceId: "22222222-2222-4222-8222-222222222222" });
        return cmd === "read_file" ? readWorkspaceFile(root, args.path, args) : readWorkspaceMediaRange(root, args);
      });
      await window.loadURL("about:blank");
    }).catch(error => { console.error(error); app.exit(1); });
  ` }, outfile: main, bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
  const deadline = Date.now() + 60_000;
  while (!packaged && !(await fetch(url).then(response => response.ok, () => false))) {
    assert(Date.now() < deadline, "Vite did not start");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  app = await electron.launch({ args: [main, ...(process.platform === "linux" ? ["--no-sandbox"] : [])], cwd: repo });
  app.process().stderr.on("data", chunk => process.stderr.write(chunk));
  app.on("console", message => { if (message.type() === "error") console.error(message.text()); });
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  // Attach diagnostics before navigating; the first renderer import can fail
  // before firstWindow() returns when the main process navigates immediately.
  await page.goto(url);
  await page.waitForFunction(() => !!window.__zerosFileMediaHarness);
  for (const owner of ["personal", "organization", "cloud"]) {
    const stages = [];
    const sample = async name => stages.push({ name, bytes: await app.evaluate(() => globalThis.mediaReads.reduce((sum, read) => sum + (read.length ?? 0), 0)), video: await page.locator("video").evaluate(video => ({ time: video.currentTime, duration: video.duration, ready: video.readyState, buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]) })) });
    await page.evaluate(owner => window.__zerosFileMediaHarness.render(owner, "clip.webm"), owner);
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    await sample("metadata");
    const source = await page.locator("video").getAttribute("src");
    assert(source.startsWith("zeros-media://"));
    await page.getByRole("button", { name: "Play video", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("video").currentTime > 0.1);
    await page.getByRole("button", { name: "Pause video", exact: true }).click();
    await sample("play-pause");
    await page.evaluate(() => { document.querySelector("video").currentTime = 480; });
    await page.waitForFunction(() => { const video = document.querySelector("video"); return !video.seeking && video.currentTime >= 480; });
    await sample("seek");
    // Probe the protocol from Electron: the packaged renderer intentionally
    // permits media playback without allowing fetch() to this scheme.
    const range = await app.evaluate(async ({ net }, source) => {
      const response = await net.fetch(source, { headers: { Range: "bytes=199999968-199999999" } });
      return { status: response.status, range: response.headers.get("content-range"), bytes: [...new Uint8Array(await response.arrayBuffer())] };
    }, source);
    assert.equal(range.status, 206); assert.equal(range.range, "bytes 199999968-199999999/200000000");
    assert.deepEqual(range.bytes, Array(32).fill(0));
    await app.evaluate(({ clipboard }) => clipboard.clear());
    const copyFrame = page.getByRole("button", { name: "Copy current frame", exact: true });
    await copyFrame.click();
    await expect(copyFrame).toBeEnabled();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readImage().getSize());
    assert.deepEqual(copied, { width: 160, height: 96 });
    await sample("copy");
    const beforeHide = await app.evaluate(() => globalThis.mediaReads.length);
    await page.evaluate(owner => window.__zerosFileMediaHarness.render(owner, "clip.webm", false), owner);
    await page.waitForFunction(() => !document.querySelector("video"));
    assert.equal(await app.evaluate(async ({ net }, source) => (await net.fetch(source)).status, source), 404);
    await page.waitForTimeout(250);
    assert.equal(await app.evaluate(() => globalThis.mediaReads.length), beforeHide);
    await page.evaluate(owner => window.__zerosFileMediaHarness.render(owner, "clip.webm"), owner);
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    assert(await page.locator("video").evaluate(video => video.paused && video.currentTime >= 479), "Hidden return lost playback position");
    const reads = await app.evaluate(() => globalThis.mediaReads.splice(0));
    const ranges = reads.filter(read => read.cmd === "read_file_range");
    assert(ranges.every(read => read.length <= 1024 * 1024));
    const requestedBytes = ranges.reduce((sum, read) => sum + read.length, 0);
    // Chromium owns its read-ahead buffer. These budgets cover two cold opens,
    // playback, an eight-minute seek and copy, not just one transport packet.
    assert(stages[0].bytes <= 32 * 1024 * 1024, "Metadata consumed more than the native read-ahead budget");
    assert(ranges.some(read => read.offset > 100_000_000 && read.length > 32), "Seeking did not read the destination range");
    assert(requestedBytes < 96 * 1024 * 1024, `Playback requested too much: ${requestedBytes}`);
    reports.push({ owner, encodedBytes: 200_000_000, requestedBytes, metadataBytes: stages[0].bytes, rangeCount: ranges.length, seek: true, copy: true, hiddenRetirement: true });
  }
  const downloaded = path.join(root, "downloaded.webm");
  await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, downloaded);
  await page.getByRole("button", { name: "Video actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  const downloadDeadline = Date.now() + 60_000;
  while (!(await fs.stat(downloaded).catch(() => null))) {
    assert(Date.now() < downloadDeadline, "Download did not finish");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await fs.stat(downloaded)).size, 200_000_000);
  assert.equal(await digest(downloaded), await digest(path.join(workspace, "clip.webm")));
  await page.evaluate(() => window.__zerosFileMediaHarness.render("cloud", "sample.png"));
  await page.waitForFunction(() => document.querySelector("[data-file-media-preview] img")?.naturalWidth === 1);
  await app.evaluate(({ clipboard }) => clipboard.clear());
  const copyImage = page.getByRole("button", { name: "Copy image", exact: true });
  await copyImage.click();
  await expect(copyImage).toBeEnabled();
  assert.deepEqual(await app.evaluate(({ clipboard }) => clipboard.readImage().getSize()), { width: 1, height: 1 });
  for (const owner of ["personal", "organization", "cloud", "personal"]) {
    await page.evaluate(owner => window.__zerosFileMediaHarness.hover(owner, "sample.png"), owner);
    await page.getByRole("button", { name: "Saved image", exact: true }).hover();
    const hoverImage = page.locator("[data-image-hover-preview] img");
    await expect(hoverImage).toBeVisible();
    await expect.poll(() => hoverImage.evaluate(image => image.naturalWidth)).toBe(1);
    const source = await hoverImage.getAttribute("src");
    assert(source.startsWith("zeros-media://"), "Saved image hover must use the native stream");
    await page.evaluate(owner => window.__zerosFileMediaHarness.hover(owner, "sample.png", false), owner);
    await expect(hoverImage).toHaveCount(0);
    assert.equal(await app.evaluate(async ({ net }, source) => (await net.fetch(source)).status, source), 404);
    const beforeLarge = await app.evaluate(() => globalThis.mediaReads.length);
    await page.evaluate(owner => window.__zerosFileMediaHarness.hover(owner, "large.png"), owner);
    await page.mouse.move(900, 600);
    await page.getByRole("button", { name: "Saved image", exact: true }).hover();
    await expect(page.locator("[data-image-hover-preview]")).toContainText("Image is too large to preview");
    await expect(hoverImage).toHaveCount(0);
    assert.equal(await app.evaluate((_electron, before) => globalThis.mediaReads.slice(before).filter(read => read.cmd === "read_file_range").length, beforeLarge), 0, "Oversized hover must not load any image bytes");
  }
  for (const owner of ["personal", "organization", "cloud"]) {
    await page.evaluate(owner => window.__zerosFileMediaHarness.render(owner, "report.pdf"), owner);
    await expect(page.getByRole("region", { name: "PDF page 1", exact: true })).toContainText("Document preview - page 1");
    await page.getByRole("button", { name: "Next page", exact: true }).click();
    await expect(page.getByRole("region", { name: "PDF page 2", exact: true })).toContainText("Document preview - page 2");
    await page.screenshot({ path: path.join(repo, ".context", `native-pdf-${owner}.png`) });
    const pdf = path.join(root, `${owner}.pdf`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, pdf);
    await page.getByRole("button", { name: "Download PDF", exact: true }).click();
    await expect.poll(() => fs.readFile(pdf).then(bytes => bytes.equals(previewPdf()), () => false)).toBe(true);
    await page.evaluate(owner => window.__zerosFileMediaHarness.render(owner, "report.docx"), owner);
    await expect(page.frameLocator("iframe").getByText("Word document preview", { exact: true })).toBeVisible();
    await expect.poll(() => page.frameLocator("iframe").locator("img").evaluate(image => image.naturalWidth)).toBe(1);
    await page.screenshot({ path: path.join(repo, ".context", `native-word-${owner}.png`) });
    const word = path.join(root, `${owner}.docx`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, word);
    await page.getByRole("button", { name: "Download document", exact: true }).click();
    await expect.poll(() => fs.readFile(word).then(bytes => bytes.equals(previewDocx()), () => false)).toBe(true);
    await page.evaluate(owner => window.__zerosFileMediaHarness.render(owner, "invalid-xml.docx"), owner);
    await expect(page.getByText("This Word document couldn't be loaded.", { exact: true })).toBeVisible();
    await expect(page.locator("[data-document-controls]")).toHaveCount(0);
    const invalidWord = path.join(root, `${owner}-invalid.docx`);
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, invalidWord);
    await page.getByRole("button", { name: "Download document", exact: true }).click();
    await expect.poll(() => fs.readFile(invalidWord).then(bytes => bytes.equals(malformedWord), () => false)).toBe(true);
  }
  assert.deepEqual(errors, []);
  const report = { platform: process.platform, packagedRenderer: packaged, simulatedCloudBridge: true, cloudFileReader, nativeSaveDialogAutomated: true, reports, streamedDownloadBytes: 200_000_000, exactDownload: true, imageCopy: true, savedImageHover: true, oversizedHoverMetadataOnly: true, pdfAndWordPages: true, exactDocumentDownloads: true, malformedWordFallback: true };
  await fs.mkdir(path.join(repo, ".context"), { recursive: true });
  await fs.writeFile(path.join(repo, ".context/media-stream-native-report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  await app?.close();
  if (vite) process.kill(-vite.pid, "SIGTERM");
  await fs.rm(root, { recursive: true, force: true });
}
