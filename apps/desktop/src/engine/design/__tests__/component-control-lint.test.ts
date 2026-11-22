import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDesignFrame, DESIGN_DIRECTORY_NAME, lintDesignDocument } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";

const DEMO = path.resolve(__dirname, "../../../../../../packages/design-web/src/__tests__/fixtures/demo-components");
const doc = (body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;
const options = (lines: string[]) => `<template data-zd-options>\n${lines.join("\n")}\n</template>`;
const tone = '<zd-option name="tone" label="Tone" type="choice" choices="info danger" default="info"></zd-option>';
const round = '<zd-option name="radius" label="Radius" type="number" default="8"></zd-option>';

describe("linting what changes a component from outside", () => {
  let root: string;
  const write = async (file: string, source: string) => {
    await mkdir(path.dirname(path.join(root, DESIGN_DIRECTORY_NAME, file)), { recursive: true });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, file), source);
  };
  const register = async (file: string, name: string) => {
    const canvas = await readCanvas(root);
    canvas.frame_info[file] = { ...canvas.frame_info[file]!, component: name } as never;
    await writeCanvas(root, canvas);
  };
  const lint = async (file: string) =>
    (await lintDesignDocument(root, file, { healOids: false, includeRuntimeAudits: false })).violations
      .filter((violation) => violation.ruleId.startsWith("component-control"));
  const main = async (body: string, declared: string[], style = "") => {
    const frame = await createDesignFrame(root, { title: "Badge" });
    await write(frame.file, doc(body, `${options(declared)}${style ? `<style>${style}</style>` : ""}`));
    await register(frame.file, "badge");
    return frame.file;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-control-lint-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("warns at its declaration about a control nothing in the main reads", async () => {
    const file = await main('<span data-oid="b">{{ tone }}</span>', [tone, '<zd-option name="idle" label="Idle" type="boolean" default="false"></zd-option>']);
    expect(await lint(file)).toEqual([expect.objectContaining({
      ruleId: "component-control-unread", severity: "warning", line: 3,
      message: "Control Idle is declared but nothing in the main reads it.",
      fix: expect.stringContaining("var(--zd-idle)"),
    })]);
  });

  it("warns about a main layer's own style over a property a control sets, but not a value that reads it", async () => {
    const file = await main(
      '<span data-oid="b" class="badge" style="border-radius: 2px; color: red">x</span>',
      [round],
      ".badge { border-radius: calc(var(--zd-radius) * 1px); color: blue } [data-oid=\"b\"] { border-radius: 4px }",
    );
    expect(await lint(file)).toEqual([expect.objectContaining({
      ruleId: "component-control-shadowed", severity: "warning", oid: "b",
      message: "border-radius on this layer sits over Radius.",
    })]);
    await write(file, doc('<span data-oid="b" class="badge" style="border-radius: calc(var(--zd-radius) * 2px)">x</span>',
      `${options([round])}<style>.badge { border-radius: calc(var(--zd-radius) * 1px) }</style>`));
    expect(await lint(file)).toEqual([]);
  });

  it("warns about an instance's own style and part overrides over bound properties, never its place and size", async () => {
    const file = await main(
      '<span data-oid="b" class="badge"><i data-oid="dot" class="dot"></i>x</span>',
      [round, tone],
      ".badge { border-radius: calc(var(--zd-radius) * 1px); width: calc(var(--zd-radius) * 4px) } .badge[data-tone=\"danger\"] .dot { background: red }",
    );
    await write(file, doc('<span data-oid="b" class="badge" data-tone="{{ tone }}"><i data-oid="dot" class="dot"></i>x</span>',
      `${options([round, tone])}<style>.badge { border-radius: calc(var(--zd-radius) * 1px); width: calc(var(--zd-radius) * 4px) } .badge[data-tone="danger"] .dot { background: red }</style>`));
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(host.file, doc('<p data-oid="p">a</p>\n<zd-badge data-oid="i1" style="width: 40px; left: 4px"></zd-badge>'));
    expect(await lint(host.file)).toEqual([]);
    await write(host.file, doc('<p data-oid="p">a</p>\n<zd-badge data-oid="i1" style="width: 40px; border-radius: 0" zd-style-DOT="background: blue; margin: 0"></zd-badge>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({
      ruleId: "component-control-shadowed", severity: "warning", oid: "i1", line: 2,
      message: "This instance sets border-radius, background on dot over Radius, Tone.",
    })]);
  });

  it("re-lints an instance's frame when only its main changes", async () => {
    const file = await main('<span data-oid="b" class="badge">x</span>', [round], ".badge { border-radius: 4px }");
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(host.file, doc('<zd-badge data-oid="i1" style="border-radius: 0"></zd-badge>'));
    expect(await lint(host.file)).toEqual([]);
    await write(file, doc('<span data-oid="b" class="badge">x</span>', `${options([round])}<style>.badge { border-radius: calc(var(--zd-radius) * 1px) }</style>`));
    expect(await lint(host.file)).toEqual([expect.objectContaining({ ruleId: "component-control-shadowed", oid: "i1" })]);
  });

  it("finds nothing to warn about in the demo components", async () => {
    const files = (await readdir(DEMO)).filter((name) => name.endsWith(".html"));
    expect(files).toHaveLength(10);
    for (const name of files) {
      const frame = await createDesignFrame(root, { title: name.replace(/\.html$/, "") });
      await write(frame.file, await readFile(path.join(DEMO, name), "utf8"));
      await register(frame.file, name.replace(/\.html$/, ""));
      expect({ name, violations: await lint(frame.file) }).toEqual({ name, violations: [] });
    }
  });
});
