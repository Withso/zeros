import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { componentOptionNameProblem } from "@zeros/design-core/components";
import { rebaseDesignHtmlReferences } from "@zeros/design-web";
import { portableDesignName } from "@zeros/protocol/design-path";

import { designComponentNameProblem, designComponentRegistry } from "./component-registry";
import { designComponentDefinitionProblems, MAX_DESIGN_COMPONENT_BYTES } from "./components";
import { designDirectoryNameFor } from "./directory-registry";
import type { CanvasDocument } from "./document-model";
import { designDirectory, nextFrameGeometry, readCanvas, writeCanvas } from "./document-storage";
import { initializeDesignDocumentUnlocked } from "./document-transactions";
import { withDesignDocumentWrite } from "./document-write-lock";
import { assertDesignPageHasRoom } from "./frame-limits";
import { readDesignStorageFile, type DesignStorageChange } from "./metadata";
import { healDesignOids } from "./node-identities";
import { captureDesignCatalogPoint, publishDesignCatalogChange, type CaptureDesignCatalogChange } from "./page-history";
import { designPageForWrite, designPageFrameFiles } from "./pages";
import { MAX_DESIGN_TEXT_BYTES } from "./render-budget";
import { escapeAttribute, escapeText } from "./source";

const MAIN_WIDTH = 480;
const MAIN_HEIGHT = 320;

export interface DesignComponentMove {
  file: string;
  frameId: string;
  pageId: string;
  title: string;
  component: string;
}

type Element = DefaultTreeAdapterTypes.Element;

function elementsOf(node: DefaultTreeAdapterTypes.ParentNode): Element[] {
  const found: Element[] = [];
  const visit = (parent: DefaultTreeAdapterTypes.ParentNode) => {
    for (const child of parent.childNodes) {
      if (!("tagName" in child)) continue;
      found.push(child);
      visit(child);
      if (child.tagName === "template") visit((child as DefaultTreeAdapterTypes.Template).content);
    }
  };
  visit(node);
  return found;
}

const attributeOf = (element: Element, name: string) => element.attrs.find((attribute) => attribute.name === name)?.value;

function textOf(node: DefaultTreeAdapterTypes.ParentNode): string {
  return node.childNodes.map((child) => (child.nodeName === "#text" ? (child as DefaultTreeAdapterTypes.TextNode).value : "")).join("");
}

export function designComponentMainTitle(name: string): string {
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** components/<name>.html rewritten as the main frame `file`: its
 * definition-local ids become the frame's layer ids (so the parts instances
 * override keep their names), each attribute slot becomes a text option with
 * its fallback as the default, and its URLs, written from the Design root,
 * are rebased to the frame. A bare <slot> stays the default slot. */
export function designMainFromComponentSource(name: string, source: string, file: string): string {
  const problems = designComponentDefinitionProblems(name, source);
  if (problems.length) throw new Error(`zd-${name} cannot move to the canvas: ${problems[0]}`);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const all = elementsOf(document);
  const head = all.find((element) => element.tagName === "head");
  const body = all.find((element) => element.tagName === "body");
  if (!body?.sourceCodeLocation?.startTag)
    throw new Error(`zd-${name} cannot move to the canvas: components/${name}.html needs a <body> tag.`);
  const template = head?.childNodes.find((child): child is DefaultTreeAdapterTypes.Template =>
    "tagName" in child && child.tagName === "template" && child.attrs.some((attribute) => attribute.name === "data-zd-options"));
  // Plain text in a main is read as a template; a "{{" in it would start a hole.
  if (!template && source.includes("{{"))
    throw new Error(`zd-${name} cannot move to the canvas: components/${name}.html contains "{{", which a main reads as an option. Remove it first.`);
  const declared = new Set(template ? elementsOf(template.content)
    .filter((element) => element.tagName === "zd-option").map((element) => attributeOf(element, "name")) : []);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const options: Array<{ name: string; fallback: string }> = [];
  for (const element of elementsOf(body)) {
    const location = element.sourceCodeLocation;
    const attribute = element.tagName === "slot" ? attributeOf(element, "data-zd-attr") : undefined;
    if (attribute !== undefined && location) {
      const problem = componentOptionNameProblem(attribute);
      if (problem)
        throw new Error(`zd-${name} cannot move to the canvas: its ${JSON.stringify(attribute)} slot cannot become an option (${problem}) Rename it in components/${name}.html first.`);
      if (element.childNodes.some((child) => "tagName" in child))
        throw new Error(`zd-${name} cannot move to the canvas: the default of its ${attribute} slot holds markup, and an option holds text only. Make it plain text first.`);
      edits.push({ start: location.startOffset, end: location.endOffset, text: `{{ ${attribute} }}` });
      if (!declared.has(attribute) && !options.some((option) => option.name === attribute))
        options.push({ name: attribute, fallback: textOf(element) });
      continue;
    }
    const identity = location?.attrs?.["data-zid"];
    if (identity) edits.push({ start: identity.startOffset, end: identity.startOffset + "data-zid".length, text: "data-oid" });
  }
  // A templated definition's own stylesheets are relative to its file, as
  // expansion links them; everything else is written from the Design root.
  for (const link of template ? elementsOf(head!) : []) {
    const location = link.sourceCodeLocation?.startTag;
    if (link.tagName !== "link" || !location || !attributeOf(link, "href")) continue;
    const tag = source.slice(location.startOffset, location.endOffset);
    edits.push({ start: location.startOffset, end: location.endOffset, text: rebaseDesignHtmlReferences(tag, `components/${name}.html`, "") });
  }
  const lines = options.map((option) =>
    `<zd-option name="${option.name}" type="text" default="${escapeAttribute(option.fallback)}"></zd-option>\n`).join("");
  if (template && lines) {
    const end = template.sourceCodeLocation?.endTag?.startOffset;
    if (end === undefined) throw new Error(`zd-${name} cannot move to the canvas: its options template is not closed.`);
    const lineStart = source.lastIndexOf("\n", end - 1) + 1;
    const at = /^[ \t]*$/.test(source.slice(lineStart, end)) ? lineStart : end;
    edits.push({ start: at, end: at, text: at === end ? `\n${lines}` : lines });
  }
  // New head lines take the indentation of the file's own head (or body).
  const headStart = head?.sourceCodeLocation?.startTag?.endOffset;
  const bodyStart = body.sourceCodeLocation.startTag.startOffset;
  const outer = /[ \t]*$/.exec(source.slice(0, headStart === undefined ? bodyStart : head!.sourceCodeLocation!.startTag!.startOffset))![0];
  const inner = headStart === undefined ? `${outer}  ` : /^\r?\n([ \t]*)/.exec(source.slice(headStart))?.[1] ?? outer;
  const additions = [
    ...(all.some((element) => element.tagName === "title") ? [] : [`${inner}<title>${escapeText(designComponentMainTitle(name))}</title>\n`]),
    ...(!template && lines ? [`${inner}<template data-zd-options>\n${lines}${inner}</template>\n`] : []),
  ].join("");
  if (additions && headStart !== undefined) edits.push({ start: headStart, end: headStart, text: `\n${additions.slice(0, -1)}` });
  else if (additions) edits.push({ start: bodyStart, end: bodyStart, text: `<head>\n${additions}${outer}</head>\n${outer}` });
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  return healDesignOids(rebaseDesignHtmlReferences(result, "", file)).html;
}

