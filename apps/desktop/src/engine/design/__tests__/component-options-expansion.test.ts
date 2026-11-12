import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { expandDesignComponents, expandDesignComponentsForRender, expandDesignComponentsHtml } from "../components";
import { designComponentRenderBytesForTests, forgetDesignComponentRender, resetDesignComponentRendersForTests } from "../component-last-good";
import { captureDurableDesignDependencies } from "../dependency-read-set";
import { designDirectoryNameFor } from "../directory-registry";
import { createDesignFrame, DESIGN_DIRECTORY_NAME, prepareDesignNavigationFrames, prepareRegisteredDesignFrameParts, readDesignFrame,
  readDesignNavigationSnapshot } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { resetDesignIdentityCacheForTests } from "../identity-cache";
import { designDirectoryEntry } from "../metadata";
import { configureDesignPreparationWorkersForTests, designPreparationWorkerStatsForTests, stopDesignPreparationWorkers } from "../preparation-pool";
import { readDesignProtocolResource } from "../protocol-resource";
import { composeDesignThumbnailBatches } from "../thumbnail-batch";

const doc = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const options = (lines: string) => `<template data-zd-options>\n${lines}\n</template>`;

const COMPOSER = doc(
  '<div class="composer" data-oid="cc-root" data-density="{{ density }}">' +
    '<span class="chip" data-oid="cc-chip" data-zd-for="i in range(attachments)">File {{ i + 1 }}</span>' +
    '<button class="send" data-oid="cc-send" data-zd-if="toolbar">{{ send-label }}</button></div>',
  '<link rel="stylesheet" href="../tokens.css" /><link rel="stylesheet" href="chat.css" />' +
    options([
      '<zd-option name="width" type="number" default="1120" min="640" max="1440" unit="px"></zd-option>',
      '<zd-option name="attachments" type="number" default="2" min="0" max="4"></zd-option>',
      '<zd-option name="density" type="choice" choices="compact comfortable" default="comfortable"></zd-option>',
      '<zd-option name="toolbar" type="boolean" default="true"></zd-option>',
      '<zd-option name="accent" type="color" default="var(--blue-primary)"></zd-option>',
      '<zd-option name="send-label" type="text" default="Send"></zd-option>',
      '<zd-variant name="compact" width="800" density="compact"></zd-variant>',
    ].join("\n")) +
    '<style>.composer { width: var(--zd-width); background: url("../assets/bg.png"); }</style>',
);
const registry = new Map([["chat-composer", "chat/composer.html"]]);
const expand = (frame: string, sources: Record<string, string>, entry = "home/index.html", extra: { registry?: Map<string, string> } = { registry }) =>
  expandDesignComponents("/work/options", frame, sources, entry, extra);

