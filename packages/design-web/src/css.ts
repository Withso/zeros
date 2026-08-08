import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";

import type {
  DesignAuthoredKeyframes,
  DesignAuthoredDeclaration,
  DesignRuntimeMatchedDeclaration,
  DesignSourceSpan,
  DesignStyleMutationDecision,
  DesignStyleProvenance,
  DesignWebDiagnostic,
  DesignWebDocumentState,
} from "./model";

export type DesignStyleMutationValue = string | null;

interface InlineDeclaration {
  property: string;
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
  value: string;
  important: boolean;
}

interface InlineStyleAttribute {
  file: string;
  attributeStart: number;
  attributeEnd: number;
  contentStart: number;
  before: string;
  content: string;
  after: string;
  quote: string;
  declarations: InlineDeclaration[];
}

interface StylesheetCandidate {
  declaration: DesignAuthoredDeclaration;
  node: Declaration;
  source: string;
  offsetBase: number;
}

interface AuthoredStylesheet {
  file: string;
  source: string;
  offsetBase: number;
}

interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

export class DesignStyleAmbiguityError extends Error {
  readonly code = "DESIGN_STYLE_AMBIGUOUS";

  constructor(
    readonly nodeId: string,
    readonly property: string,
    readonly candidateCount: number,
  ) {
    super(
      candidateCount === 0
        ? `No authored rule can be targeted for ${property} on ${nodeId}.`
        : `${candidateCount} authored rules could be targeted for ${property} on ${nodeId}.`,
    );
    this.name = "DesignStyleAmbiguityError";
  }
}

export function normalizeDesignCssProperty(value: string): string {
  const normalized = value.startsWith("--")
    ? value.trim()
    : value
        .trim()
        .replace(/([A-Z])/g, "-$1")
        .toLowerCase();
  if (
    normalized.length > 128 ||
    (!/^--[A-Za-z0-9_-]+$/.test(normalized) &&
      !/^-?[a-z][a-z0-9-]*$/.test(normalized))
  ) {
    throw new Error(`Invalid CSS property: ${value}`);
  }
  return normalized;
}

export function validateDesignCssValue(
  property: string,
  value: string,
): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048) {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  let root: postcss.Root;
  try {
    root = postcss.parse(`a{${property}:${normalized}}`);
  } catch {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  const rule = root.first;
  if (
    root.nodes.length !== 1 ||
    rule?.type !== "rule" ||
    rule.nodes?.length !== 1 ||
    rule.first?.type !== "decl" ||
    rule.first.prop !== property
  ) {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  if (
    /(?:expression\s*\(|javascript\s*:|vbscript\s*:|@import\b)/i.test(
      normalized,
    )
  ) {
    throw new Error(`Invalid CSS value for ${property}.`);
  }
  const urlFunctions = [
    ...normalized.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)]*))\s*\)/gi),
  ];
  const urlStarts = normalized.match(/url\s*\(/gi)?.length ?? 0;
  if (urlStarts !== urlFunctions.length) {
    throw new Error(`Invalid CSS value for ${property}: malformed URL.`);
  }
  for (const match of urlFunctions) {
    const reference = (match[2] ?? match[3] ?? "").trim();
    if (!isContainedDesignReference(reference)) {
      throw new Error(
        `Invalid CSS value for ${property}: URL must stay inside the design document.`,
      );
    }
  }
  return normalized;
}

function isContainedDesignReference(reference: string): boolean {
  if (!reference || reference.startsWith("#")) return true;
  if (
    /[\\\u0000-\u001f\u007f]/.test(reference) ||
    reference.startsWith("/") ||
    reference.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(reference) ||
    /%(?:2e|2f|5c)/i.test(reference)
  ) {
    return false;
  }
  const pathname = reference.split(/[?#]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(pathname)
      .split("/")
      .every((segment) => segment !== "..");
  } catch {
    return false;
  }
}

function inlineDeclarations(value: string): InlineDeclaration[] {
  const declarations: InlineDeclaration[] = [];
  let segmentStart = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  const finish = (segmentEnd: number, end: number) => {
    let colon = -1;
    let localQuote = "";
    let localEscaped = false;
    let localDepth = 0;
    for (let index = segmentStart; index < segmentEnd; index += 1) {
      const character = value[index] ?? "";
      if (localEscaped) {
        localEscaped = false;
        continue;
      }
      if (character === "\\") {
        localEscaped = true;
        continue;
      }
      if (localQuote) {
        if (character === localQuote) localQuote = "";
        continue;
      }
      if (character === '"' || character === "'") {
        localQuote = character;
        continue;
      }
      if (character === "(" || character === "[") localDepth += 1;
      else if (character === ")" || character === "]")
        localDepth = Math.max(0, localDepth - 1);
      else if (character === ":" && localDepth === 0) {
        colon = index;
        break;
      }
    }
    if (colon >= 0) {
      const property = value.slice(segmentStart, colon).trim();
      let valueStart = colon + 1;
      let valueEnd = segmentEnd;
      while (/\s/.test(value[valueStart] ?? "")) valueStart += 1;
      while (valueEnd > valueStart && /\s/.test(value[valueEnd - 1] ?? ""))
        valueEnd -= 1;
      if (property) {
        const rawValue = value.slice(valueStart, valueEnd);
        const important = /!\s*important\s*$/i.test(rawValue);
        try {
          declarations.push({
            property: normalizeDesignCssProperty(property),
            start: segmentStart,
            end,
            valueStart,
            valueEnd,
            value: rawValue.replace(/\s*!\s*important\s*$/i, "").trimEnd(),
            important,
          });
        } catch {
          // Preserve malformed neighboring bytes. A valid requested
          // declaration remains inspectable and surgically editable.
        }
      }
    }
    segmentStart = end;
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]")
      depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) finish(index, index + 1);
  }
  if (segmentStart < value.length) finish(value.length, value.length);
  return declarations;
}

