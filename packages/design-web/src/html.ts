import {
  parse,
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";
import postcss from "postcss";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  DESIGN_DOCUMENT_BODY_ID,
  designNodeIdSchema,
} from "@zeros/design-core";
import { designDocumentBody, withExplicitDesignBody } from "./document-body";
import { designPartOfNodeId } from "./component-overrides";
import { designSlotOfNodeId, designSlottedFragment } from "./component-slots";

import { normalizeDesignCssProperty, validateDesignCssValue } from "./css";
import { designSrcsetReferences, isContainedDesignReference } from "./references";
import {
  designShadowHostOfContent,
  isDeclarativeShadowTemplate,
  registerDesignTemplateContent,
} from "./shadow";

import type {
  DesignSourceSpan,
  DesignWebDiagnostic,
  DesignWebNode,
  DesignWebProjection,
} from "./model";

const NON_DESIGN_TAGS = new Set([
  "html",
  "head",
  "body",
  "base",
  "link",
  "meta",
  "title",
  "style",
  "script",
  "template",
  "noscript",
]);
const ACTIVE_ELEMENTS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "base",
]);
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "poster",
]);

type Document = DefaultTreeAdapterTypes.Document;
type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

function elements(document: Document): Element[] {
  const result: Element[] = [];
  const visit = (node: Document | Element) => {
    for (const child of node.childNodes ?? []) {
      if (!("tagName" in child)) continue;
      result.push(child);
      visit(child);
    }
  };
  visit(document);
  return result;
}

type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;
type Template = DefaultTreeAdapterTypes.Template;

/** Document-order elements including open declarative shadow root content,
 * which the browser renders as the host's layers. Matches the engine's
 * elementRecords order, so derived identities agree on every node. Inert
 * templates stay opaque. */
function designElements(root: Document | DocumentFragment): Element[] {
  const result: Element[] = [];
  const visit = (node: Document | Element | DocumentFragment) => {
    for (const child of node.childNodes ?? []) {
      if (!("tagName" in child)) continue;
      result.push(child);
      visit(child);
      if (isDeclarativeShadowTemplate(child)) visit(registerDesignTemplateContent(child as Template));
    }
  };
  visit(root);
  return result;
}

function isBodyDescendant(element: Element): boolean {
  let parent: Node | DocumentFragment | null = element.parentNode;
  while (parent) {
    if ("tagName" in parent && parent.tagName === "body") return true;
    if (!("tagName" in parent) && parent.nodeName === "#document-fragment") {
      parent = designShadowHostOfContent(parent as DocumentFragment);
      continue;
    }
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return false;
}

function isDesignElement(element: Element): boolean {
  return isBodyDescendant(element) && !NON_DESIGN_TAGS.has(element.tagName);
}

/** Selectable design elements in document order, shadow content included. */
export function designNodeElements(document: Document): Element[] {
  return designElements(document).filter(isDesignElement);
}

function span(location: {
  startOffset: number;
  endOffset: number;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}): DesignSourceSpan {
  return {
    startOffset: location.startOffset,
    endOffset: location.endOffset,
    startLine: location.startLine,
    startColumn: location.startCol,
    endLine: location.endLine,
    endColumn: location.endCol,
  };
}

function parserErrorSpan(error: ParserError): DesignSourceSpan | undefined {
  if (
    error.startOffset === undefined ||
    error.endOffset === undefined ||
    error.startLine === undefined ||
    error.startCol === undefined ||
    error.endLine === undefined ||
    error.endCol === undefined
  ) {
    return undefined;
  }
  return span({
    startOffset: error.startOffset,
    endOffset: error.endOffset,
    startLine: error.startLine,
    startCol: error.startCol,
    endLine: error.endLine,
    endCol: error.endCol,
  });
}

function oid(element: Element): string | null {
  const value = element.attrs.find(
    (attribute) => attribute.name === "data-oid",
  )?.value;
  return value?.trim() || null;
}

/** A derived identity, shared by the engine and the canvas, names an element
 * by its tag and element-sibling index at every level from the document root,
 * plus its own attributes and direct text. Writing one layer's id, or changing
 * one layer's text or attributes, changes no other layer's derived id, so such
 * an edit persists only that layer's id. Adding, moving or removing elements
 * shifts places, so those edits also persist the ids of the layers they shift
 * (healDesignHtmlIdentitiesForEdit). A layer that shifts
 * gets a new id rather than the one its neighbour had, so a held selection is
 * dropped, not moved to another layer. Explicit IDs remain authoritative. */
export function nativeDesignIdentities(document: Document): (element: Element) => string {
  const places = new Map<Element, { parent: Element | null; step: string }>();
  const pending: Array<{ node: Document | DocumentFragment | Element; parent: Element | null; prefix: string }> = [
    { node: document, parent: null, prefix: "" },
  ];
  while (pending.length) {
    const { node, parent, prefix } = pending.pop()!;
    let index = 0;
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      places.set(child, { parent, step: `${prefix}/${child.tagName}:${index++}` });
      pending.push({ node: child, parent: child, prefix: "" });
      if (child.tagName === "template" && "content" in child)
        pending.push({ node: (child as DefaultTreeAdapterTypes.Template).content, parent: child, prefix: "#content" });
    }
  }
  const encoder = new TextEncoder();
  const ids = new Map<Element, string>();
  // Hashing waits until an element needs a derived id; most already carry one.
  return (element) => {
    const known = ids.get(element);
    if (known) return known;
    const steps: string[] = [];
    for (let place = places.get(element); place; place = place.parent ? places.get(place.parent) : undefined)
      steps.push(place.step);
    const attributes = element.attrs
      .filter((attribute) => attribute.name !== "data-oid")
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .join("\u0000");
    const text = element.childNodes
      .map((child) => (child.nodeName === "#text" ? (child as DefaultTreeAdapterTypes.TextNode).value : ""))
      .join("")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const digest = sha256(encoder.encode(`${steps.reverse().join("")}\u0000${attributes}\u0000${text}`));
    const id = `o-${Array.from(digest.subarray(0, 5), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 9)}`;
    ids.set(element, id);
    return id;
  };
}

