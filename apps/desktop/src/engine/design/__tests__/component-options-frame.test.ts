import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { designComponentSummaryOf } from "../components";
import { resetDesignComponentRendersForTests } from "../component-last-good";
import { designDocumentIdForFrame, getWorkspaceDesignApi } from "../design-api";
import { createDesignFrame, DESIGN_DIRECTORY_NAME, readDesignFrame, readDesignWorkspaceSnapshot } from "../document";
import { readCanvas, writeCanvas } from "../document-storage";
import { readDesignProtocolResource } from "../protocol-resource";
import { designComponentPartNodeId } from "@zeros/protocol/design-runtime";

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

  it("says it shows nothing when its own template fails and this session has no good render", async () => {
    const frame = await createDesignFrame(root, { title: "Chat composer" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, frame.file), MAIN.replace("{{ label }}", "{{ missing }}"));
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === frame.file)!;
    expect(listed.component?.notApplied).toBe("nothing");
    const shown = await readDesignFrame(root, frame.file, 4);
    expect(shown.srcDoc).not.toContain("{{");
  });
});

const VARIANT_MAIN = MAIN.replace("</template>", `<zd-variant name="compact" width="700"></zd-variant>\n</template>`);
const HOST = `<!doctype html><html><head><title>Chat</title></head>
<body><main data-oid="m"><zd-chat-composer data-oid="inst" width="800" zd-variant="compact"></zd-chat-composer><p data-oid="p">After</p></main></body></html>`;

describe("instances and variants through the engine", () => {
  let root: string;
  beforeEach(async () => {
    resetDesignComponentRendersForTests();
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-component-instances-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const setUp = async () => {
    const main = await createDesignFrame(root, { title: "Chat composer" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, main.file), VARIANT_MAIN);
    const canvas = await readCanvas(root);
    canvas.frame_info[main.file] = { ...canvas.frame_info[main.file]!, component: "chat-composer" } as never;
    await writeCanvas(root, canvas);
    const host = await createDesignFrame(root, { title: "Chat" });
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST);
    return { main, host };
  };

  it("records no host under a name every object already has, and keeps the record a plain map", async () => {
    const { host } = await setUp();
    // Layer ids are authored text: these would otherwise replace the record's
    // prototype or shadow what every object inherits.
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST.replace("<p data-oid=\"p\">After</p>",
      `<zd-chat-composer data-oid="__proto__" width="640"></zd-chat-composer><zd-chat-composer data-oid="constructor" width="641"></zd-chat-composer>`));
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === host.file)!;
    const hosts = listed.instances!.hosts;
    expect(Object.getPrototypeOf(hosts)).toBe(Object.prototype);
    expect(Object.keys(hosts)).toEqual(["inst"]);
    expect(Object.hasOwn(hosts, "__proto__")).toBe(false);
    expect(Object.hasOwn(hosts, "constructor")).toBe(false);
  });

  it("names the instances a frame places, their component and their values", async () => {
    const { main, host } = await setUp();
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === host.file)!;
    expect(listed.instances?.hosts).toEqual({ inst: { component: "chat-composer", attributes: { width: "800", "zd-variant": "compact" } } });
    const component = listed.instances?.components["chat-composer"];
    expect(component?.file).toBe(main.file);
    expect(component?.frame).toBe(true);
    expect(component?.reach.width).toBe("css");
    expect(component?.elements.some((element) => element.tag === "zd-variant")).toBe(true);
    expect(listed.instances?.key).toMatch(/^[a-f0-9]{16}$/);
    expect((await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === main.file)!.instances).toBeUndefined();
  });

  it("says which instance's values did not apply and what the frame shows", async () => {
    const { host } = await setUp();
    await writeFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), HOST.replace('width="800"', 'width="wide"'));
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === host.file)!;
    expect(listed.instances?.hosts.inst?.failed).toBe(true);
    expect(listed.instances?.notApplied).toBe("defaults");
  });

  it("marks the text a hole fills on the main", () => {
    expect(designComponentSummaryOf(MAIN)!.boundText).toEqual({ b: ["label"] });
    const derived = MAIN.replace('<b data-oid="b">{{ label }}</b>', '<b data-oid="b">Gap {{ gutter }} {{ label }}</b>');
    expect(designComponentSummaryOf(derived)!.boundText).toEqual({ b: ["gap", "label"] });
    // A hole that reads only a loop's name is still the template's to fill.
    const looped = MAIN.replace('<b data-oid="b">{{ label }}</b>', '<b data-oid="b" data-zd-for="i in range(2)">File {{ i + 1 }}</b>');
    expect(designComponentSummaryOf(looped)!.boundText).toEqual({ b: [] });
  });

  it("renders the main with the variant it shows, under the generation of its source", async () => {
    const { main } = await setUp();
    const listed = (await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === main.file)!;
    const shown = await readDesignProtocolResource(root, { path: main.file, sourceVersion: listed.sourceVersion, variant: "compact" });
    expect(shown.status).toBe(200);
    const html = shown.body.toString("utf8");
    expect(html).toContain("--zd-width: 700px");
    expect(html).toContain(listed.sourceVersion);
    const plain = (await readDesignProtocolResource(root, { path: main.file, sourceVersion: listed.sourceVersion })).body.toString("utf8");
    expect(plain).toContain("--zd-width: 1120px");
    expect((await readDesignProtocolResource(root, { path: main.file, sourceVersion: "0".repeat(24), variant: "compact" })).status).toBe(409);
    expect((await readDesignProtocolResource(root, { path: main.file, sourceVersion: listed.sourceVersion, variant: "Bad name" })).status).toBe(404);
    // The frame's identity is the same whichever variant was shown.
    expect((await readDesignWorkspaceSnapshot(root)).frames.find((candidate) => candidate.file === main.file)!.sourceVersion).toBe(listed.sourceVersion);
    const fallback = await readDesignFrame(root, main.file, 4, { variant: "compact" });
    expect(fallback.sourceVersion).toBe(listed.sourceVersion);
    expect(fallback.srcDoc).toContain("--zd-width: 700px");
  });

  it("writes an instance's value as one attribute and refuses a write to one of its parts", async () => {
    const { host } = await setUp();
    const api = getWorkspaceDesignApi(root);
    const opened = await api.open(designDocumentIdForFrame(host.file));
    const transaction = (operation: Record<string, unknown>, id: string, base = opened.revision) => ({
      schemaVersion: 1 as const, transactionId: id, documentId: opened.documentId, baseRevision: base,
      actor: { kind: "human" as const, id: "desktop" }, intent: "Set Width", createdAt: 1, operations: [{ operationId: "o1", ...operation }],
    });
    const refused = await api.apply(transaction({ type: "node.set-attribute", nodeId: designComponentPartNodeId("inst", "b"), attribute: "class", value: "x" }, "t0") as never)
      .then((result) => result.receipt.status, () => "refused");
    expect(refused).not.toBe("applied");
    const result = await api.apply(transaction({ type: "node.set-attribute", nodeId: "inst", attribute: "width", value: "760" }, "t1") as never);
    expect(result.receipt.status).toBe("applied");
    expect(await readFile(path.join(root, DESIGN_DIRECTORY_NAME, host.file), "utf8")).toBe(HOST.replace('width="800"', 'width="760"'));
  });
});