function styleAttributeContent(raw: string): {
  before: string;
  content: string;
  after: string;
  quote: string;
  contentOffset: number;
} | null {
  const equal = raw.indexOf("=");
  if (equal < 0) return null;
  let contentStart = equal + 1;
  while (/\s/.test(raw[contentStart] ?? "")) contentStart += 1;
  const quote = raw[contentStart] === "'" ? "'" : '"';
  if (raw[contentStart] === quote) {
    const contentEnd = raw.lastIndexOf(quote);
    if (contentEnd <= contentStart) return null;
    return {
      before: raw.slice(0, contentStart + 1),
      content: raw.slice(contentStart + 1, contentEnd),
      after: raw.slice(contentEnd),
      quote,
      contentOffset: contentStart + 1,
    };
  }
  return {
    // Adding a value containing whitespace to an unquoted attribute would
    // otherwise turn the remainder into new HTML attributes. Normalize this
    // rare legacy shape to a quoted attribute before editing it.
    before: `${raw.slice(0, contentStart)}"`,
    content: raw.slice(contentStart),
    after: '"',
    quote: '"',
    contentOffset: contentStart,
  };
}

function designElements(
  document: DefaultTreeAdapterTypes.Document,
): DefaultTreeAdapterTypes.Element[] {
  const result: DefaultTreeAdapterTypes.Element[] = [];
  const plumbing = new Set([
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
  let body: DefaultTreeAdapterTypes.Element | null = null;
  const findBody = (
    node: DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.Element,
  ) => {
    for (const child of node.childNodes ?? []) {
      if (!("tagName" in child)) continue;
      if (child.tagName === "body") body = child;
      else findBody(child);
    }
  };
  findBody(document);
  const visit = (node: DefaultTreeAdapterTypes.Element) => {
    for (const child of node.childNodes ?? []) {
      if (!("tagName" in child)) continue;
      if (!plumbing.has(child.tagName)) result.push(child);
      if (child.tagName !== "template") visit(child);
    }
  };
  if (body) visit(body);
  return result;
}

function inlineStyleForNode(
  file: string,
  source: string,
  nodeId: string,
): InlineStyleAttribute | null {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const matches = designElements(document).filter(
    (element) =>
      element.attrs
        .find((attribute) => attribute.name === "data-oid")
        ?.value.trim() === nodeId,
  );
  if (matches.length !== 1 || !matches[0]) {
    throw new Error(
      matches.length > 1
        ? `Design element is not unique: ${nodeId}`
        : `Design element not found: ${nodeId}`,
    );
  }
  const location = matches[0].sourceCodeLocation?.attrs?.style;
  if (!location) return null;
  const raw = source.slice(location.startOffset, location.endOffset);
  const attribute = styleAttributeContent(raw);
  if (!attribute) throw new Error("Malformed design style attribute.");
  return {
    file,
    attributeStart: location.startOffset,
    attributeEnd: location.endOffset,
    contentStart: location.startOffset + attribute.contentOffset,
    before: attribute.before,
    content: attribute.content,
    after: attribute.after,
    quote: attribute.quote,
    declarations: inlineDeclarations(attribute.content),
  };
}

function escapeStyleValue(value: string, quote: string): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return quote === "'"
    ? escaped.replace(/'/g, "&#39;")
    : escaped.replace(/"/g, "&quot;");
}

function mutateInlineStyles(
  source: string,
  nodeId: string,
  styles: ReadonlyMap<string, DesignStyleMutationValue>,
): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const matches = designElements(document).filter(
    (element) =>
      element.attrs
        .find((attribute) => attribute.name === "data-oid")
        ?.value.trim() === nodeId,
  );
  const element = matches.length === 1 ? matches[0] : undefined;
  if (!element) {
    throw new Error(
      matches.length > 1
        ? `Design element is not unique: ${nodeId}`
        : `Design element not found: ${nodeId}`,
    );
  }
  const startTag = element.sourceCodeLocation?.startTag;
  if (!startTag)
    throw new Error(`Design element has no authored start tag: ${nodeId}`);
  const location = element.sourceCodeLocation?.attrs?.style;
  if (!location) {
    const declarations = [...styles]
      .filter((entry): entry is [string, string] => entry[1] !== null)
      .map(
        ([property, value]) => `${property}:${escapeStyleValue(value, '"')};`,
      )
      .join(" ");
    if (!declarations) return source;
    const close = source.lastIndexOf(">", startTag.endOffset - 1);
    if (close < startTag.startOffset)
      throw new Error("Malformed design start tag.");
    const slash = source.slice(startTag.startOffset, close).match(/\/\s*$/);
    const insertAt =
      slash?.index === undefined ? close : startTag.startOffset + slash.index;
    return `${source.slice(0, insertAt)} style="${declarations}"${source.slice(insertAt)}`;
  }
  const raw = source.slice(location.startOffset, location.endOffset);
  const attribute = styleAttributeContent(raw);
  if (!attribute) throw new Error("Malformed design style attribute.");
  let content = attribute.content;
  const declarations = inlineDeclarations(content);
  const edits: SourceEdit[] = [];
  const additions: Array<[string, string]> = [];
  for (const [property, value] of styles) {
    const matchesForProperty = declarations.filter(
      (item) => item.property === property,
    );
    const existing = matchesForProperty.at(-1);
    if (!existing) {
      if (value !== null) additions.push([property, value]);
      continue;
    }
    if (value === null) {
      for (const match of matchesForProperty)
        edits.push({ start: match.start, end: match.end, text: "" });
    } else {
      const suffix = existing.important ? " !important" : "";
      edits.push({
        start: existing.valueStart,
        end: existing.valueEnd,
        text: `${escapeStyleValue(value, attribute.quote)}${suffix}`,
      });
    }
  }
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    content = `${content.slice(0, edit.start)}${edit.text}${content.slice(edit.end)}`;
  }
  if (additions.length > 0) {
    const separator = content.trim()
      ? content.trimEnd().endsWith(";")
        ? " "
        : "; "
      : "";
    content = `${content}${separator}${additions
      .map(
        ([property, value]) =>
          `${property}:${escapeStyleValue(value, attribute.quote)};`,
      )
      .join(" ")}`;
  }
  const replacement = `${attribute.before}${content}${attribute.after}`;
  return `${source.slice(0, location.startOffset)}${replacement}${source.slice(location.endOffset)}`;
}

function lineAndColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return { line, column };
}

