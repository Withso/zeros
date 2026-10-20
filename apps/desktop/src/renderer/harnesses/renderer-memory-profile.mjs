// Synthetic, offline renderer memory experiment. CDP snapshots include only
// fixture content. Run from the repository root; MEMORY_OUT isolates artifacts.
import assert from "node:assert/strict";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";

const entry =
  "apps/desktop/src/renderer/harnesses/harness-renderer-memory.html";
const output = resolve(process.env.MEMORY_OUT ?? ".context/renderer-memory");
mkdirSync(output, { recursive: true });
const outDir = resolve(process.env.MEMORY_DIST ?? resolve(output, "dist"));
const holdQuery = process.env.MEMORY_HELD !== "0";
const churnHistory = process.env.MEMORY_HISTORY !== "0";
async function summarize(file) {
  // V8 emits large arrays on single lines. Stream the numeric node table and
  // skip edges instead of building a >512 MiB JS string for a busy renderer.
  const counts = new Map();
  let buffer = "",
    stage = "header",
    fields,
    types,
    stride,
    type,
    size,
    name;
  let bytes = 0,
    closures = 0,
    nodes = 0,
    values = [];
  const consume = (text) => {
    const items = text.split(",");
    for (const item of items) {
      if (!item.trim()) continue;
      values.push(Number(item));
      if (values.length !== stride) continue;
      const kind = types[values[type]],
        key = `${kind}:${values[name]}`;
      const previous = counts.get(key) ?? { count: 0, bytes: 0 };
      bytes += values[size];
      previous.count++;
      previous.bytes += values[size];
      if (kind === "closure") closures++;
      counts.set(key, previous);
      nodes++;
      values = [];
    }
  };
  const input = createReadStream(file).pipe(createGunzip());
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buffer += chunk;
    if (stage === "header") {
      const start = buffer.indexOf('"nodes":[');
      if (start < 0) continue;
      const header = JSON.parse(
        `${buffer.slice(0, start).trim().replace(/,$/, "")}}`,
      );
      fields = header.snapshot.meta.node_fields;
      types = header.snapshot.meta.node_types[0];
      stride = fields.length;
      type = fields.indexOf("type");
      name = fields.indexOf("name");
      size = fields.indexOf("self_size");
      buffer = buffer.slice(start + 9);
      stage = "nodes";
    }
    if (stage === "nodes") {
      const end = buffer.indexOf("]");
      if (end < 0) {
        const cut = buffer.lastIndexOf(",");
        if (cut >= 0) {
          consume(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 1);
        }
        continue;
      }
      consume(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      stage = "skip";
    }
    if (stage === "skip") {
      const start = buffer.indexOf('"strings":');
      if (start < 0) {
        buffer = buffer.slice(-32);
        continue;
      }
      buffer = buffer.slice(start + 10);
      stage = "strings";
    }
  }
  assert.equal(stage, "strings");
  assert.equal(values.length, 0);
  const strings = JSON.parse(buffer.trim().slice(0, -1));
  const entries = [...counts].map(([key, value]) => {
    const separator = key.indexOf(":");
    return [
      `${key.slice(0, separator)}:${strings[Number(key.slice(separator + 1))].slice(0, 160)}`,
      value,
    ];
  });
  return {
    bytes,
    closures,
    nodes,
    top: entries.sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 25),
    types: entries
      .filter(([name]) => /^(object|closure|native):/.test(name))
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 40),
  };
}