/** Attach derived IDs to the parsed tree only. Locations still address the
 * original file; explicit duplicates retain their validation errors. */
export function identifyDesignHtmlNodes(document: Document): void {
  const used = new Set<string>();
  const derived = nativeDesignIdentities(document);
  for (const element of designElements(document).filter(isDesignElement)) {
    const location = element.sourceCodeLocation;
    if (!location?.startTag) continue;
    const current = oid(element);
    if (current && !used.has(current)) { used.add(current); continue; }
    const base = derived(element);
    let next = base;
    for (let suffix = 2; used.has(next); suffix++) next = `${base}-${suffix}`;
    used.add(next);
    if (current) continue;
    const attribute = element.attrs.find((item) => item.name === "data-oid");
    if (attribute) attribute.value = next;
    else element.attrs.push({ name: "data-oid", value: next });
  }
}

function nearestParentId(element: Element): string | null {
  let parent: Node | DocumentFragment | null = element.parentNode;
  while (parent) {
    if (!("tagName" in parent)) {
      if (parent.nodeName !== "#document-fragment") break;
      // A shadow root's top-level layers belong to the host.
      parent = designShadowHostOfContent(parent as DocumentFragment);
      continue;
    }
    if (isDesignElement(parent)) {
      const id = oid(parent);
      if (id) return id;
    }
    parent = parent.parentNode;
  }
  return null;
}

function directText(element: Element): string {
  return element.childNodes
    .filter((node): node is DefaultTreeAdapterTypes.TextNode => "value" in node)
    .map((node) => node.value)
    .join("")
    .slice(0, 100_000);
}

export function parseDesignWebProjection(input: {
  documentId: string;
  revision: string;
  entryFile: string;
  source: string;
}): DesignWebProjection {
  const parseErrors: ParserError[] = [];
  const document = parse(input.source, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  identifyDesignHtmlNodes(document);
  const diagnostics: DesignWebDiagnostic[] = parseErrors.map((error) => ({
    severity: "error",
    code: "html-parse",
    message: `HTML parse error: ${error.code}`,
    file: input.entryFile,
    ...(parserErrorSpan(error) ? { span: parserErrorSpan(error) } : {}),
  }));
  const records = designElements(document).filter(isDesignElement);
  const counts = new Map<string, number>();
  for (const element of records) {
    const id = oid(element);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const nodes: DesignWebNode[] = [];
  for (const element of records) {
    const id = oid(element);
    const location = element.sourceCodeLocation;
    if (!id) {
      diagnostics.push({
        severity: "error",
        code: "identity-missing",
        message: `<${element.tagName}> is missing a stable data-oid.`,
        file: input.entryFile,
        ...(location ? { span: span(location) } : {}),
      });
      continue;
    }
    if ((counts.get(id) ?? 0) > 1) {
      diagnostics.push({
        severity: "error",
        code: "identity-duplicate",
        message: `data-oid "${id}" is duplicated.`,
        file: input.entryFile,
        nodeId: id,
        ...(location ? { span: span(location) } : {}),
      });
      continue;
    }
    if (!location?.startTag) continue;
    nodes.push({
      id,
      tag: element.tagName,
      file: input.entryFile,
      parentId: nearestParentId(element),
      childIds: [],
      attributes: Object.fromEntries(
        element.attrs.map((attribute) => [attribute.name, attribute.value]),
      ),
      directText: directText(element),
      span: span(location),
      startTag: span(location.startTag),
      endTag: location.endTag ? span(location.endTag) : null,
    });
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const rootIds: string[] = [];
  for (const node of nodes) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.childIds.push(node.id);
    else rootIds.push(node.id);
  }
  return {
    documentId: input.documentId,
    revision: input.revision,
    entryFile: input.entryFile,
    nodes,
    rootIds,
    diagnostics,
  };
}

/** Text and attribute edits may target declarative shadow content; structural
 * edits (delete, duplicate, move) pass light-DOM records and refuse it. */
function elementForMutation(
  source: string,
  nodeId: string,
  records?: readonly Element[],
  options: { shadow?: boolean } = {},
): Element {
  const document = records ? null : parse(source, { sourceCodeLocationInfo: true });
  const matches = (records ?? (options.shadow ? designElements(document!) : elements(document!))).filter(
    (element) => isDesignElement(element) && oid(element) === nodeId,
  );
  if (matches.length === 0 && !options.shadow && isShadowContent(source, nodeId)) {
    throw shadowContentRefusal(nodeId);
  }
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      matches.length > 1
        ? `Design element is not unique: ${nodeId}`
        : `Design element not found: ${nodeId}`,
    );
  }
  return matches[0];
}