function sourceSpan(
  source: string,
  startOffset: number,
  endOffset: number,
): DesignSourceSpan {
  const start = lineAndColumn(source, startOffset);
  const end = lineAndColumn(source, endOffset);
  return {
    startOffset,
    endOffset,
    startLine: start.line,
    startColumn: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function splitSelectorList(selector: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]")
      depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      result.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  result.push(selector.slice(start).trim());
  return result.filter(Boolean);
}

function selectorTargetsNode(selector: string, nodeId: string): boolean {
  for (const part of splitSelectorList(selector)) {
    const matches = [
      ...part.matchAll(
        /\[\s*data-oid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]/gi,
      ),
    ];
    const match = matches.at(-1);
    if (!match) continue;
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    if (value !== nodeId) continue;
    const suffix = part.slice((match.index ?? 0) + match[0].length);
    if (!/[\s>+~]/.test(suffix)) return true;
  }
  return false;
}

function selectorExactlyTargetsNode(selector: string, nodeId: string): boolean {
  const parts = splitSelectorList(selector);
  if (parts.length !== 1 || !parts[0]) return false;
  const part = parts[0].trim();
  const match =
    /^\[\s*data-oid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*\]$/i.exec(part);
  return Boolean(match && (match[1] ?? match[2] ?? match[3] ?? "") === nodeId);
}

function declarationOffsets(
  source: string,
  declaration: Declaration,
): {
  start: number;
  end: number;
  valueStart: number;
  valueEnd: number;
} | null {
  const start = declaration.source?.start?.offset;
  const exclusiveEnd = declaration.source?.end?.offset;
  if (start === undefined || exclusiveEnd === undefined) return null;
  const end = Math.min(source.length, exclusiveEnd);
  const segment = source.slice(start, end);
  const colon = segment.indexOf(":");
  if (colon < 0) return null;
  let valueStart = start + colon + 1;
  while (/\s/.test(source[valueStart] ?? "")) valueStart += 1;
  let valueEnd = end;
  while (valueEnd > valueStart && /\s/.test(source[valueEnd - 1] ?? ""))
    valueEnd -= 1;
  if (source[valueEnd - 1] === ";") valueEnd -= 1;
  while (valueEnd > valueStart && /\s/.test(source[valueEnd - 1] ?? ""))
    valueEnd -= 1;
  if (declaration.important) {
    const raw = source.slice(valueStart, valueEnd);
    const important = /\s*!\s*important\s*$/i.exec(raw);
    if (important?.index !== undefined) valueEnd = valueStart + important.index;
    while (valueEnd > valueStart && /\s/.test(source[valueEnd - 1] ?? ""))
      valueEnd -= 1;
  }
  return { start, end, valueStart, valueEnd };
}

function ruleClosingBraceOffset(source: string, rule: Rule): number | null {
  const exclusiveEnd = rule.source?.end?.offset;
  if (
    exclusiveEnd === undefined ||
    exclusiveEnd < 1 ||
    source[exclusiveEnd - 1] !== "}"
  ) {
    return null;
  }
  return exclusiveEnd - 1;
}

function conditionsFor(node: Declaration): string[] {
  const conditions: string[] = [];
  let parent = node.parent as
    | { type: string; parent?: unknown; name?: string; params?: string }
    | undefined;
  while (parent) {
    if (parent.type === "atrule") {
      const atRule = parent as AtRule;
      conditions.unshift(
        `@${atRule.name}${atRule.params ? ` ${atRule.params}` : ""}`,
      );
    }
    parent = parent.parent as typeof parent;
  }
  return conditions;
}

function authoredStylesheets(
  state: DesignWebDocumentState,
): AuthoredStylesheet[] {
  const stylesheets: AuthoredStylesheet[] = [];
  for (const [file, source] of Object.entries(state.files)) {
    if (file.toLowerCase().endsWith(".css")) {
      stylesheets.push({ file, source, offsetBase: 0 });
      continue;
    }
    if (!file.toLowerCase().endsWith(".html")) continue;
    const document = parse(source, { sourceCodeLocationInfo: true });
    // designElements intentionally excludes head plumbing, including the
    // normal location for authored <style>, so traverse all parsed elements.
    const pending: Array<
      DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.Element
    > = [document];
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const child of current.childNodes ?? []) {
        if (!("tagName" in child)) continue;
        pending.push(child);
        if (
          child.tagName !== "style" ||
          !child.sourceCodeLocation?.startTag ||
          !child.sourceCodeLocation.endTag
        ) {
          continue;
        }
        const start = child.sourceCodeLocation.startTag.endOffset;
        const end = child.sourceCodeLocation.endTag.startOffset;
        if (
          !stylesheets.some(
            (stylesheet) =>
              stylesheet.file === file && stylesheet.offsetBase === start,
          )
        ) {
          stylesheets.push({
            file,
            source: source.slice(start, end),
            offsetBase: start,
          });
        }
      }
    }
  }
  return stylesheets;
}

