// Run with CHROME_PATH pointing to Chrome. Snapshots are synthetic transcript
// data under .context; self-size includes legitimate text growth, so the gate
// compares retained closures at each source location rather than total bytes.
import assert from "node:assert/strict";
import { createWriteStream, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";

const entry = "apps/desktop/src/renderer/harnesses/harness-stream-renders.html";
const outDir = resolve(".context/renderer-performance/heap-dist");

function summarize(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const fields = data.snapshot.meta.node_fields;
  const width = fields.length, type = fields.indexOf("type"), size = fields.indexOf("self_size");
  const types = data.snapshot.meta.node_types[type];
  const locations = data.snapshot.meta.location_fields, stride = locations.length;
  const object = locations.indexOf("object_index"), script = locations.indexOf("script_id");
  const line = locations.indexOf("line"), column = locations.indexOf("column");
  let bytes = 0, closureCount = 0;
  for (let offset = 0; offset < data.nodes.length; offset += width) {
    bytes += data.nodes[offset + size];
    if (types[data.nodes[offset + type]] === "closure") closureCount++;
  }
  const closures = {};
  for (let offset = 0; offset < data.locations.length; offset += stride) {
    const node = data.locations[offset + object];
    if (types[data.nodes[node + type]] !== "closure") continue;
    const key = `${data.locations[offset + script]}:${data.locations[offset + line] + 1}:${data.locations[offset + column] + 1}`;
    closures[key] = (closures[key] ?? 0) + 1;
  }
  return { bytes, closureCount, closures };
}

let server, browser;
try {
  await build({ logLevel: "warn", build: {
    outDir, emptyOutDir: true, minify: false, rollupOptions: { input: resolve(entry) },
  } });
  server = await preview({ configFile: false, build: { outDir },
    preview: { host: "127.0.0.1", port: 5199, strictPort: false } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await page.addInitScript(() => { Date.now = () => 10_000; });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}${entry}`);
  await page.locator("[data-chat='stream-A'] .zeros-agent-surface").waitFor();
  const stream = rounds => page.evaluate(async count => {
    for (let i = 0; i < count; i++) {
      globalThis.window.streamRenderFixture.measure();
      await new Promise(globalThis.requestAnimationFrame);
    }
  }, rounds);
  await stream(10);
  const client = await page.context().newCDPSession(page);
  await client.send("HeapProfiler.enable");
  const snapshots = [];
  for (let group = 0; group < 3; group++) {
    if (group) await stream(20);
    await client.send("HeapProfiler.collectGarbage");
    const file = resolve(`.context/renderer-performance/stream-heap-${group}.heapsnapshot`);
    const sink = createWriteStream(file);
    const append = ({ chunk }) => sink.write(chunk);
    client.on("HeapProfiler.addHeapSnapshotChunk", append);
    await client.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    client.off("HeapProfiler.addHeapSnapshotChunk", append);
    await new Promise(done => sink.end(done));
    snapshots.push({ group, ...summarize(file), textLength: await page.evaluate(() =>
      globalThis.window.streamRenderFixture.measure(0).textLength) });
  }
  const first = snapshots[0], last = snapshots.at(-1);
  const growingLocations = Object.entries(last.closures).map(([location, count]) => ({
    location, before: first.closures[location] ?? 0, after: count, growth: count - (first.closures[location] ?? 0),
  })).filter(value => value.growth >= 20).sort((a, b) => b.growth - a.growth);
  console.log(JSON.stringify({ rounds: 40, snapshots: snapshots.map(snapshot => ({
    group: snapshot.group, bytes: snapshot.bytes, closureCount: snapshot.closureCount, textLength: snapshot.textLength,
  })), growingLocations, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.ok(last.textLength > first.textLength, "the transcript must actually grow");
  assert.deepEqual(growingLocations, [], "stream rounds must not retain updater closures at a growing source location");
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.httpServer.close(done));
}