/** A layer's tag and attributes as written (decoded). */
export function designNodeAttributes(source: string, nodeId: string): { tag: string; attributes: ReadonlyMap<string, string> } {
  const element = elementForMutation(source, nodeId, undefined, { shadow: true });
  return { tag: element.tagName, attributes: new Map(element.attrs.map((attribute) => [attribute.name, attribute.value])) };
}

function shadowContentRefusal(nodeId: string): Error {
  return new Error(
    `Design element ${nodeId} is inside a shadow root: restyle or retext it here, and move, duplicate or delete it by editing the HTML.`,
  );
}

function isShadowContent(source: string, nodeId: string): boolean {
  const document = parse(source, { sourceCodeLocationInfo: true });
  identifyDesignHtmlNodes(document);
  const light = new Set(elements(document));
  return designElements(document).some(
    (element) => !light.has(element) && isDesignElement(element) && oid(element) === nodeId,
  );
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string, quote: string): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return quote === "'"
    ? escaped.replace(/'/g, "&#39;")
    : escaped.replace(/"/g, "&quot;");
}

/** Copy each unchanged span once. Rebuilding the entire string per identity
 * makes a subtree copy or repair quadratic in its authored size. */
function applySourceEdits(source: string, edits: Array<{ start: number; end: number; text: string }>): string {
  if (!edits.length) return source;
  const parts: string[] = [];
  let offset = 0;
  for (const edit of edits.sort((left, right) => left.start - right.start)) {
    parts.push(source.slice(offset, edit.start), edit.text);
    offset = edit.end;
  }
  parts.push(source.slice(offset));
  return parts.join("");
}

export function mutateDesignNodeTextSource(
  source: string,
  nodeId: string,
  text: string,
): string {
  if (text.length > 100_000) throw new Error("Design text is too long.");
  const element = elementForMutation(source, nodeId, undefined, { shadow: true });
  if (element.childNodes.some((node) => "tagName" in node)) {
    throw new Error(
      `Design element ${nodeId} contains element children; setting text would discard them.`,
    );
  }
  const location = element.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) {
    throw new Error(`Design element cannot contain text: ${nodeId}`);
  }
  return `${source.slice(0, location.startTag.endOffset)}${escapeText(text)}${source.slice(location.endTag.startOffset)}`;
}

function duplicateIdentity(
  rootId: string,
  originalId: string,
  index: number,
  used: ReadonlySet<string>,
): string {
  const safeOriginal =
    originalId.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "") ||
    `node-${index}`;
  const prefix = `${rootId}-${safeOriginal}`.slice(0, 248);
  let candidate = prefix;
  let suffix = 2;
  while (used.has(candidate)) {
    const ending = `-${suffix}`;
    candidate = `${prefix.slice(0, 256 - ending.length)}${ending}`;
    suffix += 1;
  }
  return designNodeIdSchema.parse(candidate);
}

/** Duplicate one authored subtree immediately after itself. Every identity in
 * the clone is replaced before insertion so the resulting document remains
 * addressable without a follow-up healing pass. */