function stylesheetCandidates(
  state: DesignWebDocumentState,
  nodeId: string,
  property: string,
  runtimeSelectors: ReadonlySet<string> = new Set(),
): StylesheetCandidate[] {
  const candidates: StylesheetCandidate[] = [];
  for (const stylesheet of authoredStylesheets(state)) {
    const { file, source, offsetBase } = stylesheet;
    let root: postcss.Root;
    try {
      root = postcss.parse(source, { from: file });
    } catch {
      continue;
    }
    root.walkRules((rule) => {
      if (
        !selectorTargetsNode(rule.selector, nodeId) &&
        !runtimeSelectors.has(rule.selector.trim())
      ) {
        return;
      }
      for (const declaration of directRuleDeclarations(rule, property)) {
        const offsets = declarationOffsets(source, declaration);
        if (!offsets) continue;
        candidates.push({
          node: declaration,
          source,
          offsetBase,
          declaration: {
            origin: file.startsWith("components/")
              ? "component"
              : property.startsWith("--")
                ? "token"
                : "stylesheet",
            property,
            value: declaration.value,
            important: declaration.important,
            file,
            selector: rule.selector,
            conditions: conditionsFor(declaration),
            span: sourceSpan(
              state.files[file]!,
              offsetBase + offsets.start,
              offsetBase + offsets.end,
            ),
            writable: true,
          },
        });
      }
    });
  }
  return candidates;
}

function directRuleDeclarations(rule: Rule, property: string): Declaration[] {
  const result: Declaration[] = [];
  for (const node of rule.nodes ?? []) {
    if (node.type !== "decl") continue;
    try {
      if (normalizeDesignCssProperty(node.prop) === property) result.push(node);
    } catch {
      // A malformed neighboring declaration does not own this property.
    }
  }
  return result;
}

function inlineAuthoredDeclarations(
  state: DesignWebDocumentState,
  nodeId: string,
  property: string,
): DesignAuthoredDeclaration[] {
  const source = state.files[state.entryFile];
  if (source === undefined) return [];
  const inline = inlineStyleForNode(state.entryFile, source, nodeId);
  if (!inline) return [];
  return inline.declarations
    .filter((declaration) => declaration.property === property)
    .map((declaration) => ({
      origin: property.startsWith("--") ? "token" : "inline",
      property,
      value: declaration.value,
      important: declaration.important,
      file: state.entryFile,
      selector: null,
      conditions: [],
      span: sourceSpan(
        source,
        inline.contentStart + declaration.start,
        inline.contentStart + declaration.end,
      ),
      writable: true,
    }));
}