/** Make components/<name>.html a registered main on a page: the new frame
 * and the file's removal are one write, and one catalog history step. */
export async function moveDesignComponentToCanvas(
  workspace: string,
  input: { component: string; pageId?: string },
  capture?: CaptureDesignCatalogChange,
): Promise<DesignComponentMove> {
  const name = input.component;
  const problem = designComponentNameProblem(name);
  if (problem) throw new Error(problem);
  return withDesignDocumentWrite(workspace, async () => {
    await initializeDesignDocumentUnlocked(workspace);
    const canvas = await readCanvas(workspace);
    const before = capture ? captureDesignCatalogPoint(workspace, canvas) : undefined;
    const main = designComponentRegistry(canvas).files.get(name) ??
      Object.entries(canvas.frame_info).find(([, info]) => (info as { component?: unknown }).component === name)?.[0];
    if (main) throw new Error(`zd-${name} is already a main on the canvas (${main}).`);
    const directoryName = designDirectoryNameFor(workspace);
    const legacyFile = `${directoryName}/components/${name}.html`;
    const legacy = readDesignStorageFile(workspace, legacyFile, MAX_DESIGN_COMPONENT_BYTES, true);
    if (legacy === null) throw new Error(`zd-${name} has no components/${name}.html to move.`);
    const page = designPageForWrite(canvas, input.pageId);
    const files = designPageFrameFiles(canvas, page);
    assertDesignPageHasRoom(page.title, files.length);
    const directory = designDirectory(workspace);
    const taken = (file: string) => Object.keys(canvas.frames).some((known) => portableDesignName(known) === portableDesignName(file)) ||
      existsSync(path.join(directory, file));
    const prefix = page.folder ? `${page.folder}/` : "";
    let file = `${prefix}${name}.html`;
    for (let suffix = 2; taken(file); suffix++) file = `${prefix}${name}-${suffix}.html`;
    const source = designMainFromComponentSource(name, legacy, file);
    if (Buffer.byteLength(source) > MAX_DESIGN_TEXT_BYTES) throw new Error(`zd-${name} is too large for a frame.`);
    const title = designComponentMainTitle(name);
    const frameId = `frame_${randomUUID().replace(/-/g, "")}`;
    canvas.frames[file] = nextFrameGeometry(files.map((known) => canvas.frames[known]!), { width: MAIN_WIDTH, height: MAIN_HEIGHT });
    canvas.frame_info[file] = { id: frameId, title, kind: "frame", component: name } as CanvasDocument["frame_info"][string];
    // The main frame now registers the name; a foundation entry for the old
    // file would make every later edit look for it.
    const registered = canvas.foundation.components.filter((component) => component.file !== `components/${name}.html`);
    if (registered.length !== canvas.foundation.components.length)
      canvas.foundation = { ...canvas.foundation, components: registered };
    const sources: DesignStorageChange[] = [
      { file: legacyFile, before: legacy, after: null },
      { file: `${directoryName}/${file}`, before: null, after: source },
    ];
    await writeCanvas(workspace, canvas, sources);
    publishDesignCatalogChange(workspace, before, canvas, sources, capture);
    return { file, frameId, pageId: page.id, title, component: name };
  });
}