export function mutateDesignNodeDuplicateSource(
  source: string,
  nodeId: string,
  rawDuplicateNodeId: string,
): string {
  const duplicateNodeId = designNodeIdSchema.parse(rawDuplicateNodeId);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = elements(document);
  // Shadow content carries identities too, so the copy's must avoid them.
  const existingIds = new Set(
    designElements(document)
      .map(oid)
      .filter((id): id is string => Boolean(id)),
  );
  if (existingIds.has(duplicateNodeId)) {
    throw new Error(`Design element already exists: ${duplicateNodeId}`);
  }
  const element = elementForMutation(source, nodeId, records);
  const location = element.sourceCodeLocation;
  if (!location)
    throw new Error(`Design element has no authored span: ${nodeId}`);
  const cloneSource = source.slice(location.startOffset, location.endOffset);
  const fragment = parseFragment(cloneSource, { sourceCodeLocationInfo: true });
  // A copied host's declarative shadow content is copied with it, so its
  // identities are replaced as well.
  const cloneRecords = designElements(fragment);
  if (cloneRecords.length === 0) {
    throw new Error(`Design element cannot be duplicated: ${nodeId}`);
  }
  const used = new Set(existingIds);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  cloneRecords.forEach((record, index) => {
    const originalId = oid(record);
    if (!originalId) return;
    const nextId =
      index === 0
        ? duplicateNodeId
        : duplicateIdentity(duplicateNodeId, originalId, index, used);
    used.add(nextId);
    const attribute = record.sourceCodeLocation?.attrs?.["data-oid"];
    if (!attribute) {
      throw new Error(`Design identity has no authored span: ${originalId}`);
    }
    edits.push({
      start: attribute.startOffset,
      end: attribute.endOffset,
      text: `data-oid="${escapeAttribute(nextId, '"')}"`,
    });
  });
  const duplicate = applySourceEdits(cloneSource, edits);
  return `${source.slice(0, location.endOffset)}${duplicate}${source.slice(location.endOffset)}`;
}

/** Move the exact authored span; do not serialize and normalize its subtree.
 * Into a slot id, the layer joins the slot's host with slot="<name>"; out
 * of an instance it leaves its slot behind. */
export function mutateDesignNodeMoveSource(
  source: string,
  nodeId: string,
  parentId: string,
  beforeId: string | null,
): string {
  const slot = designSlotOfNodeId(parentId);
  if (slot) {
    // The parts between slotted layers are the component's: no place to name.
    const sibling = beforeId && (designPartOfNodeId(beforeId) || designSlotOfNodeId(beforeId)) ? null : beforeId;
    const moved = moveDesignNodeSource(source, nodeId, slot.host, sibling);
    return mutateDesignNodeAttributeSource(moved, nodeId, "slot", slot.name || null);
  }
  const slotted = /\sslot\s*=/i.test(source) && slottedInInstance(source, nodeId);
  const moved = moveDesignNodeSource(source, nodeId, parentId, beforeId);
  return slotted ? mutateDesignNodeAttributeSource(moved, nodeId, "slot", null) : moved;
}

function slottedInInstance(source: string, nodeId: string): boolean {
  const element = elementForMutation(source, nodeId);
  const parent = element.parentNode;
  return !!parent && "tagName" in parent && parent.tagName.startsWith("zd-") && element.attrs.some((attribute) => attribute.name === "slot");
}

function moveDesignNodeSource(
  source: string,
  nodeId: string,
  parentId: string,
  beforeId: string | null,
): string {
  if (parentId === DESIGN_DOCUMENT_BODY_ID)
    source = withExplicitDesignBody(source);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = elements(document);
  const find = (id: string): Element => {
    const element =
      id === DESIGN_DOCUMENT_BODY_ID
        ? designDocumentBody(document)
        : records.find((record) => oid(record) === id);
    if (!element) {
      if (isShadowContent(source, id)) throw shadowContentRefusal(id);
      throw new Error(`Design element not found: ${id}`);
    }
    return element;
  };
  const element = find(nodeId);
  const parent = find(parentId);
  const before = beforeId ? find(beforeId) : null;
  const span = element.sourceCodeLocation;
  const container = parent.sourceCodeLocation;
  if (
    !span ||
    !container?.startTag ||
    !container.endTag ||
    element.tagName === "body"
  )
    throw new Error("The layer destination has no editable source span.");
  if (
    element === parent ||
    (container.startOffset >= span.startOffset &&
      container.endOffset <= span.endOffset)
  )
    throw new Error("A layer cannot be moved inside itself.");
  if (before && (before === element || before.parentNode !== parent))
    throw new Error("The insertion sibling must belong to the destination.");
  if (
    /^(select|option|table|thead|tbody|tfoot|tr|ul|ol|dl)$/.test(parent.tagName)
  )
    throw new Error("This layer cannot contain a frame.");
  const insertion =
    before?.sourceCodeLocation?.startOffset ?? container.endTag.startOffset;
  if (insertion === span.startOffset || insertion === span.endOffset)
    return source;
  const content = source.slice(span.startOffset, span.endOffset);
  const line = ownLine(source, span.startOffset, span.endOffset);
  const target = line ? lineStart(source, insertion) : null;
  // A layer on its own line lands on its own line, indented like the sibling
  // it precedes or the destination's last child, so a reorder leaves neither a
  // blank line nor two layers on one line.
  const indent =
    target === null
      ? null
      : before
        ? source.slice(target, insertion)
        : lastChildIndent(source, parent, element) ?? (element.parentNode === parent ? line!.indent : null);
  if (line && target !== null && indent !== null)
    return applySourceEdits(source, [
      { start: line.start, end: line.end, text: "" },
      { start: target, end: target, text: `${indent}${content}${line.newline}` },
    ]);
  const [removeStart, removeEnd] = line ? [line.start, line.end] : [span.startOffset, span.endOffset];
  return applySourceEdits(source, [
    { start: removeStart, end: removeEnd, text: "" },
    { start: insertion, end: insertion, text: content },
  ]);
}

