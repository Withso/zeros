import {
  parse,
  parseFragment,
  type DefaultTreeAdapterTypes,
  type ParserError,
} from "parse5";
import postcss from "postcss";

import { designNodeIdSchema } from "@zeros/design-core";

import { normalizeDesignCssProperty, validateDesignCssValue } from "./css";

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

function isBodyDescendant(element: Element): boolean {
  let parent: Node | null = element.parentNode;
  while (parent) {
    if ("tagName" in parent && parent.tagName === "body") return true;
    parent = "parentNode" in parent ? parent.parentNode : null;
  }
  return false;
}

function isDesignElement(element: Element): boolean {
  return isBodyDescendant(element) && !NON_DESIGN_TAGS.has(element.tagName);
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

function nearestParentId(element: Element): string | null {
  let parent = element.parentNode;
  while (parent && "tagName" in parent) {
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
  const diagnostics: DesignWebDiagnostic[] = parseErrors.map((error) => ({
    severity: "error",
    code: "html-parse",
    message: `HTML parse error: ${error.code}`,
    file: input.entryFile,
    ...(parserErrorSpan(error) ? { span: parserErrorSpan(error) } : {}),
  }));
  const records = elements(document).filter(isDesignElement);
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

function elementForMutation(source: string, nodeId: string): Element {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const matches = elements(document).filter(
    (element) => isDesignElement(element) && oid(element) === nodeId,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      matches.length > 1
        ? `Design element is not unique: ${nodeId}`
        : `Design element not found: ${nodeId}`,
    );
  }
  return matches[0];
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

export function mutateDesignNodeTextSource(
  source: string,
  nodeId: string,
  text: string,
): string {
  if (text.length > 100_000) throw new Error("Design text is too long.");
  const element = elementForMutation(source, nodeId);
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

function isContainedDesignReference(reference: string): boolean {
  const value = reference.trim();
  if (!value || value.startsWith("#")) return true;
  if (
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /%(?:2e|2f|5c)/i.test(value)
  ) {
    return false;
  }
  const pathname = value.split(/[?#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(pathname)
      .split("/")
      .every((segment) => segment !== "..");
  } catch {
    return false;
  }
}

function assertSafeStyleSource(source: string, owner: string): void {
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
    validateDesignCssValue(property, declaration.value);
  });
}

function assertSafeInlineStyle(source: string): void {
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
    validateDesignCssValue(property, node.value);
  }
}

function elementText(element: Element): string {
  return element.childNodes
    .filter((node): node is DefaultTreeAdapterTypes.TextNode => "value" in node)
    .map((node) => node.value)
    .join("");
}

function assertSafeElements(records: readonly Element[]): void {
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
      assertSafeStyleSource(elementText(element), "<style>");
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
        assertSafeInlineStyle(attribute.value);
        continue;
      }
      if (name === "srcset") {
        const candidates = attribute.value
          .split(",")
          .map((candidate) => candidate.trim().split(/\s+/, 1)[0] ?? "")
          .filter(Boolean);
        if (
          candidates.length === 0 ||
          candidates.some((candidate) => !isContainedDesignReference(candidate))
        ) {
          throw new Error(
            "srcset references must stay inside the design document.",
          );
        }
        continue;
      }
      if (
        URL_ATTRIBUTES.has(name) &&
        !isContainedDesignReference(attribute.value)
      ) {
        throw new Error(
          `URL in ${attribute.name} must stay inside the design document.`,
        );
      }
    }
  }
}

export function assertSafeDesignHtmlFragment(html: string): void {
  if (html.length > 500_000) throw new Error("Design HTML is too long.");
  const parseErrors: ParserError[] = [];
  const fragment = parseFragment(html, {
    sourceCodeLocationInfo: true,
    onParseError: (error) => parseErrors.push(error),
  });
  if (parseErrors.length > 0) {
    throw new Error(`Invalid design HTML (${parseErrors[0]!.code}).`);
  }
  assertSafeElements(fragmentElements(fragment));
}

export function assertSafeDesignHtmlDocument(html: string): void {
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
  assertSafeElements(records);
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
): string {
  assertSafeDesignHtmlFragment(html);
  const element = elementForMutation(source, nodeId);
  const location = element.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) {
    throw new Error(`Design element cannot contain HTML: ${nodeId}`);
  }
  const start =
    mode === "append"
      ? location.endTag.startOffset
      : location.startTag.endOffset;
  return `${source.slice(0, start)}${html}${source.slice(location.endTag.startOffset)}`;
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
    !isContainedDesignReference(value)
  ) {
    throw new Error(`URL in ${name} must stay inside the design document.`);
  }
  if (value !== null && value.length > 100_000) {
    throw new Error(`Design attribute is too long: ${name}.`);
  }
  const element = elementForMutation(source, nodeId);
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
export function healDesignHtmlIdentities(source: string): {
  source: string;
  changed: boolean;
  healed: number;
} {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = elements(document).filter(isDesignElement);
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
    const base = identityBase(element.tagName, location.startOffset, source);
    let next = base;
    for (let suffix = 2; used.has(next); suffix += 1)
      next = `${base}-${suffix}`;
    used.add(next);
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
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return { source: result, changed: result !== source, healed: edits.length };
}