describe("an instance of a component with options", () => {
  it("renders its template with its values and sets every CSS option in one rule", async () => {
    const result = await expand(doc('<zd-chat-composer data-oid="ws" zd-variant="compact" attachments="1" toolbar="false"></zd-chat-composer>'), {
      "chat/composer.html": COMPOSER,
    });
    expect(result.errors).toEqual([]);
    expect(result.usedComponents).toEqual(["chat-composer"]);
    expect(result.html).toContain(
      '<zd-chat-composer data-oid="ws" zd-variant="compact" attachments="1" toolbar="false" data-zd-instance="1">' +
        '<div class="composer" data-zd-part="cc-root" data-density="compact"><span class="chip" data-zd-part="cc-chip">File 1</span></div></zd-chat-composer>',
    );
    expect(result.html).toContain('<style data-zeros-options>:where([data-zd-instance="1"]) { --zd-width: 800px; --zd-attachments: 1; --zd-accent: var(--blue-primary); }</style>');
  });

  it("carries the component's linked stylesheets, and rebases its URLs from its own file", async () => {
    const result = await expand(doc('<zd-chat-composer data-oid="ws"></zd-chat-composer>', '<link rel="stylesheet" href="../tokens.css" />'), {
      "chat/composer.html": COMPOSER,
    });
    // tokens.css is already linked by the frame; chat.css is added once, rebased from chat/ to home/.
    expect(result.html.match(/href="\.\.\/tokens\.css"/g)).toHaveLength(1);
    expect(result.html).toContain('<link rel="stylesheet" href="../chat/chat.css" data-zeros-component="chat-composer">');
    expect(result.html).toContain('url("../assets/bg.png")');
  });

  it("keeps nested instances' values apart, even for options with the same name", async () => {
    const card = doc('<div data-zid="card"><zd-badge data-zid="inner"></zd-badge></div>', options('<zd-option name="width" type="number" default="300" unit="px"></zd-option>'));
    const badge = doc('<b data-zid="badge">B</b>', options('<zd-option name="width" type="number" default="24" unit="px"></zd-option>'));
    const result = await expand(doc('<zd-card data-oid="c" width="320"></zd-card>'), { "components/card.html": card, "components/badge.html": badge }, "home/index.html", {});
    expect(result.errors).toEqual([]);
    expect(result.html).toContain(':where([data-zd-instance="1"]) { --zd-width: 320px; }');
    // The inner badge, at its default, sets its own width rather than inheriting 320px.
    expect(result.html).toContain(':where([data-zd-instance="2"]) { --zd-width: 24px; }');
    expect(result.html).toContain('<zd-badge data-zd-part="inner" data-zd-instance="2"><b data-zd-part="badge">B</b></zd-badge>');
  });

  it("keeps the inherited value of an attribute that does not fit, and says so", async () => {
    const result = await expand(doc('<zd-chat-composer data-oid="ws" width="9000" density="huge"></zd-chat-composer>'), { "chat/composer.html": COMPOSER });
    expect(result.optionsFailed).toBe(true);
    expect(result.errors).toEqual([
      expect.objectContaining({ component: "chat-composer", code: "component-value-invalid", message: "width must be a number from 640 to 1440; 9000 does not fit." }),
      expect.objectContaining({ component: "chat-composer", code: "component-value-invalid", message: 'density must be one of compact or comfortable; "huge" does not fit.' }),
    ]);
    expect(result.html).toContain("--zd-width: 1120px;");
  });

  it("renders the defaults when its values break the template, and nothing when the defaults do too", async () => {
    const fragile = doc('<p data-zid="p">{{ 100 / count }}</p>', options('<zd-option name="count" type="number" default="4"></zd-option>'));
    const broken = doc('<p data-zid="p">{{ missing }}</p>', options('<zd-option name="count" type="number" default="4"></zd-option>'));
    const result = await expand(doc('<zd-fragile data-oid="f" count="0"></zd-fragile><zd-broken data-oid="b"></zd-broken>'),
      { "components/fragile.html": fragile, "components/broken.html": broken }, "home/index.html", {});
    expect(result.optionsFailed).toBe(true);
    expect(result.html).toContain('<zd-fragile data-oid="f" count="0" data-zd-instance="2"><p data-zd-part="p">25</p></zd-fragile>');
    expect(result.html).toContain('<zd-broken data-oid="b" data-zd-instance="1"></zd-broken>');
    expect(result.errors.map((error) => [error.component, error.code, error.message])).toEqual([
      ["broken", "component-expression-invalid", "Unknown name missing."],
      ["fragile", "component-expression-invalid", "Division by zero."],
    ]);
  });

  it("reports a declaration that cannot hold, with its place in the component file", async () => {
    const bad = doc("<p>x</p>", options('<zd-option name="class" type="text" default=""></zd-option>'));
    const result = await expand(doc('<zd-bad data-oid="b"></zd-bad>'), { "components/bad.html": bad }, "home/index.html", {});
    expect(result.errors).toEqual([expect.objectContaining({
      component: "bad", code: "component-option-invalid", file: "components/bad.html", message: "class is reserved and cannot name an option.",
    })]);
    expect(result.errors[0]!.offset).toBe(bad.indexOf("<zd-option"));
  });

  it("asks for a closing tag on each declaration", async () => {
    const unclosed = doc("<p>x</p>", options('<zd-option name="a" type="text" default="" /><zd-option name="b" type="text" default="" />'));
    const result = await expand(doc('<zd-u data-oid="u"></zd-u>'), { "components/u.html": unclosed }, "home/index.html", {});
    expect(result.errors).toContainEqual(expect.objectContaining({ code: "component-option-invalid", message: "Close each <zd-option> with </zd-option>; it cannot hold other elements." }));
  });
});