/** Where the line holding `offset` starts, when only spaces or tabs precede it. */
function lineStart(source: string, offset: number): number | null {
  let start = offset;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start--;
  return start === 0 || source[start - 1] === "\n" ? start : null;
}

/** The whole line an element has to itself, newline included, or null when
 * other source shares it. */
function ownLine(
  source: string,
  start: number,
  end: number,
): { start: number; end: number; indent: string; newline: string } | null {
  const first = lineStart(source, start);
  if (first === null) return null;
  let last = end;
  while (last < source.length && (source[last] === " " || source[last] === "\t" || source[last] === "\r")) last++;
  if (source[last] !== "\n") return null;
  return {
    start: first,
    end: last + 1,
    indent: source.slice(first, start),
    newline: source[last - 1] === "\r" ? "\r\n" : "\n",
  };
}

function lastChildIndent(source: string, parent: Element, moving: Element): string | null {
  const children = parent.childNodes.filter(
    (node): node is Element => "tagName" in node && node !== moving,
  );
  const offset = children.at(-1)?.sourceCodeLocation?.startOffset;
  if (offset === undefined) return null;
  const start = lineStart(source, offset);
  return start === null ? null : source.slice(start, offset);
}

/** Remove exactly one authored element subtree. An element alone on its line
 * takes the line with it; otherwise neighboring bytes stay as written. */
export function mutateDesignNodeDeleteSource(
  source: string,
  nodeId: string,
): string {
  const element = elementForMutation(source, nodeId);
  const location = element.sourceCodeLocation;
  if (!location)
    throw new Error(`Design element has no authored span: ${nodeId}`);
  const line = ownLine(source, location.startOffset, location.endOffset);
  const [start, end] = line ? [line.start, line.end] : [location.startOffset, location.endOffset];
  return `${source.slice(0, start)}${source.slice(end)}`;
}

function fragmentElements(
  fragment: DefaultTreeAdapterTypes.DocumentFragment,
): Element[] {
  const result: Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.DocumentFragment | Element) => {
    for (const child of node.childNodes ?? []) {
      if (!("tagName" in child)) continue;
      result.push(child);
      visit(child);
    }
  };
  visit(fragment);
  return result;
}

function assertSafeStyleSource(source: string, owner: string, sourceFile: string): void {
  let root: postcss.Root;
  try {
    root = postcss.parse(source);
  } catch {
    throw new Error(`Invalid design CSS in ${owner}.`);
  }
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() === "import") {
      throw new Error(`CSS imports are not allowed in ${owner}.`);
    }
  });
  root.walkDecls((declaration) => {
    const property = normalizeDesignCssProperty(declaration.prop);
    validateDesignCssValue(property, declaration.value, sourceFile);
  });
}

function assertSafeInlineStyle(source: string, sourceFile: string): void {
  let root: postcss.Root;
  try {
    root = postcss.parse(`a{${source}}`);
  } catch {
    throw new Error("Invalid design style attribute.");
  }
  const rule = root.first;
  if (root.nodes.length !== 1 || rule?.type !== "rule") {
    throw new Error("Invalid design style attribute.");
  }
  for (const node of rule.nodes ?? []) {
    if (node.type !== "decl") {
      throw new Error("Nested CSS is not allowed in a style attribute.");
    }
    const property = normalizeDesignCssProperty(node.prop);
    validateDesignCssValue(property, node.value, sourceFile);
  }
}

function elementText(element: Element): string {
  return element.childNodes
    .filter((node): node is DefaultTreeAdapterTypes.TextNode => "value" in node)
    .map((node) => node.value)
    .join("");
}

function assertSafeElements(records: readonly Element[], sourceFile: string): void {
  for (const element of records) {
    if (ACTIVE_ELEMENTS.has(element.tagName)) {
      throw new Error(
        `Active design element is not allowed: <${element.tagName}>.`,
      );
    }
    const httpEquiv = element.attrs
      .find((attribute) => attribute.name.toLowerCase() === "http-equiv")
      ?.value.trim()
      .toLowerCase();
    if (
      element.tagName === "meta" &&
      (httpEquiv === "refresh" || httpEquiv === "content-security-policy")
    ) {
      throw new Error(`Active design metadata is not allowed: ${httpEquiv}.`);
    }
    if (element.tagName === "style") {
      assertSafeStyleSource(elementText(element), "<style>", sourceFile);
    }
    for (const attribute of element.attrs) {
      const name = attribute.name.toLowerCase();
      if (/^on/i.test(name)) {
        throw new Error(
          `Event handler attributes are not allowed: ${attribute.name}.`,
        );
      }
      if (name === "srcdoc") {
        throw new Error("The srcdoc attribute is not allowed in design HTML.");
      }
      if (name === "style") {
        assertSafeInlineStyle(attribute.value, sourceFile);
        continue;
      }
      if (name === "srcset") {
        const candidates = designSrcsetReferences(attribute.value).map((candidate) => candidate.url);
        if (
          candidates.length === 0 ||
          candidates.some((candidate) => !isContainedDesignReference(candidate, sourceFile))
        ) {
          throw new Error(
            "srcset references must stay inside the design document.",
          );
        }
        continue;
      }
      if (
        URL_ATTRIBUTES.has(name) &&
        !isContainedDesignReference(attribute.value, sourceFile)
      ) {
        throw new Error(
          `URL in ${attribute.name} must stay inside the design document.`,
        );
      }
    }
  }
}

