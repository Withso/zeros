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
      .filter((violation) => violation.ruleId.startsWith("component-control") || violation.ruleId === "component-instance-override");
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
    await write(host.file, doc('<p data-oid="p">a</p>\n<zd-badge data-oid="i1" style="height: 40px; left: 4px"></zd-badge>'));
    expect(await lint(host.file)).toEqual([]);
    await write(host.file, doc('<p data-oid="p">a</p>\n<zd-badge data-oid="i1" style="width: 40px; border-radius: 0" zd-style-DOT="background: blue; margin: 0"></zd-badge>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({
      ruleId: "component-control-shadowed", severity: "warning", oid: "i1", line: 2,
      message: "This instance sets width, border-radius, background on dot over Radius, Tone.",
    }), expect.objectContaining({ ruleId: "component-instance-override", oid: "i1", message: "This instance overrides margin on dot, which no control sets." })]);
  });

  it("compares properties by the longhands they set: a corner over a bound radius, a colour over a bound background", async () => {
    const file = await main(
      '<span data-oid="b" class="badge" style="border-top-left-radius: 2px"><i data-oid="dot" class="dot"></i>x</span>',
      [round, tone],
      ".badge { border-radius: calc(var(--zd-radius) * 1px) } .badge[data-tone=\"danger\"] .dot { background: red }",
    );
    await write(file, doc('<span data-oid="b" class="badge" data-tone="{{ tone }}" style="border-top-left-radius: 2px"><i data-oid="dot" class="dot"></i>x</span>',
      `${options([round, tone])}<style>.badge { border-radius: calc(var(--zd-radius) * 1px); gap: var(--zd-radius) } .badge[data-tone="danger"] .dot { background: red }</style>`));
    expect(await lint(file)).toEqual([expect.objectContaining({ ruleId: "component-control-shadowed", oid: "b",
      message: "border-top-left-radius on this layer sits over Radius." })]);
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(host.file, doc('<zd-badge data-oid="i1" style="row-gap: 4px" zd-style-dot="background-color: blue"></zd-badge>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({ ruleId: "component-control-shadowed", oid: "i1",
      message: "This instance sets row-gap, background-color on dot over Radius, Tone." })]);
  });

  it("warns about an instance's size over a bound axis, and separately about overrides no control sets, never its place", async () => {
    const main = await createDesignFrame(root, { title: "Text field" });
    await write(main.file, await readFile(path.join(DEMO, "text-field.html"), "utf8"));
    await register(main.file, "text-field");
    const host = await createDesignFrame(root, { title: "Settings" });
    await write(host.file, doc('<p data-oid="p">a</p>\n<zd-text-field data-oid="tf1" width="40" style="width: 200px; opacity: 0.5; left: 10px" zd-style-tf-label="color: red"></zd-text-field>'));
    const found = await lint(host.file);
    expect(found).toEqual([
      expect.objectContaining({ ruleId: "component-control-shadowed", severity: "warning", oid: "tf1", line: 2,
        message: "This instance sets width over Width." }),
      expect.objectContaining({ ruleId: "component-instance-override", severity: "warning", oid: "tf1", line: 2,
        message: "This instance overrides opacity, color on tf-label, which no control sets.",
        fix: "Make it a control on the main, or remove it (Reset in its Controls)." }),
    ]);
    expect(JSON.stringify(found)).not.toContain("left");
    // Its place, an unbound axis and the control itself are its own.
    await write(host.file, doc('<zd-text-field data-oid="tf1" width="40" style="left: 10px; top: 4px; height: 40px; min-height: 20px"></zd-text-field>'));
    expect(await lint(host.file)).toEqual([]);
    // A limit on the bound axis clamps the control.
    await write(host.file, doc('<zd-text-field data-oid="tf1" width="40" style="max-width: 120px"></zd-text-field>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({ ruleId: "component-control-shadowed", message: "This instance sets max-width over Width." })]);
  });

  it("finds nothing to warn about in frames that place the demo components by their controls", async () => {
    const names = (await readdir(DEMO)).filter((name) => name.endsWith(".html")).map((name) => name.replace(/\.html$/, ""));
    for (const name of names) {
      const frame = await createDesignFrame(root, { title: name });
      await write(frame.file, await readFile(path.join(DEMO, `${name}.html`), "utf8"));
      await register(frame.file, name);
    }
    const host = await createDesignFrame(root, { title: "Gallery" });
    await write(host.file, doc(names.map((name, index) =>
      `<zd-${name} data-oid="i-${name}" style="position: absolute; left: ${index * 10}px; top: 8px${name === "text-field" ? "" : "; width: 240px"}"></zd-${name}>`).join("\n")));
    expect(await lint(host.file)).toEqual([]);
  });

  it("reports overrides on an instance of a main that declares no controls", async () => {
    const frame = await createDesignFrame(root, { title: "Card" });
    await write(frame.file, doc('<div data-oid="card" class="card"><h2 data-oid="card-title">Plans</h2></div>', "<style>.card { padding: 8px }</style>"));
    await register(frame.file, "card");
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(host.file, doc('<zd-card data-oid="c1" style="left: 4px; opacity: 0.5" zd-style-card-title="color: red"></zd-card>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({ ruleId: "component-instance-override", oid: "c1",
      message: "This instance overrides opacity, color on card-title, which no control sets." })]);
  });

  it("re-lints an instance's frame when only its main changes", async () => {
    const file = await main('<span data-oid="b" class="badge">x</span>', [round], ".badge { border-radius: 4px }");
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(host.file, doc('<zd-badge data-oid="i1" style="border-radius: 0"></zd-badge>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({ ruleId: "component-instance-override", oid: "i1" })]);
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