export function readDesignStyleProvenance(
  state: DesignWebDocumentState,
  input: {
    nodeId: string;
    property: string;
    computedValue?: string | null;
    matched?: readonly DesignRuntimeMatchedDeclaration[];
  },
): DesignStyleProvenance {
  const property = normalizeDesignCssProperty(input.property);
  const activeRuntime = (input.matched ?? []).filter(
    (candidate) =>
      normalizeDesignCssProperty(candidate.property) === property &&
      candidate.active !== false,
  );
  const runtimeSelectors = new Set(
    (input.matched ?? [])
      .map((candidate) => candidate.selector?.trim())
      .filter((selector): selector is string => Boolean(selector)),
  );
  const inline = inlineAuthoredDeclarations(state, input.nodeId, property);
  const stylesheetRecords = stylesheetCandidates(
    state,
    input.nodeId,
    property,
    runtimeSelectors,
  );
  const stylesheets = stylesheetRecords.map(
    (candidate) => candidate.declaration,
  );
  const candidates = [...inline, ...stylesheets];
  let winner: DesignAuthoredDeclaration | null = null;
  let confidence: DesignStyleProvenance["confidence"] = "ambiguous";
  let reason =
    "Multiple authored declarations require runtime cascade correlation.";
  if (activeRuntime.length === 1) {
    const runtimeCandidate = activeRuntime[0]!;
    if (runtimeCandidate.inherited) {
      return {
        nodeId: input.nodeId,
        property,
        computedValue: input.computedValue ?? null,
        winner: null,
        candidates,
        origin: "inherited",
        confidence: "correlated",
        reason: "The renderer reports that the active value is inherited.",
      };
    }
    const correlated = candidates.filter(
      (candidate) =>
        (!runtimeCandidate.sourceFile ||
          candidate.file === runtimeCandidate.sourceFile ||
          (candidate.file.startsWith("components/") &&
            candidate.file ===
              `components/${runtimeCandidate.sourceFile}.html`)) &&
        (runtimeCandidate.selector
          ? candidate.selector?.trim() === runtimeCandidate.selector.trim()
          : candidate.selector === null) &&
        candidate.value === runtimeCandidate.value,
    );
    if (correlated.length === 1) {
      winner = correlated[0]!;
      confidence = "correlated";
      reason =
        "The renderer reported one active declaration and it correlated to one authored declaration.";
    } else {
      reason =
        "The renderer reported one active declaration, but it could not be uniquely correlated to authored source.";
    }
  } else if (activeRuntime.length > 1) {
    if (activeRuntime.every((candidate) => candidate.inherited)) {
      return {
        nodeId: input.nodeId,
        property,
        computedValue: input.computedValue ?? null,
        winner: null,
        candidates,
        origin: "inherited",
        confidence: "correlated",
        reason:
          "The renderer reports that all active declarations are inherited.",
      };
    }
    reason =
      "The renderer reported multiple active declarations; CSSOM enumeration does not identify the cascade winner.";
  } else if (
    candidates.length === 1 &&
    (candidates[0]!.selector === null ||
      (candidates[0]!.conditions.length === 0 &&
        selectorExactlyTargetsNode(candidates[0]!.selector!, input.nodeId)))
  ) {
    winner = candidates[0]!;
    confidence = "exact";
    reason = "Only one authored declaration targets this node and property.";
  } else if (
    inline.length > 0 &&
    !stylesheets.some((candidate) => candidate.important)
  ) {
    winner = inline.at(-1)!;
    confidence = "exact";
    reason =
      "The last inline declaration wins and no targeted stylesheet declaration is important.";
  } else if (candidates.length === 0) {
    confidence = "computed-only";
    reason = "No directly targeted authored declaration was found.";
  }
  return {
    nodeId: input.nodeId,
    property,
    computedValue: input.computedValue ?? null,
    winner,
    candidates,
    origin:
      winner?.origin ??
      (candidates.length > 0 || activeRuntime.length > 0
        ? "ambiguous"
        : "computed"),
    confidence,
    reason,
  };
}

function applyEdits(source: string, edits: readonly SourceEdit[]): string {
  let result = source;
  for (const edit of [...edits].sort(
    (left, right) => right.start - left.start,
  )) {
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;
  }
  return result;
}