describe("a frame registered as a component", () => {
  it("is not found under a name it does not register", async () => {
    const result = await expand(doc('<zd-chat-composer data-oid="ws"></zd-chat-composer>'), { "chat/composer.html": COMPOSER }, "home/index.html", {});
    expect(result.usedComponents).toEqual([]);
  });

  it("cannot share its name with a components/ file", async () => {
    const result = await expand(doc('<zd-chat-composer data-oid="ws"></zd-chat-composer>'), {
      "chat/composer.html": COMPOSER,
      "components/chat-composer.html": doc("<p>legacy</p>"),
    });
    expect(result.errors).toEqual([expect.objectContaining({
      component: "chat-composer", code: "component-invalid",
      message: "zd-chat-composer is both a registered frame (chat/composer.html) and components/chat-composer.html; rename one.",
    })]);
  });

  it("renders itself with its defaults as a main frame, marking repeats after the first", async () => {
    const result = await expand(COMPOSER, {}, "chat/composer.html");
    expect(result.errors).toEqual([]);
    expect(result.html).toContain(
      '<div class="composer" data-oid="cc-root" data-density="comfortable"><span class="chip" data-oid="cc-chip">File 1</span>' +
        '<span class="chip" data-zd-copy="cc-chip#1">File 2</span><button class="send" data-oid="cc-send">Send</button></div>',
    );
    expect(result.html).toContain("<style data-zeros-options>:root { --zd-width: 1120px; --zd-attachments: 2; --zd-accent: var(--blue-primary); }</style>");
    // The declaration stays in the file, inert.
    expect(result.html).toContain("<template data-zd-options>");
    expect(await expandDesignComponentsHtml("/work/options", COMPOSER, {}, "chat/composer.html", { registry })).toBe(result.html);
  });

  it("shows a variant on the main frame when asked", async () => {
    const result = await expandDesignComponents("/work/options", COMPOSER, {}, "chat/composer.html", { registry, variant: "compact" });
    expect(result.html).toContain('data-density="compact"');
    expect(result.html).toContain("--zd-width: 800px;");
  });
});

describe("a frame whose options stop applying", () => {
  const good = doc('<zd-chat-composer data-oid="ws" width="800"></zd-chat-composer>');
  const bad = doc('<zd-chat-composer data-oid="ws" width="9000"></zd-chat-composer>');
  const sources = { "chat/composer.html": COMPOSER };
  const render = (frame: string, remember: boolean, file = "home/index.html") =>
    expandDesignComponentsForRender("/work/options", frame, sources, file, { registry }, remember);
  beforeEach(() => resetDesignComponentRendersForTests());

  it("shows this session's last good render, and says so", async () => {
    const first = await render(good, true);
    expect(first.componentOptions).toBeUndefined();
    const failing = await render(bad, false);
    expect({ html: failing.html, componentOptions: failing.componentOptions }).toEqual({ html: first.html, componentOptions: { applied: false, shows: "last-good" } });
    // The frame's instances are still named, whichever render it shows.
    expect(Object.keys(failing.instances?.hosts ?? {})).toEqual(["ws"]);
  });

  it("shows the component's defaults when this session has no good render, and says so", async () => {
    // An identity-only read of the good frame does not count as a render.
    await render(good, false);
    const failing = await render(bad, true);
    expect(failing.componentOptions).toEqual({ applied: false, shows: "defaults" });
    expect(failing.html).toContain("--zd-width: 1120px;");
  });

  it("never stores a read that used the last good render as a durable identity", async () => {
    await render(good, true);
    const served = await captureDurableDesignDependencies(() => render(bad, false));
    expect(served.value.componentOptions?.shows).toBe("last-good");
    expect(served.durable).toBeNull();
    expect(served.current()).toBe(true);
    forgetDesignComponentRender("/work/options", "home/index.html");
    expect(served.current()).toBe(false);
    const defaults = await captureDurableDesignDependencies(() => render(bad, false));
    expect(defaults.value.componentOptions?.shows).toBe("defaults");
  });

  it("keeps a bounded number of frames within a byte cap", async () => {
    for (let index = 0; index < 20; index += 1) await render(good, true, `home/f${index}.html`);
    expect(designComponentRenderBytesForTests().frames).toBe(12);
    expect((await render(bad, false, "home/f0.html")).componentOptions?.shows).toBe("defaults");
    expect((await render(bad, false, "home/f19.html")).componentOptions?.shows).toBe("last-good");
  });

  it("stores nothing for a frame without options or templated components", async () => {
    await render(doc('<zd-plain data-oid="p"></zd-plain>'), true);
    expect(designComponentRenderBytesForTests().frames).toBe(0);
  });
});