export function assertSafeDesignHtmlFragment(html: string, sourceFile = ""): void {
  if (html.length > 500_000) throw new Error("Design HTML is too long.");
  const parseErrors: ParserError[] = [];
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    throw new Error(`Invalid design HTML (${parseErrors[0]!.code}).`);
  }
  assertSafeElements(fragmentElements(fragment), sourceFile);
}

export function assertSafeDesignHtmlDocument(html: string, sourceFile = ""): void {
  if (new TextEncoder().encode(html).byteLength > 2 * 1024 * 1024) {
    throw new Error("Design HTML exceeds the 2 MiB source limit.");
  }
  const parseErrors: ParserError[] = [];
  const document = parse(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    throw new Error(`Invalid design HTML document (${parseErrors[0]!.code}).`);
  }
  const records = elements(document);
  const authoredHtml = records.find(
    (element) =>
      element.tagName === "html" && element.sourceCodeLocation?.startTag,
  );
  const authoredBody = records.find(
    (element) =>
      element.tagName === "body" && element.sourceCodeLocation?.startTag,
  );
  if (!/^\s*<!doctype\s+html\b/i.test(html) || !authoredHtml || !authoredBody) {
    throw new Error("A component must be a complete HTML document.");
  }
  assertSafeElements(records, sourceFile);
}

/** Component internals keep definition-local IDs. A runtime address combines
 * these with the root instance and nested definition path; data-oid remains
 * reserved for authored frame nodes and instance wrappers. */
export function assertDesignComponentDefinitionIdentities(html: string): void {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const records = elements(document).filter(
    (element) => isDesignElement(element) && element.tagName !== "slot",
  );
  const used = new Set<string>();
  for (const element of records) {
    const id = element.attrs
      .find((attribute) => attribute.name === "data-zid")
      ?.value.trim();
    if (!id) {
      throw new Error(
        `Component element <${element.tagName}> is missing definition-local data-zid.`,
      );
    }
    if (!designNodeIdSchema.safeParse(id).success) {
      throw new Error(`Component data-zid is invalid: ${id}.`);
    }
    if (used.has(id)) {
      throw new Error(`Component data-zid is duplicated: ${id}.`);
    }
    used.add(id);
  }
}

/** Parser-backed component reference lookup. Text, comments, templates, and
 * script-shaped legacy content must not create false dependency edges. */
export function designHtmlUsesComponent(
  source: string,
  componentId: string,
): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(componentId)) return false;
  return elements(parse(source)).some(
    (element) => element.tagName === `zd-${componentId}`,
  );
}

export function mutateDesignNodeHtmlSource(
  source: string,
  nodeId: string,
  html: string,
  mode: "append" | "replace-inner" = "replace-inner",
  sourceFile = "",
): string {
  return designNodeHtmlInsertion(source, nodeId, html, mode, sourceFile).source;
}

/** The edited source and where the new content sits in it. */
export function designNodeHtmlInsertion(
  source: string,
  nodeId: string,
  html: string,
  mode: "append" | "replace-inner" = "replace-inner",
  sourceFile = "",
): { source: string; start: number; end: number } {
  const slot = designSlotOfNodeId(nodeId);
  if (slot) {
    if (mode !== "append") throw new Error("A slot's layers can only be added to.");
    return designNodeHtmlInsertion(source, slot.host, designSlottedFragment(html, slot.name), "append", sourceFile);
  }
  assertSafeDesignHtmlFragment(html, sourceFile);
  if (nodeId === DESIGN_DOCUMENT_BODY_ID) {
    if (mode !== "append")
      throw new Error(
        "Document content can only be appended through this target.",
      );
    source = withExplicitDesignBody(source);
  }
  const element =
    nodeId === DESIGN_DOCUMENT_BODY_ID
      ? designDocumentBody(parse(source, { sourceCodeLocationInfo: true }))
      : elementForMutation(source, nodeId);
  const location = element.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) {
    throw new Error(`Design element cannot contain HTML: ${nodeId}`);
  }
  const start =
    mode === "append"
      ? location.endTag.startOffset
      : location.startTag.endOffset;
  return { source: `${source.slice(0, start)}${html}${source.slice(location.endTag.startOffset)}`, start, end: start + html.length };
}