export function mutateDesignNodeStyles(
  state: DesignWebDocumentState,
  input: {
    nodeId: string;
    styles: Readonly<Record<string, DesignStyleMutationValue>>;
    scope?: "auto" | "inline" | "rule" | "component" | "instance";
    responsiveContext?: string;
    stateContext?: string;
  },
): {
  files: Readonly<Record<string, string>>;
  decisions: DesignStyleMutationDecision[];
} {
  const entries = Object.entries(input.styles);
  if (entries.length === 0 || entries.length > 64) {
    throw new Error("styles must contain between 1 and 64 properties.");
  }
  const scope = input.scope ?? "auto";
  if (scope === "component" || scope === "instance") {
    throw new Error(`${scope} style scope is not available for this web node.`);
  }
  if ((input.responsiveContext ?? "base") !== "base") {
    throw new Error(
      "Responsive style mutation requires an explicit Foundation context adapter.",
    );
  }
  if ((input.stateContext ?? "default") !== "default") {
    throw new Error(
      "State-specific style mutation requires an explicit Foundation context adapter.",
    );
  }
  const normalized = entries.map(([rawProperty, rawValue]) => {
    const property = normalizeDesignCssProperty(rawProperty);
    return [
      property,
      rawValue === null ? null : validateDesignCssValue(property, rawValue),
    ] as const;
  });
  const files = { ...state.files };
  const inlineMutations = new Map<string, DesignStyleMutationValue>();
  const stylesheetEdits = new Map<string, SourceEdit[]>();
  const decisions: DesignStyleMutationDecision[] = [];
  for (const [property, value] of normalized) {
    const inline = inlineAuthoredDeclarations(state, input.nodeId, property);
    const allRules = stylesheetCandidates(state, input.nodeId, property);
    const rules =
      scope === "rule"
        ? allRules
        : allRules.filter(
            (candidate) =>
              candidate.declaration.conditions.length === 0 &&
              candidate.declaration.selector !== null &&
              selectorExactlyTargetsNode(
                candidate.declaration.selector,
                input.nodeId,
              ),
          );
    if (scope === "inline" || inline.length > 0) {
      inlineMutations.set(property, value);
      decisions.push({
        property,
        requestedScope: scope,
        appliedScope: "inline",
        file: state.entryFile,
        selector: null,
        reason: inline.length > 0 ? "existing-inline" : "explicit-inline",
      });
      continue;
    }
    if (rules.length === 1) {
      const rule = rules[0]!;
      const offsets = declarationOffsets(rule.source, rule.node);
      if (!offsets)
        throw new Error(`CSS declaration has no source span: ${property}`);
      const edits = stylesheetEdits.get(rule.declaration.file) ?? [];
      if (value === null) {
        edits.push({
          start: rule.offsetBase + offsets.start,
          end: rule.offsetBase + offsets.end,
          text: "",
        });
      } else {
        edits.push({
          start: rule.offsetBase + offsets.valueStart,
          end: rule.offsetBase + offsets.valueEnd,
          text: value,
        });
      }
      stylesheetEdits.set(rule.declaration.file, edits);
      decisions.push({
        property,
        requestedScope: scope,
        appliedScope: "rule",
        file: rule.declaration.file,
        selector: rule.declaration.selector,
        reason: "single-authored-rule",
      });
      continue;
    }
    if (scope === "rule") {
      throw new DesignStyleAmbiguityError(input.nodeId, property, rules.length);
    }
    if (
      (value === null && allRules.length > 0) ||
      allRules.some((rule) => rule.declaration.important)
    ) {
      throw new DesignStyleAmbiguityError(
        input.nodeId,
        property,
        allRules.length,
      );
    }
    inlineMutations.set(property, value);
    decisions.push({
      property,
      requestedScope: scope,
      appliedScope: "inline",
      file: state.entryFile,
      selector: null,
      reason:
        allRules.length === 0
          ? "inline-fallback-no-rule"
          : "inline-fallback-ambiguous-rule",
    });
  }
  if (inlineMutations.size > 0) {
    files[state.entryFile] = mutateInlineStyles(
      files[state.entryFile]!,
      input.nodeId,
      inlineMutations,
    );
  }
  for (const [file, edits] of stylesheetEdits) {
    files[file] = applyEdits(files[file]!, edits);
  }
  return { files, decisions };
}

/** Mutate one exact selector/property pair for a parameter binding. Missing
 * declarations are appended to the one unambiguous authored rule. */
export function mutateDesignCssRuleDeclaration(
  source: string,
  selector: string,
  rawProperty: string,
  rawValue: string,
): string {
  const property = normalizeDesignCssProperty(rawProperty);
  const value = validateDesignCssValue(property, rawValue);
  const root = postcss.parse(source);
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selector.trim() === selector.trim()) rules.push(rule);
  });
  if (rules.length !== 1 || !rules[0]) {
    throw new DesignStyleAmbiguityError(selector, property, rules.length);
  }
  const declarations = directRuleDeclarations(rules[0], property);
  if (declarations.length > 1) {
    throw new DesignStyleAmbiguityError(
      selector,
      property,
      declarations.length,
    );
  }
  if (declarations[0]) {
    const offsets = declarationOffsets(source, declarations[0]);
    if (!offsets)
      throw new Error(`CSS declaration has no source span: ${property}`);
    return `${source.slice(0, offsets.valueStart)}${value}${source.slice(offsets.valueEnd)}`;
  }
  const ruleEnd = ruleClosingBraceOffset(source, rules[0]);
  if (ruleEnd === null) {
    throw new Error(`CSS rule has no authored closing brace: ${selector}`);
  }
  const beforeClose = source.slice(0, ruleEnd);
  const multiline = beforeClose
    .slice(beforeClose.lastIndexOf("{") + 1)
    .includes("\n");
  const insertion = multiline
    ? `  ${property}: ${value};\n`
    : ` ${property}: ${value}; `;
  return `${source.slice(0, ruleEnd)}${insertion}${source.slice(ruleEnd)}`;
}

