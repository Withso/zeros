import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { designComponentSummaryOf } from "../components";
import { resetDesignComponentRendersForTests } from "../component-last-good";
import { designDocumentIdForFrame, getWorkspaceDesignApi } from "../design-api";
import { createDesignFrame, DESIGN_DIRECTORY_NAME, readDesignWorkspaceSnapshot } from "../document";

const MAIN = `<!doctype html><html><head><title>Chat composer</title>
<template data-zd-options>
<zd-option name="width" type="number" default="1120" min="640" max="1440" unit="px"></zd-option>
<zd-option name="attachments" type="number" default="2" min="0" max="4"></zd-option>
<zd-option name="gap" type="number" default="8" unit="px"></zd-option>
<zd-option name="accent" type="color" default="var(--blue-primary)"></zd-option>
<zd-option name="label" type="text" default="Send"></zd-option>
<zd-option name="motion" type="easing" default="ease-out 150ms"></zd-option>
<zd-derive name="gutter" value="gap * 2" unit="px"></zd-derive>
<zd-derive name="many" value="attachments > 2"></zd-derive>
</template>
<style>.c { width: var(--zd-width); padding: var(--zd-gutter); }</style></head>
<body><div class="c" data-oid="root" data-many="{{ many }}"><b data-oid="b">{{ label }}</b></div></body></html>`;

describe("what the panel learns about a component frame", () => {
  it("names its declaration and which options reach the frame only through CSS", () => {
    const summary = designComponentSummaryOf(MAIN)!;
    expect(summary.elements.map((element) => `${element.tag}:${element.attributes.find((a) => a.name === "name")?.value}`)).toEqual([
      "zd-option:width", "zd-option:attachments", "zd-option:gap", "zd-option:accent", "zd-option:label", "zd-option:motion",
      "zd-derive:gutter", "zd-derive:many",
    ]);
    // attachments feeds a derived value a hole reads; label fills a hole; gap
    // reaches CSS only, through its derived custom property.
    expect(summary.reach).toEqual({ width: "css", attachments: "structure", gap: "css", accent: "css", label: "structure", motion: "css" });
  });

  it("is absent for a frame that declares nothing", () => {
    expect(designComponentSummaryOf("<!doctype html><html><head></head><body><p>x</p></body></html>")).toBeNull();
  });
});

describe("a component frame through the engine", () => {
  let root: string;
  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-component-frame-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports its declaration with its prepared record", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, frame.file), MAIN);
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === frame.file)!;
    expect(listed.component?.reach.width).toBe("css");
    expect(listed.component?.elements).toHaveLength(8);
    expect(listed.component?.notApplied).toBeUndefined();
  });

  it("writes an option's default through a transaction, one line, undone in one step", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    const file = path.join(root, DESIGN_DIRECTORY_NAME, frame.file);
    await writeFile(file, MAIN);
    const api = getWorkspaceDesignApi(root);
    const opened = await api.open(designDocumentIdForFrame(frame.file));
    const result = await api.apply({
      schemaVersion: 1, transactionId: "t1", documentId: opened.documentId, baseRevision: opened.revision,
      actor: { kind: "human", id: "desktop" }, intent: "Set Width", createdAt: 1,
      operations: [{ operationId: "o1", type: "component.set-option", file: frame.file, option: "width", variant: null, value: 960 }],
    });
    expect(result.receipt.status).toBe("applied");
    const after = await readFile(file, "utf8");
    expect(after).toBe(MAIN.replace('default="1120"', 'default="960"'));
    await api.undo(opened.documentId);
    expect(await readFile(file, "utf8")).toBe(MAIN);
  });
});

describe("a component frame whose options do not apply", () => {
  let root: string;
  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-component-failed-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("says it shows the component's defaults when this session has no good render", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, frame.file), MAIN.replace("{{ label }}", "{{ missing }}"));
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === frame.file)!;
    expect(listed.component?.notApplied).toBe("defaults");
  });
});