function attributeRemovalStart(source: string, start: number): number {
  let cursor = start;
  while (cursor > 0 && /\s/.test(source[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}

export function mutateDesignNodeAttributeSource(
  source: string,
  nodeId: string,
  rawName: string,
  value: string | null,
  sourceFile = "",
): string {
  const name = rawName.trim();
  if (!/^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(name) || name.length > 128) {
    throw new Error(`Invalid design attribute: ${rawName}`);
  }
  const normalized = name.toLowerCase();
  if (normalized === "data-oid") {
    throw new Error(
      "Stable data-oid identity cannot be changed as an attribute.",
    );
  }
  if (normalized === "style") {
    throw new Error("Use node.set-styles for authored style changes.");
  }
  if (/^on/i.test(normalized)) {
    throw new Error(`Event handler attributes are not allowed: ${name}.`);
  }
  if (
    value !== null &&
    ["href", "src", "action", "formaction", "poster", "xlink:href"].includes(
      normalized,
    ) &&
    !isContainedDesignReference(value, sourceFile)
  ) {
    throw new Error(`URL in ${name} must stay inside the design document.`);
  }
  if (value !== null && value.length > 100_000) {
    throw new Error(`Design attribute is too long: ${name}.`);
  }
  const element = elementForMutation(source, nodeId, undefined, { shadow: true });
  const startTag = element.sourceCodeLocation?.startTag;
  if (!startTag)
    throw new Error(`Design element has no authored start tag: ${nodeId}`);
  const existing = element.attrs.find(
    (attribute) => attribute.name.toLowerCase() === normalized,
  );
  const location = existing
    ? element.sourceCodeLocation?.attrs?.[existing.name]
    : undefined;
  if (location) {
    if (value === null) {
      const start = attributeRemovalStart(source, location.startOffset);
      return `${source.slice(0, start)}${source.slice(location.endOffset)}`;
    }
    const raw = source.slice(location.startOffset, location.endOffset);
    const equal = raw.indexOf("=");
    const authoredName = equal < 0 ? raw.trim() : raw.slice(0, equal).trim();
    const afterEqual = equal < 0 ? "" : raw.slice(equal + 1).trimStart();
    const quote = afterEqual.startsWith("'") ? "'" : '"';
    const replacement = `${authoredName || name}=${quote}${escapeAttribute(value, quote)}${quote}`;
    return `${source.slice(0, location.startOffset)}${replacement}${source.slice(location.endOffset)}`;
  }
  if (value === null) return source;
  const close = source.lastIndexOf(">", startTag.endOffset - 1);
  if (close < startTag.startOffset)
    throw new Error("Malformed design start tag.");
  const slash = source.slice(startTag.startOffset, close).match(/\/\s*$/);
  const insertAt =
    slash?.index === undefined ? close : startTag.startOffset + slash.index;
  return `${source.slice(0, insertAt)} ${name}="${escapeAttribute(value, '"')}"${source.slice(insertAt)}`;
}

function identityBase(tag: string, offset: number, source: string): string {
  let hash = 0x811c9dc5;
  const value = `${tag}:${offset}:${source.slice(Math.max(0, offset - 32), offset + 64)}`;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `o-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Minimal identity repair. Once written, generated IDs no longer depend on
 * offsets; offsets are used only to seed a previously unidentified element. */
export function healDesignHtmlIdentities(
  source: string,
  options: {
    /** Write the ids the canvas derives, instead of new offset-seeded ones. */
    native?: boolean;
    /** Write only these derived ids; every other element keeps its bytes. */
    only?: ReadonlySet<string>;
    /** Write ids only on elements that start within this span. */
    within?: { start: number; end: number };
  } = {},
): {
  source: string;
  changed: boolean;
  healed: number;
} {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = designElements(document).filter(isDesignElement);
  const derived = options.native ? nativeDesignIdentities(document) : null;
  const used = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const element of records) {
    const location = element.sourceCodeLocation;
    if (!location?.startTag) continue;
    const current = oid(element);
    if (current && !used.has(current)) {
      used.add(current);
      continue;
    }
    const base = derived ? derived(element) : identityBase(element.tagName, location.startOffset, source);
    let next = base;
    for (let suffix = 2; used.has(next); suffix += 1)
      next = `${base}-${suffix}`;
    used.add(next);
    if (options.only && !options.only.has(next)) continue;
    if (options.within && (location.startOffset < options.within.start || location.startOffset >= options.within.end)) continue;
    const attributeLocation = element.sourceCodeLocation?.attrs?.["data-oid"];
    if (attributeLocation) {
      edits.push({
        start: attributeLocation.startOffset,
        end: attributeLocation.endOffset,
        text: `data-oid="${next}"`,
      });
      continue;
    }
    const close = source.lastIndexOf(">", location.startTag.endOffset - 1);
    if (close < location.startTag.startOffset) continue;
    const slash = source
      .slice(location.startTag.startOffset, close)
      .match(/\/\s*$/);
    const insertAt =
      slash?.index === undefined
        ? close
        : location.startTag.startOffset + slash.index;
    edits.push({ start: insertAt, end: insertAt, text: ` data-oid="${next}"` });
  }
  const result = applySourceEdits(source, edits);
  return { source: result, changed: result !== source, healed: edits.length };
}

/** A placeholder data-oid that stands for an element's derived id while an
 * edit is tried, so each element can be followed through it. The "::zeros-"
 * namespace is one no authored layer takes. */
const PENDING_IDENTITY = "::zeros-pending:";

/** The id every element that heal would identify gets, keyed by its
 * placeholder, given the ids `written` would put on some of them. */
function pendingIdentities(source: string, written: ReadonlyMap<string, string>): Map<string, string> {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const derived = nativeDesignIdentities(document);
  const used = new Set<string>();
  const result = new Map<string, string>();
  for (const element of designElements(document).filter(isDesignElement)) {
    if (!element.sourceCodeLocation?.startTag) continue;
    const value = oid(element);
    const pending = value?.startsWith(PENDING_IDENTITY) ? value : null;
    // A copy of a pending element (a duplicate's) is new and has no id yet.
    const current = pending ? written.get(pending) ?? null : value?.includes(PENDING_IDENTITY) ? null : value;
    if (current && !used.has(current)) {
      used.add(current);
      if (pending) result.set(pending, current);
      continue;
    }
    const base = derived(element);
    let next = base;
    for (let suffix = 2; used.has(next); suffix += 1) next = `${base}-${suffix}`;
    used.add(next);
    if (pending) result.set(pending, next);
  }
  return result;
}

/** Before a structural edit (a move, delete, duplicate or new content), write
 * the derived ids of the layers the edit shifts, so each keeps its own id and
 * none takes another's, and of the layers it names; every other layer keeps
 * its bytes. `edit` applies the edit to a source and may throw, in which case
 * every derived id is written, as the edit's own failure will report.
 * `subtree` names a layer whose descendants are all written too: a copy of
 * it then takes <copy>-<original> ids, as the canvas's clone does, rather
 * than deriving ones from its new place that a sibling may already hold. */
export function healDesignHtmlIdentitiesForEdit(
  source: string,
  operands: ReadonlySet<string>,
  edit: (source: string) => string,
  subtree?: string,
): { source: string; changed: boolean } {
  let named = healDesignHtmlIdentities(source, { native: true, only: operands }).source;
  if (subtree) {
    const root = designElements(parse(named, { sourceCodeLocationInfo: true })).find((element) => oid(element) === subtree);
    const span = root?.sourceCodeLocation;
    if (span) named = healDesignHtmlIdentities(named, { native: true, within: { start: span.startOffset, end: span.endOffset } }).source;
  }
  const document = parse(named, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const used = new Set<string>();
  let count = 0;
  for (const element of designElements(document).filter(isDesignElement)) {
    const location = element.sourceCodeLocation;
    if (!location?.startTag) continue;
    const current = oid(element);
    if (current && !used.has(current)) { used.add(current); continue; }
    const marker = `${PENDING_IDENTITY}${count++}`;
    const attribute = location.attrs?.["data-oid"];
    if (attribute) { edits.push({ start: attribute.startOffset, end: attribute.endOffset, text: `data-oid="${marker}"` }); continue; }
    const close = named.lastIndexOf(">", location.startTag.endOffset - 1);
    if (close < location.startTag.startOffset) continue;
    const slash = named.slice(location.startTag.startOffset, close).match(/\/\s*$/);
    const insertAt = slash?.index === undefined ? close : location.startTag.startOffset + slash.index;
    edits.push({ start: insertAt, end: insertAt, text: ` data-oid="${marker}"` });
  }
  const everything = () => {
    const healed = healDesignHtmlIdentities(source, { native: true }).source;
    return { source: healed, changed: healed !== source };
  };
  const marked = applySourceEdits(named, edits);
  const before = pendingIdentities(marked, new Map());
  let edited: string;
  try {
    edited = edit(marked);
  } catch {
    return everything();
  }
  // Writing one id can change which of two alike layers takes a suffix, so
  // look again until no other layer shifts.
  const keep = new Map<string, string>();
  for (let round = 0; round < 8; round += 1) {
    const after = pendingIdentities(edited, keep);
    let grew = false;
    for (const [marker, id] of before) {
      const now = after.get(marker);
      if (now === undefined || now === id || keep.has(marker)) continue;
      keep.set(marker, id);
      grew = true;
    }
    if (!grew) {
      const result = keep.size ? healDesignHtmlIdentities(named, { native: true, only: new Set(keep.values()) }).source : named;
      return { source: result, changed: result !== source };
    }
  }
  return everything();
}
