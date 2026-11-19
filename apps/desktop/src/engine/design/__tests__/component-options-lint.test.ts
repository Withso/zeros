import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDesignFrame, DESIGN_DIRECTORY_NAME, lintDesignDocument, readDesignWorkspaceSnapshot } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";

const doc = (body: string, head = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;
const options = (lines: string[]) => `<template data-zd-options>\n${lines.join("\n")}\n</template>`;

describe("linting components with options", () => {
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
    (await lintDesignDocument(root, file, { healOids: false, includeRuntimeAudits: false })).violations.filter((violation) => violation.ruleId.startsWith("component"));

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-component-lint-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("warns that a frame declaring options is not registered, and says how to register it", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await write(frame.file, doc('<div data-oid="c">x</div>', options(['<zd-option name="width" type="number" default="1"></zd-option>'])));
    expect(await lint(frame.file)).toEqual([expect.objectContaining({
      ruleId: "component-unregistered",
      severity: "warning",
      message: "This frame declares options but is not registered as a component, so no other frame can place it.",
      fix: expect.stringContaining('"component": "chat-composer"'),
    })]);
    await register(frame.file, "chat-composer");
    expect(await lint(frame.file)).toEqual([]);
  });

  it("reports an instance value that does not fit at the instance", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(main.file, doc('<div data-oid="c">x</div>', options(['<zd-option name="width" type="number" default="1120" min="640" max="1440"></zd-option>'])));
    await register(main.file, "chat-composer");
    await write(host.file, doc('<p data-oid="p">a</p>\n<zd-chat-composer data-oid="ws" width="9000"></zd-chat-composer>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({
      ruleId: "component-value-invalid", severity: "error", oid: "ws", line: 2,
      message: "width must be a number from 640 to 1440; 9000 does not fit.",
    })]);
  });

  it("reports a declaration problem in another file with that file and line", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(main.file, doc('<div data-oid="c">x</div>', `\n${options(['<zd-option name="class" type="text" default=""></zd-option>'])}`));
    await register(main.file, "chat-composer");
    await write(host.file, doc('<zd-chat-composer data-oid="ws"></zd-chat-composer>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({
      ruleId: "component-option-invalid", oid: "ws",
      message: `${main.file}, line 3: class is reserved and cannot name an option.`,
    })]);
    expect(await lint(main.file)).toEqual([expect.objectContaining({ ruleId: "component-option-invalid", line: 3, message: "class is reserved and cannot name an option." })]);
  });

  it("reports a broken expression in a main frame where it is written", async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    await write(main.file, doc('<div data-oid="c">\n<p data-oid="p">{{ width-1 }}</p></div>', options(['<zd-option name="width" type="number" default="1"></zd-option>'])));
    await register(main.file, "chat-composer");
    expect(await lint(main.file)).toEqual([expect.objectContaining({
      ruleId: "component-expression-invalid", line: 4,
      message: 'Unknown name width-1. To subtract, put spaces around the minus: "width - 1".',
    })]);
  });

  it("warns at the instance about an attribute that names no option, with the value it ignores", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(main.file, doc('<div data-oid="c">x</div>', options(['<zd-option name="mood" type="text" default="calm"></zd-option>'])));
    await register(main.file, "chip");
    await write(host.file, doc('<zd-chip data-oid="ws" tone="loud" class="x" data-note="n"></zd-chip>'));
    expect(await lint(host.file)).toEqual([expect.objectContaining({
      ruleId: "component-value-invalid", severity: "warning", oid: "ws",
      message: 'This component has no option tone; tone="loud" is ignored.',
    })]);
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((frame) => frame.file === host.file)!;
    expect(listed.instances?.hosts.ws).toEqual({ component: "chip", attributes: {}, ignored: { tone: "loud" } });
  });

  it("warnings keep the class list: an ignored attribute does not turn off unknown-class lint", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(main.file, doc('<div data-oid="c">x</div>', options(['<zd-option name="mood" type="text" default="calm"></zd-option>'])));
    await register(main.file, "chip");
    await write(host.file, doc('<p data-oid="p" class="no-such-class">a</p><zd-chip data-oid="ws" tone="loud"></zd-chip>'));
    const violations = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(violations).toContainEqual(expect.objectContaining({ ruleId: "component-value-invalid", severity: "warning" }));
    expect(violations).toContainEqual(expect.objectContaining({ ruleId: "unknown-class", oid: "p", message: 'Class "no-such-class" has no CSS in this frame\'s styles.' }));
  });

  it("an error in a component still skips class lint, whose CSS it could not supply", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(main.file, doc('<div data-oid="c">x</div>', options(['<zd-option name="width" type="number" default="1" min="0" max="2"></zd-option>'])));
    await register(main.file, "chip");
    await write(host.file, doc('<p data-oid="p" class="no-such-class">a</p><zd-chip data-oid="ws" width="9"></zd-chip>'));
    const violations = (await lintDesignDocument(root, host.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(violations).toContainEqual(expect.objectContaining({ ruleId: "component-value-invalid", severity: "error" }));
    expect(violations.filter((violation) => violation.ruleId === "unknown-class")).toEqual([]);
  });

  it("option custom properties are known tokens in the main that declares them", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    await write(main.file, doc(
      '<div data-oid="c" style="width: var(--zd-width); color: var(--zd-accent); transition: opacity var(--zd-motion-duration) var(--zd-motion-easing); margin: var(--zd-half)">x</div>',
      options([
        '<zd-option name="width" type="number" default="10" unit="px"></zd-option>',
        '<zd-option name="accent" type="color" default="#3b82f6"></zd-option>', // check:ui ignore-line -- authored option colour fixture.
        '<zd-option name="motion" type="easing" default="ease-out 200ms"></zd-option>',
        '<zd-derive name="half" value="width / 2" unit="px"></zd-derive>',
      ])));
    await register(main.file, "chip");
    const violations = (await lintDesignDocument(root, main.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(violations.filter((violation) => violation.ruleId === "unknown-token")).toEqual([]);
  });

  it("a text option's custom property stays unknown: text never reaches CSS", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    await write(main.file, doc('<div data-oid="c" style="content: var(--zd-label)">{{ label }}</div>',
      options(['<zd-option name="label" type="text" default="Hi"></zd-option>'])));
    await register(main.file, "chip");
    const violations = (await lintDesignDocument(root, main.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(violations.filter((violation) => violation.ruleId === "unknown-token").map((violation) => violation.message)).toEqual(['Unknown design token "--zd-label".']);
  });

  it("a class built from a template hole is not split into unknown classes", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    await write(main.file, doc(
      '<span data-oid="b" class="badge badge--soft badge--{{ tone }} {{tone}}-x no-such-class">x</span>',
      '<style>.badge, .badge--success, .badge--soft { color: inherit; }</style>' +
        options(['<zd-option name="tone" type="choice" choices="success danger" default="success"></zd-option>']),
    ));
    await register(main.file, "chip");
    const violations = (await lintDesignDocument(root, main.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(violations.filter((violation) => violation.ruleId === "unknown-class").map((violation) => violation.message))
      .toEqual(['Class "no-such-class" has no CSS in this frame\'s styles.']);
  });

  it("a token named in text or a comment is not an unknown token", async () => {
    const frame = await createDesignFrame(root, { title: "Prose" });
    await write(frame.file, doc(
      '<p data-oid="p">Write <code data-oid="c">var(--gap-xl)</code> in the CSS.</p><!-- var(--gap-comment) --><div data-oid="d" style="gap: var(--gap-inline)"></div>',
      '<style>.x { gap: var(--gap-style); }</style>',
    ));
    const violations = (await lintDesignDocument(root, frame.file, { healOids: false, includeRuntimeAudits: false })).violations;
    expect(violations.filter((violation) => violation.ruleId === "unknown-token").map((violation) => violation.message).sort())
      .toEqual(['Unknown design token "--gap-inline".', 'Unknown design token "--gap-style".']);
  });
  it("body declaration warns: an options template outside <head> is not read", async () => {
    const main = await createDesignFrame(root, { title: "Chip" });
    await write(main.file, doc(`<div data-oid="c">x</div>\n${options(['<zd-option name="width" type="number" default="1"></zd-option>'])}`));
    await register(main.file, "chip");
    expect(await lint(main.file)).toEqual([expect.objectContaining({
      ruleId: "component-option-invalid", severity: "warning", line: 2,
      message: "Options are read only from <head>; move this <template data-zd-options> into <head>.",
    })]);
  });
  it("refuses a name registered twice, or also used by a components/ file", async () => {
    const a = await createDesignFrame(root, { title: "A" });
    const b = await createDesignFrame(root, { title: "B" });
    await register(a.file, "card");
    await register(b.file, "card");
    expect(await lint(a.file)).toEqual([expect.objectContaining({ ruleId: "component-invalid", message: `zd-card is registered by 2 frames (${[a.file, b.file].sort().join(", ")}); each component needs its own name.` })]);
    await register(b.file, "badge");
    await write("components/badge.html", doc('<b data-zid="b">B</b>'));
    expect(await lint(b.file)).toEqual([expect.objectContaining({ ruleId: "component-invalid", message: `zd-badge is both this frame's registration and components/badge.html; rename one.` })]);
  });
});