/** Return the normalized theme represented by one exact token selector. The
 * reader and byte-preserving mutator share this matcher so alternate quote and
 * optional :root spellings cannot diverge. */
export function designTokenThemeName(selector: string): string | null {
  const match =
    /^\s*(?::root)?\[data-zd-theme\s*=\s*(["'])([a-z][a-z0-9_-]{0,63})\1\]\s*$/.exec(
      selector,
    );
  return match?.[2] ?? null;
}

/** Update one typed design token without reserializing neighboring CSS. A
 * missing theme rule is appended deterministically; undo still restores exact
 * bytes through the transaction adapter's source splice inverse. */
export function mutateDesignTokenDeclaration(
  source: string,
  rawName: string,
  theme: string | null,
  rawValue: string | null,
): string {
  const name = normalizeDesignCssProperty(rawName);
  if (!name.startsWith("--")) {
    throw new Error("Design token names must be CSS custom properties.");
  }
  if (theme !== null && !/^[a-z][a-z0-9_-]{0,63}$/.test(theme)) {
    throw new Error("Design token theme is invalid.");
  }
  const selector = theme === null ? ":root" : `[data-zd-theme="${theme}"]`;
  const value =
    rawValue === null ? null : validateDesignCssValue(name, rawValue);
  const root = postcss.parse(source);
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    const matches =
      theme === null
        ? rule.selector.trim() === selector
        : designTokenThemeName(rule.selector) === theme;
    if (matches) rules.push(rule);
  });
  if (rules.length > 1) {
    throw new DesignStyleAmbiguityError(selector, name, rules.length);
  }
  const rule = rules[0];
  if (!rule) {
    if (value === null) return source;
    const separator =
      source.length === 0 ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    return `${source}${separator}${selector} {\n  ${name}: ${value};\n}\n`;
  }
  const declarations = directRuleDeclarations(rule, name);
  if (declarations.length > 1) {
    throw new DesignStyleAmbiguityError(selector, name, declarations.length);
  }
  const declaration = declarations[0];
  if (declaration) {
    const offsets = declarationOffsets(source, declaration);
    if (!offsets)
      throw new Error(`CSS declaration has no source span: ${name}`);
    if (value === null) {
      return `${source.slice(0, offsets.start)}${source.slice(offsets.end)}`;
    }
    return `${source.slice(0, offsets.valueStart)}${value}${source.slice(offsets.valueEnd)}`;
  }
  if (value === null) return source;
  const ruleEnd = ruleClosingBraceOffset(source, rule);
  if (ruleEnd === null) {
    throw new Error(`CSS rule has no authored closing brace: ${selector}`);
  }
  const beforeClose = source.slice(0, ruleEnd);
  const multiline = beforeClose
    .slice(beforeClose.lastIndexOf("{") + 1)
    .includes("\n");
  const insertion = multiline
    ? `  ${name}: ${value};\n`
    : ` ${name}: ${value}; `;
  return `${source.slice(0, ruleEnd)}${insertion}${source.slice(ruleEnd)}`;
}

export interface DesignKeyframeInput {
  offset: number;
  styles: Readonly<Record<string, string>>;
}

const DESIGN_MAX_KEYFRAME_DEFINITIONS = 128;
const DESIGN_MAX_PROJECTED_KEYFRAMES = 32;
const DESIGN_MAX_KEYFRAME_STYLES = 64;

function designKeyframeOffset(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "from") return 0;
  if (normalized === "to") return 100;
  const match = /^(-?\d+(?:\.\d+)?)%$/.exec(normalized);
  if (!match?.[1]) return null;
  const offset = Number(match[1]);
  return Number.isFinite(offset) && offset >= 0 && offset <= 100
    ? offset
    : null;
}

/** Read authored CSS motion into deterministic, bounded timeline data. Complex
 * or malformed selectors are ignored without hiding the rest of the file. */
