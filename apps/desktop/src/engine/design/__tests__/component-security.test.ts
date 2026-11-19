import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designComponentRecordLimitMessage, designFramesPrepareReplySchema } from "@zeros/protocol/design-catalog";
import { resetDesignComponentRendersForTests } from "../component-last-good";
import { createDesignFrame, DESIGN_DIRECTORY_NAME, lintDesignDocument, prepareDesignNavigationFrames, readDesignFrame,
  readDesignNavigationSnapshot } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { resetDesignIdentityCacheForTests } from "../identity-cache";

// The code that reads and evaluates authored component options and templates.
const FILES = [
  "../../../../../../packages/design-core/src/component-expressions.ts",
  "../../../../../../packages/design-core/src/component-options.ts",
  "../../../../../../packages/design-web/src/component-options.ts",
  "../../../../../../packages/design-web/src/component-template.ts",
  "../component-registry.ts",
  "../component-last-good.ts",
];
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("component options run no authored code", () => {
  it.each(FILES)("%s has no eval, Function, dynamic import or host access", (file) => {
    const code = source(file);
    expect(code).not.toMatch(/\beval\s*\(/);
    expect(code).not.toMatch(/\bnew\s+Function\b|\bFunction\s*\(/);
    expect(code).not.toMatch(/\bimport\s*\(/);
    expect(code).not.toMatch(/\b(?:globalThis|window|process|require)\s*[.[(]/);
    expect(code).not.toMatch(/\bwith\s*\(/);
  });

  it.each(FILES)("%s builds no regular expression from authored text", (file) => {
    for (const match of source(file).matchAll(/new\s+RegExp\(([^;]*)\)/g)) {
      // Only patterns assembled from this module's own constants.
      expect(match[1], file).toMatch(/^`[^`]*\$\{DECIMAL\}[^`]*`$/);
    }
  });
});

describe("a component whose declaration is too large to report", () => {
  const main = (options: string, body = '<b data-oid="b">{{ label }}</b>') => `<!doctype html><html><head><title>Chip</title>
<template data-zd-options>
<zd-option name="label" type="text" default="Send"></zd-option>
${options}
</template></head>
<body><div data-oid="root">${body}</div></body></html>`;
  const PLAIN = '<!doctype html><html><head></head><body><p data-oid="p">plain</p></body></html>';
  const HOST = '<!doctype html><html><head></head><body><main data-oid="m"><zd-chip data-oid="i" label="Hi"></zd-chip></main></body></html>';
  const CASES: Array<[string, string, string, boolean]> = [
    ["more declaration elements than are reported", main(Array.from({ length: 160 }, (_, i) => `<zd-note data-i="${i}"></zd-note>`).join("")), "elements", true],
    ["a declaration element with a tag too long", main(`<zd-${"n".repeat(40)}></zd-${"n".repeat(40)}>`), "tag", true],
    ["a declaration element with more attributes than are reported",
      main(`<zd-option name="w" type="number" default="1" ${Array.from({ length: 70 }, (_, i) => `data-a${i}="x"`).join(" ")}></zd-option>`), "attributes", true],
    ["an attribute name too long", main(`<zd-option name="w" type="number" default="1" data-${"a".repeat(70)}="x"></zd-option>`), "attribute-name", true],
    ["a text default too long", main(`<zd-option name="long" type="text" default="${"x".repeat(2100)}"></zd-option>`), "attribute-value", true],
    ["a derived expression too long", main(`<zd-derive name="d" value="${"1 + ".repeat(525)}1"></zd-derive>`), "attribute-value", true],
    ["a bound layer id too long", main("", `<b data-oid="${"o".repeat(300)}">{{ label }}</b>`), "layer-id", false],
  ];
  let root: string;
  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    resetDesignIdentityCacheForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-component-limits-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
  });
  afterEach(async () => {
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it.each(CASES)("with %s is reported without its declaration, and says which limit", async (_name, source, limit, instancesToo) => {
    const created = [await createDesignFrame(root, { title: "Chip" }), await createDesignFrame(root, { title: "Plain" }),
      await createDesignFrame(root, { title: "Host" })];
    const [chip, plain, host] = created.map(({ file }) => file) as [string, string, string];
    const folder = path.join(root, DESIGN_DIRECTORY_NAME);
    await writeFile(path.join(folder, chip), source);
    await writeFile(path.join(folder, plain), PLAIN);
    await writeFile(path.join(folder, host), HOST);
    const canvas = await readCanvas(root);
    canvas.frame_info[chip] = { ...canvas.frame_info[chip]!, component: "chip" } as never;
    await writeCanvas(root, canvas);
    const reply = await prepareDesignNavigationFrames(root, (await readDesignNavigationSnapshot(root)).catalogRevision, [chip, plain, host]);
    // Every frame is prepared, and the reply is one the renderer accepts.
    expect(reply.errors).toEqual([]);
    expect(reply.frames.map(({ file }) => file).sort()).toEqual([chip, plain, host].sort());
    expect(designFramesPrepareReplySchema.safeParse(reply).error?.issues).toBeUndefined();
    const frame = (file: string) => reply.frames.find((candidate) => candidate.file === file)!;
    expect(frame(chip).component).toMatchObject({ elements: [], reach: {}, exceeds: limit });
    expect(frame(chip).component?.boundText).toBeUndefined();
    const placed = frame(host).instances?.components.chip;
    if (instancesToo) expect(placed).toMatchObject({ elements: [], reach: {}, exceeds: limit });
    else expect(placed?.exceeds).toBeUndefined();
    expect(frame(host).instances?.hosts.i?.component).toBe("chip");
    // The frame still renders.
    expect((await readDesignFrame(root, chip)).srcDoc).toContain('data-oid="root"');
    // design validate says the same.
    const lint = await lintDesignDocument(root, chip);
    expect(lint.violations).toContainEqual(expect.objectContaining({ ruleId: "component-option-invalid", message: designComponentRecordLimitMessage("chip", limit as never) }));
  }, 30_000);
});