let server, browser;
const results = [];
try {
  if (!process.env.MEMORY_SKIP_BUILD)
    await build({
      mode: "ui-smoke",
      logLevel: "warn",
      build: {
        outDir,
        emptyOutDir: true,
        minify: "esbuild",
        sourcemap: true,
        rollupOptions: { input: resolve(entry) },
      },
    });
  server = await preview({
    configFile: false,
    build: { outDir },
    preview: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH,
    headless: true,
  });
  for (const placement of (
    process.env.MEMORY_PLACEMENTS ?? "cloud,local,organization-local"
  ).split(",")) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const origin = server.resolvedUrls.local[0],
      errors = [];
    await page.route("**/*", (route) =>
      route.request().url().startsWith(origin)
        ? route.continue()
        : route.fulfill({
            status: 503,
            contentType: "application/json",
            body: '{"error":"offline_fixture"}',
          }),
    );
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `${origin}${entry}?placement=${placement}&rows=${process.env.MEMORY_ROWS ?? 200}&mount=0`,
    );
    const ready = await page.waitForFunction(() =>
      Boolean(globalThis.rendererMemoryFixture),
    );
    await ready.dispose();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    const frames = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() =>
              globalThis.requestAnimationFrame(resolve),
            ),
          ),
      );
    const samples = [];
    async function snapshot(label) {
      await frames();
      await cdp.send("HeapProfiler.collectGarbage");
      const file = resolve(output, `${placement}-${label}.heapsnapshot.gz`),
        sink = createGzip({ level: 1 });
      const written = pipeline(sink, createWriteStream(file));
      // Install a rejection handler immediately; the original write result
      // still has to pass after CDP completes and the stream is joined.
      void written.catch(() => {});
      const append = ({ chunk }) => sink.write(chunk);
      cdp.on("HeapProfiler.addHeapSnapshotChunk", append);
      try {
        await cdp.send("HeapProfiler.takeHeapSnapshot", {
          reportProgress: false,
        });
      } finally {
        cdp.off("HeapProfiler.addHeapSnapshotChunk", append);
        sink.end();
        await written;
      }
      const sample = {
        label,
        ...(await summarize(file)),
        heap: await cdp.send("Runtime.getHeapUsage"),
        dom: await cdp.send("Memory.getDOMCounters"),
        fixture: await page.evaluate(() =>
          globalThis.rendererMemoryFixture.stats(),
        ),
      };
      samples.push(sample);
      writeFileSync(
        resolve(output, `${placement}.json`),
        JSON.stringify({ placement, samples, errors }, null, 2),
      );
      console.log(
        JSON.stringify({
          placement,
          label,
          bytes: sample.bytes,
          dom: sample.dom,
          fixture: sample.fixture,
        }),
      );
    }
    const warmChats = async () => {
      await page.evaluate(() => globalThis.rendererMemoryFixture.mount());
      // A discarded ElementHandle still pins its DOM in CDP. Locator waits
      // return no handle, so the profiler cannot keep every prior chat alive.
      await page.locator(".zeros-agent-surface").first().waitFor();
      for (let i = 0; i < 8; i++) {
        await page.evaluate(
          (i) => globalThis.rendererMemoryFixture.select(i),
          i,
        );
        await frames();
      }
    };
    await snapshot("cold");
    await warmChats();
    await snapshot("warm");
    if (holdQuery)
      await page.evaluate(() => globalThis.rendererMemoryFixture.holdQuery());
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < Number(process.env.MEMORY_SWITCHES ?? 32); i++) {
        await page.evaluate(
          ({ i, revision }) => {
            const fixture = globalThis.rendererMemoryFixture;
            fixture.select(i % 8);
            fixture.replace(i % 8, revision);
            fixture.hide(true);
            fixture.hide(false);
          },
          {
            i,
            revision: round * Number(process.env.MEMORY_SWITCHES ?? 32) + i + 1,
          },
        );
        await frames();
      }
      await page.evaluate(
        (round) => globalThis.rendererMemoryFixture.churnQueries(round),
        round,
      );
      if (churnHistory)
        await page.evaluate(
          (round) => globalThis.rendererMemoryFixture.churnHistory(round),
          round,
        );
      await snapshot(`cycle-${round + 1}`);
    }
    if (holdQuery)
      await page.evaluate(() => globalThis.rendererMemoryFixture.finishQuery());
    await page.evaluate(() => globalThis.rendererMemoryFixture.unmount());
    await snapshot("unmounted");
    // Measurement of deferred library cleanup, not synchronization for a
    // regression race: the held query above was positively joined already.
    await page.waitForTimeout(1_500);
    await snapshot("unmounted-settled");
    const afterNeutralEvent = async (label) => {
      // React 18's return_targetInst retains at most the last event's fiber.
      // Keep the untouched teardown sample, then measure again after an event
      // on the empty root. Neither sample may accumulate earlier chat trees.
      await page.evaluate(() =>
        globalThis.document
          .getElementById("root")
          .dispatchEvent(new globalThis.MouseEvent("click", { bubbles: true })),
      );
      await snapshot(`${label}-after-neutral-event`);
    };
    await afterNeutralEvent("unmounted");
    for (
      let cycle = 1;
      cycle <= Number(process.env.MEMORY_REMOUNTS ?? 2);
      cycle++
    ) {
      await warmChats();
      await page.evaluate(() => globalThis.rendererMemoryFixture.unmount());
      await snapshot(`remount-${cycle}-unmounted`);
      await afterNeutralEvent(`remount-${cycle}-unmounted`);
    }
    results.push({ placement, samples, errors });
    await page.close();
  }
  writeFileSync(
    resolve(output, "results.json"),
    JSON.stringify(results, null, 2),
  );
  assert.deepEqual(
    results.flatMap((result) => result.errors),
    [],
  );
  for (const result of results) {
    const cycles = result.samples.filter((sample) =>
      sample.label.startsWith("cycle-"),
    );
    const warm = result.samples.find((sample) => sample.label === "warm");
    assert.equal(warm.fixture.ownerIsPersonal, result.placement === "local");
    for (const sample of cycles) {
      assert.ok(
        sample.fixture.textCache <= 17,
        "one held preview read must not retain an unbounded completed cache",
      );
      assert.ok(
        sample.fixture.textBytes <= 8 * 1024 * 1024,
        "held reads must not bypass the completed payload budget",
      );
      assert.equal(
        sample.fixture.nativeListeners,
        warm.fixture.nativeListeners,
      );
      assert.equal(sample.fixture.surfaces, 8);
      assert.equal(sample.fixture.hiddenLayers, 7);
      assert.equal(
        sample.fixture.ownerIsPersonal,
        result.placement === "local",
      );
      assert.ok(
        sample.fixture.historyEntries <=
          (result.placement === "cloud" ? 64 : 16),
      );
      assert.ok(
        sample.fixture.historyBytes <=
          (result.placement === "cloud" ? 24 : 16) * 1024 * 1024,
      );
      assert.ok(sample.fixture.historyTokens <= 128);
    }
    assert.ok(
      cycles[1].bytes - cycles[0].bytes < 8 * 1024 * 1024,
      "repeated switch/hide/churn rounds must plateau after GC",
    );
    const unmounted = result.samples.filter((sample) =>
      sample.label.includes("unmounted"),
    );
    const cleared = unmounted.find((sample) =>
      sample.label.endsWith("after-neutral-event"),
    );
    const oneChatNodes = Math.ceil((warm.dom.nodes - cleared.dom.nodes) / 8);
    const oneChatListeners = Math.ceil(
      (warm.dom.jsEventListeners - cleared.dom.jsEventListeners) / 8,
    );
    for (const sample of unmounted) {
      assert.equal(
        sample.fixture.nativeListeners,
        result.samples[0].fixture.nativeListeners,
        "unmount must release native subscriptions",
      );
      assert.equal(sample.fixture.surfaces, 0);
      assert.equal(sample.fixture.messages, 0);
      assert.equal(sample.fixture.historyEntries, 0);
      const lastEventTarget = sample.label.endsWith("after-neutral-event")
        ? 0
        : 1;
      assert.ok(
        sample.dom.nodes <=
          cleared.dom.nodes + lastEventTarget * oneChatNodes + 64,
        "repeated teardown must not accumulate detached DOM",
      );
      assert.ok(
        sample.dom.jsEventListeners <=
          cleared.dom.jsEventListeners + lastEventTarget * oneChatListeners + 8,
        "repeated teardown must not accumulate listeners",
      );
      assert.ok(
        sample.bytes - unmounted[0].bytes < 8 * 1024 * 1024,
        "repeated teardown must not accumulate heap",
      );
    }
  }
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.httpServer.close(done));
}