export function readDesignKeyframes(
  files: Readonly<Record<string, string>>,
): DesignAuthoredKeyframes[] {
  const definitions: DesignAuthoredKeyframes[] = [];
  for (const file of Object.keys(files).sort()) {
    if (!file.toLowerCase().endsWith(".css")) continue;
    let root: postcss.Root;
    try {
      root = postcss.parse(files[file]!, { from: file });
    } catch {
      continue;
    }
    root.walkAtRules((atRule) => {
      if (
        definitions.length >= DESIGN_MAX_KEYFRAME_DEFINITIONS ||
        atRule.name.toLowerCase() !== "keyframes"
      ) {
        return;
      }
      const name = atRule.params.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(name)) return;
      const byOffset = new Map<number, Record<string, string>>();
      for (const child of atRule.nodes ?? []) {
        if (child.type !== "rule") continue;
        const styles: Record<string, string> = {};
        for (const declaration of child.nodes ?? []) {
          if (
            declaration.type !== "decl" ||
            Object.keys(styles).length >= DESIGN_MAX_KEYFRAME_STYLES
          ) {
            continue;
          }
          try {
            styles[normalizeDesignCssProperty(declaration.prop)] =
              declaration.value.trim();
          } catch {
            // Preserve other valid declarations in an otherwise usable frame.
          }
        }
        if (Object.keys(styles).length === 0) continue;
        for (const selector of child.selector.split(",")) {
          const offset = designKeyframeOffset(selector);
          if (offset === null) continue;
          const current = byOffset.get(offset) ?? {};
          Object.assign(current, styles);
          byOffset.set(offset, current);
        }
      }
      const keyframes = [...byOffset.entries()]
        .sort(([left], [right]) => left - right)
        .slice(0, DESIGN_MAX_PROJECTED_KEYFRAMES)
        .map(([offset, styles]) => ({ offset, styles }));
      if (keyframes.length > 0) definitions.push({ file, name, keyframes });
    });
  }
  return definitions;
}

/** Create or surgically replace one named keyframe block. Neighboring CSS is
 * byte-preserved; transaction inverses restore the previous block exactly. */
export function mutateDesignKeyframes(
  source: string,
  input: { name: string; keyframes: readonly DesignKeyframeInput[] },
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(input.name)) {
    throw new Error("Design keyframe name is invalid.");
  }
  if (input.keyframes.length < 2 || input.keyframes.length > 32) {
    throw new Error("Design motion requires between 2 and 32 keyframes.");
  }
  const offsets = new Set<number>();
  const keyframes = input.keyframes
    .map((keyframe) => {
      if (
        !Number.isFinite(keyframe.offset) ||
        keyframe.offset < 0 ||
        keyframe.offset > 100 ||
        offsets.has(keyframe.offset)
      ) {
        throw new Error(
          "Design keyframe offsets must be unique from 0 to 100.",
        );
      }
      offsets.add(keyframe.offset);
      const entries = Object.entries(keyframe.styles);
      if (entries.length === 0 || entries.length > 64) {
        throw new Error(
          "Each design keyframe requires between 1 and 64 styles.",
        );
      }
      const styles = entries.map(([rawProperty, rawValue]) => {
        const property = normalizeDesignCssProperty(rawProperty);
        const value = validateDesignCssValue(property, rawValue);
        return `${property}: ${value};`;
      });
      return { offset: keyframe.offset, styles };
    })
    .sort((left, right) => left.offset - right.offset);
  const block = `@keyframes ${input.name} {\n${keyframes
    .map((keyframe) => `  ${keyframe.offset}% { ${keyframe.styles.join(" ")} }`)
    .join("\n")}\n}`;
  const root = postcss.parse(source);
  const matches: AtRule[] = [];
  root.walkAtRules((rule) => {
    if (
      rule.name.toLowerCase() === "keyframes" &&
      rule.params.trim() === input.name
    ) {
      matches.push(rule);
    }
  });
  if (matches.length > 1) {
    throw new Error(`Design keyframes are ambiguous: ${input.name}`);
  }
  const match = matches[0];
  if (!match) {
    const separator =
      source.length === 0 ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    return `${source}${separator}${block}\n`;
  }
  const start = match.source?.start?.offset;
  const end = match.source?.end?.offset;
  if (start === undefined || end === undefined) {
    throw new Error(`Design keyframes have no authored span: ${input.name}`);
  }
  return `${source.slice(0, start)}${block}${source.slice(end)}`;
}

export function readDesignCssDiagnostics(
  files: Readonly<Record<string, string>>,
): DesignWebDiagnostic[] {
  const diagnostics: DesignWebDiagnostic[] = [];
  for (const [file, source] of Object.entries(files)) {
    if (!file.toLowerCase().endsWith(".css")) continue;
    try {
      postcss.parse(source, { from: file });
    } catch (error) {
      const reason = error as {
        reason?: string;
        line?: number;
        column?: number;
        endLine?: number;
        endColumn?: number;
      };
      diagnostics.push({
        severity: "error",
        code: "css-parse",
        message: `CSS parse error: ${reason.reason ?? "invalid stylesheet"}`,
        file,
        ...(reason.line && reason.column
          ? {
              span: {
                startOffset: 0,
                endOffset: 0,
                startLine: reason.line,
                startColumn: reason.column,
                endLine: reason.endLine ?? reason.line,
                endColumn: reason.endColumn ?? reason.column,
              },
            }
          : {}),
      });
    }
  }
  return diagnostics;
}