describe("the work one frame's options may take", () => {
  it("shares one repeat budget across every instance", async () => {
    const loop = doc('<i data-zid="i" data-zd-for="n in range(count)">.</i>', options('<zd-option name="count" type="number" default="1" min="0" max="256"></zd-option>'));
    const frame = doc(Array.from({ length: 20 }, (_, index) => `<zd-loop data-oid="l${index}" count="256"></zd-loop>`).join(""));
    const result = await expand(frame, { "components/loop.html": loop }, "home/index.html", {});
    expect(result.optionsFailed).toBe(true);
    expect(result.errors.some((error) => error.code === "component-expression-invalid" && /4,096 repeats/.test(error.message))).toBe(true);
    // Instances past the budget fall back to their defaults, which also fit no longer, and render empty.
    expect(Buffer.byteLength(result.html)).toBeLessThan(2 * 1024 * 1024);
  });
});

describe("a frame whose options stop applying, prepared on preparation workers", () => {
  const MAIN = `<!doctype html><html><head><title>Chip</title>
<template data-zd-options>
<zd-option name="label" type="text" default="Send"></zd-option>
<zd-option name="width" type="number" default="120" unit="px"></zd-option>
<zd-variant name="wide" width="240"></zd-variant>
</template>
<style>.c { width: var(--zd-width); }</style></head>
<body><div class="c" data-oid="root"><i data-oid="new">added</i><b data-oid="b">{{ label }}</b></div></body></html>`;
  const BROKEN = MAIN.replace("{{ label }}", "{{ missing }}");
  const HOST = '<!doctype html><html><head></head><body><main data-oid="m"><zd-chip data-oid="i" label="Go"></zd-chip></main></body></html>';
  const PLAIN = '<!doctype html><html><head></head><body><p data-oid="p">plain</p></body></html>';

  let bundle: { directory: string; url: URL };
  let root: string;
  let folder: string;
  let main: string;
  let files: string[];
  beforeAll(async () => {
    const cache = path.resolve(__dirname, "../../../../../../node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const directory = await mkdtemp(path.join(cache, "zeros-preparation-worker-"));
    const outfile = path.join(directory, "preparation-worker.mjs");
    await build({
      entryPoints: [path.join(__dirname, "../preparation-worker.ts")],
      bundle: true, platform: "node", format: "esm", target: "node22", outfile, logLevel: "error",
      external: ["better-sqlite3", "node-pty", "bun:sqlite", "fsevents", "@tailwindcss/oxide", "lightningcss", "*.node"],
      banner: { js: 'import { createRequire as __workerRequire } from "node:module"; const require = __workerRequire(import.meta.url);' },
    });
    bundle = { directory, url: pathToFileURL(outfile) };
  }, 120_000);
  afterAll(async () => { await rm(bundle.directory, { recursive: true, force: true }); });
  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    resetDesignIdentityCacheForTests();
    configureDesignPreparationWorkersForTests(0);
    root = await mkdtemp(path.join(tmpdir(), "zeros-options-workers-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    folder = path.join(root, DESIGN_DIRECTORY_NAME);
    const created = [await createDesignFrame(root, { title: "Chip" }), await createDesignFrame(root, { title: "Host" }),
      await createDesignFrame(root, { title: "Plain" })];
    files = created.map(({ file }) => file);
    main = files[0]!;
    await writeFile(path.join(folder, files[0]!), MAIN);
    await writeFile(path.join(folder, files[1]!), HOST);
    await writeFile(path.join(folder, files[2]!), PLAIN);
    const canvas = await readCanvas(root);
    canvas.frame_info[main] = { ...canvas.frame_info[main]!, component: "chip" } as never;
    await writeCanvas(root, canvas);
  });
  afterEach(async () => {
    configureDesignPreparationWorkersForTests(null);
    await stopDesignPreparationWorkers();
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  const prepare = async (order = files) => {
    const prepared = await prepareDesignNavigationFrames(root, (await readDesignNavigationSnapshot(root)).catalogRevision, order);
    expect(prepared.errors).toEqual([]);
    return new Map(prepared.frames.map((frame) => [frame.file, frame]));
  };
  const served = async (file: string, sourceVersion: string, variant?: string) =>
    (await readDesignProtocolResource(root, { path: file, sourceVersion, ...(variant ? { variant } : {}) })).status;
  const onWorkers = () => configureDesignPreparationWorkersForTests(3, { workerUrl: bundle.url });
  /** Every frame's reported version is the one its document is served at. */
  const expectServedAsPrepared = async (prepared: Map<string, { sourceVersion?: string }>) => {
    for (const file of files) expect({ file, status: await served(file, prepared.get(file)!.sourceVersion!) }).toEqual({ file, status: 200 });
  };

  it("reports the generation the engine serves when the engine holds the last good render", async () => {
    await readDesignFrame(root, main);
    await readDesignFrame(root, files[1]!);
    await writeFile(path.join(folder, main), BROKEN);
    onWorkers();
    const before = designPreparationWorkerStatsForTests().frames;
    const prepared = await prepare();
    expect(designPreparationWorkerStatsForTests().frames - before).toBeGreaterThan(0);
    expect(prepared.get(main)!.component?.notApplied).toBe("last-good");
    expect(prepared.get(files[1]!)!.instances?.notApplied).toBe("last-good");
    await expectServedAsPrepared(prepared);
    const parts = await prepareRegisteredDesignFrameParts(root, main, await readCanvas(root));
    expect(parts.render.sourceVersion).toBe(prepared.get(main)!.sourceVersion);
  }, 60_000);

  it("keeps the last good render a worker composed, for the engine to show and serve", async () => {
    onWorkers();
    const good = await prepare();
    const input = { workspaceId: "w", directoryId: designDirectoryEntry(root, designDirectoryNameFor(root))!.id, theme: null,
      colorScheme: "light" as const, maxDimension: 256, frames: files.map((file) => ({ file, sourceVersion: good.get(file)!.sourceVersion! })) };
    const composed = designPreparationWorkerStatsForTests().composed;
    expect((await composeDesignThumbnailBatches(root, input as never)).failed).toEqual([]);
    expect(designPreparationWorkerStatsForTests().composed - composed).toBeGreaterThan(0);
    await writeFile(path.join(folder, main), BROKEN);
    resetDesignIdentityCacheForTests();
    const prepared = await prepare();
    expect(prepared.get(main)!.component?.notApplied).toBe("last-good");
    await expectServedAsPrepared(prepared);
  }, 60_000);

  it("agrees on whichever worker prepares it, and after the workers restart", async () => {
    await readDesignFrame(root, main);
    await writeFile(path.join(folder, main), BROKEN);
    onWorkers();
    const versions = new Set<string>();
    // Each worker takes the batch's next frame in turn, so the main lands on each of the three.
    for (const order of [files, [files[1]!, main, files[2]!], [files[1]!, files[2]!, main]]) {
      resetDesignIdentityCacheForTests();
      const prepared = await prepare(order);
      versions.add(prepared.get(main)!.sourceVersion!);
      await expectServedAsPrepared(prepared);
    }
    await stopDesignPreparationWorkers();
    resetDesignIdentityCacheForTests();
    const restarted = await prepare();
    versions.add(restarted.get(main)!.sourceVersion!);
    await expectServedAsPrepared(restarted);
    expect(versions.size).toBe(1);
  }, 60_000);

  it("serves a variant of a main whose options do not apply under the generation it reports", async () => {
    await readDesignFrame(root, main);
    await writeFile(path.join(folder, main), BROKEN);
    onWorkers();
    const prepared = await prepare();
    expect(await served(main, prepared.get(main)!.sourceVersion!, "wide")).toBe(200);
  }, 60_000);

  it("refuses an old generation of a frame that changed again, and serves the new one it then reports", async () => {
    await readDesignFrame(root, main);
    await writeFile(path.join(folder, main), BROKEN);
    onWorkers();
    const first = (await prepare()).get(main)!.sourceVersion!;
    expect(await served(main, first)).toBe(200);
    await writeFile(path.join(folder, main), BROKEN.replace(">added<", ">added again<"));
    expect(await served(main, first)).toBe(409);
    const prepared = await prepare();
    expect(prepared.get(main)!.sourceVersion).not.toBe(first);
    await expectServedAsPrepared(prepared);
  }, 60_000);
});
