import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDesignFrame, DESIGN_DIRECTORY_NAME, lintDesignDocument } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";

// Classes are global (a Design stylesheet) or a component's (its main's
// <style>): a frame defines none of its own, and a component's class is used
// only inside that component and its instances.
const doc = (body: string, head = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>T</title>${head}</head><body>${body}</body></html>`;

describe("class kinds in Design lint", () => {
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
  const lint = async (file: string, ruleId: string) =>
    (await lintDesignDocument(root, file, { healOids: false, includeRuntimeAudits: false })).violations.filter((violation) => violation.ruleId === ruleId);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-class-kinds-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("warns once when a frame's own <style> defines classes, naming them", async () => {
    const frame = await createDesignFrame(root, { title: "Pricing" });
    await write(frame.file, doc('<main data-oid="m" class="hero"><h1 data-oid="t" class="title">Hi</h1></main>',
      "<style>body { margin: 0; }\n.hero { padding: 8px; } .title, .eyebrow { font-weight: 600; } .note { color: inherit; }</style>"));
    expect(await lint(frame.file, "frame-class")).toEqual([expect.objectContaining({
      ruleId: "frame-class", severity: "warning", line: 1,
      message: "This frame defines its own classes .hero, .title, .eyebrow and 1 more; a class is global or a component's.",
      fix: expect.stringContaining("Design stylesheet"),
    })]);
  });

  it("leaves a main's classes, element and :root rules, linked stylesheets and captured frames alone", async () => {
    await write("styles.css", ".card { padding: 8px; }\n");
    const main = await createDesignFrame(root, { title: "Chip" });
    await write(main.file, doc('<span data-oid="c" class="chip">x</span>', "<style>.chip { padding: 2px; }</style>"));
    await register(main.file, "chip");
    expect(await lint(main.file, "frame-class")).toEqual([]);
    const plain = await createDesignFrame(root, { title: "Plain" });
    await write(plain.file, doc('<div data-oid="d" class="card">a</div>', '<link rel="stylesheet" href="../styles.css"><style>:root { --gap: 4px; } body { margin: 0; }</style>'));
    expect(await lint(plain.file, "frame-class")).toEqual([]);
    const captured = await createDesignFrame(root, { title: "Captured" });
    await write(captured.file, `<!doctype html><html lang="en" data-zd-captured="site"><head><style>.x { color: inherit; }</style></head><body><p data-oid="p" class="x">a</p></body></html>`);
    expect(await lint(captured.file, "frame-class")).toEqual([]);
  });

  it("warns where a component's class is used outside its instances, not inside them or when a stylesheet shares it", async () => {
    await write("styles.css", ".shared { padding: 8px; }\n");
    const main = await createDesignFrame(root, { title: "Chip" });
    await write(main.file, doc('<span data-oid="c" class="chip shared"><span data-oid="s" data-zd-slot="label">x</span></span>',
      "<style>.chip { padding: 2px; } .shared { margin: 0; } .badge { margin: 0; }</style>"));
    await register(main.file, "chip");
    const host = await createDesignFrame(root, { title: "Workspace" });
    await write(host.file, doc(
      '<p data-oid="p" class="chip shared">a</p>\n<zd-chip data-oid="ws"><b data-oid="b" slot="label" class="chip">b</b></zd-chip><div data-oid="cap" data-zd-captured><i data-oid="i" class="badge">c</i></div>',
      '<link rel="stylesheet" href="../styles.css">'));
    expect(await lint(host.file, "component-class")).toEqual([expect.objectContaining({
      ruleId: "component-class", severity: "warning", oid: "p", line: 1,
      message: 'Class "chip" is a component\'s; use it only inside that component and its instances.',
    })]);
    expect(await lint(host.file, "unknown-class")).toEqual([]);
    // Its own main uses it freely.
    expect(await lint(main.file, "component-class")).toEqual([]);
  });
});
