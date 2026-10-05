import { parse, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";

/** Resolve URLs against the containing source file, bounded by the Design root.
 * This is lexical; filesystem readers still check the canonical target. */
export function resolveDesignLocalReference(reference: string, sourceFile = ""): string | null {
  const value = reference.trim();
  if (!value || value.startsWith("#") || /[\\\u0000-\u001f\u007f]/.test(value) ||
      value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value) || /%(?:2e|2f|5c)/i.test(value)) return null;
  let pathname: string;
  try { pathname = decodeURIComponent(value.split(/[?#]/, 1)[0]!); }
  catch { return null; }
  if (/[\\\u0000-\u001f\u007f]/.test(pathname) || pathname.startsWith("/")) return null;
  const sourceParts = sourceFile ? sourceFile.split("/") : [];
  if (sourceParts.some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f\u007f]/.test(part))) return null;
  if (!pathname) return sourceFile || null;
  const parts = sourceParts.slice(0, -1);
  for (const part of pathname.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

export function isContainedDesignReference(reference: string, sourceFile = ""): boolean {
  const value = reference.trim();
  return !value || value.startsWith("#") || resolveDesignLocalReference(value, sourceFile) !== null;
}

export interface DesignReferenceRebaseOptions {
  movedFiles?: Readonly<Record<string, string>>;
  strict?: boolean;
}

function unsafeReference(reference: string): never {
  throw new Error("Cannot safely rebase an unsupported or ambiguous Design reference: " + reference);
}

export function rebaseDesignReference(reference: string, fromFile: string, toFile: string, options: DesignReferenceRebaseOptions = {}): string {
  if (fromFile === toFile && !options.movedFiles && !options.strict) return reference;
  const value = reference.trim();
  if (!value || value.startsWith("#") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return reference;
  const target = resolveDesignLocalReference(reference, fromFile);
  if (!target) return options.strict ? unsafeReference(reference) : reference;
  const moved = options.movedFiles && Object.hasOwn(options.movedFiles, target) ? options.movedFiles[target] : undefined;
  if (options.strict && !moved && Object.keys(options.movedFiles ?? {}).some((file) => file.normalize("NFC").toLowerCase() === target.normalize("NFC").toLowerCase()))
    unsafeReference(reference);
  if (fromFile === toFile && !moved) return reference;
  const base = toFile.split("/").slice(0, -1);
  const destination = (moved ?? target).split("/");
  let shared = 0;
  while (shared < base.length && base[shared] === destination[shared]) shared++;
  const relative = [...base.slice(shared).map(() => ".."), ...destination.slice(shared).map(encodeURIComponent)].join("/") || ".";
  const trailingSlash = value.split(/[?#]/, 1)[0]!.endsWith("/") ? "/" : "";
  const suffix = value.match(/[?#][\s\S]*$/)?.[0] ?? "";
  return (reference.match(/^\s*/)?.[0] ?? "") + relative + trailingSlash + suffix + (reference.match(/\s*$/)?.[0] ?? "");
}

interface ReferenceSpan { start: number; end: number; url: string }
interface CssReferenceSpan extends ReferenceSpan { functionStart: number; functionEnd: number }

/** Skip comments and literal strings before looking for URL functions. Quoted
 * URLs may contain parentheses; CSS escapes remain unsupported by policy. */
export function designCssUrlReferences(value: string, strict = false): CssReferenceSpan[] {
  if (strict) {
    const syntax = value.replace(/\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, "");
    if (/(?:image-set|image)\s*\(/i.test(syntax) || /[a-z_-][a-z0-9_\\-]*\\[a-z0-9_\\-]*\s*\(/i.test(syntax))
      unsafeReference(value);
  }
  const tokens = /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?<![-\w\\])url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^)]*?))\s*\)/gi;
  const references: CssReferenceSpan[] = [];
  for (const match of value.matchAll(tokens)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw === undefined) continue;
    const url = raw.trim();
    if (strict && (url.includes("\\") || url.includes("/*") || /(?:var|attr|env)\s*\(/i.test(url)))
      unsafeReference(url);
    if (!url || url.includes("\\") || url.includes("/*")) continue;
    let start = match.index + match[0].indexOf("(") + 1;
    while (/\s/.test(value[start] ?? "") && start < value.length) start++;
    if (value[start] === '"' || value[start] === "'") start++;
    start += raw.length - raw.trimStart().length;
    references.push({ start, end: start + url.length, url, functionStart: match.index, functionEnd: match.index + match[0].length });
  }
  return references;
}

/** URL spans, retaining descriptors and data-URL commas rather than splitting
 * srcset on every comma. Offsets address the decoded attribute value. */
export function designSrcsetReferences(value: string): ReferenceSpan[] {
  const result: ReferenceSpan[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[\s,]/.test(value[cursor] ?? "") && cursor < value.length) cursor++;
    const start = cursor;
    while (cursor < value.length && !/\s/.test(value[cursor]!)) cursor++;
    let end = cursor;
    while (end > start && value[end - 1] === ",") end--;
    if (end > start) result.push({ start, end, url: value.slice(start, end) });
    if (end < cursor) continue;
    let depth = 0;
    while (cursor < value.length) {
      const character = value[cursor++]!;
      if (character === "(") depth++;
      else if (character === ")") depth--;
      else if (character === "," && depth === 0) break;
    }
  }
  return result;
}

function applyEdits(source: string, edits: Array<{ start: number; end: number; text: string }>): string {
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Use PostCSS's declaration offsets; comments and unrelated CSS retain their
 * original bytes. Unsupported URL spellings are left to the policy validator. */
export function rebaseDesignCssReferences(source: string, fromFile: string, toFile: string, options: DesignReferenceRebaseOptions = {}): string {
  if (fromFile === toFile && !options.movedFiles && !options.strict) return source;
  const root = postcss.parse(source);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  root.walkDecls((declaration) => {
    const start = declaration.source?.start?.offset;
    const end = declaration.source?.end?.offset;
    if (start === undefined || end === undefined) return;
    const authored = source.slice(start, end + 1);
    for (const reference of designCssUrlReferences(authored, options.strict)) {
      const next = rebaseDesignReference(reference.url, fromFile, toFile, options);
      if (next === reference.url) continue;
      edits.push({ start: start + reference.start, end: start + reference.end, text: next });
    }
  });
  root.walkAtRules((rule) => {
    if (options.strict && rule.name.includes("\\")) unsafeReference("@" + rule.name);
    if (rule.name.toLowerCase() !== "import") return;
    const start = rule.source?.start?.offset, end = rule.source?.end?.offset;
    if (start === undefined || end === undefined) {
      if (options.strict) unsafeReference(rule.params);
      return;
    }
    const authored = source.slice(start, end + 1);
    const references = designCssUrlReferences(authored, options.strict);
    if (!references.length) {
      const params = authored.slice(7);
      const match = /^(?:\s|\/\*[\s\S]*?\*\/)*(['"])([\s\S]*?)\1/.exec(params);
      if (!match) {
        if (options.strict) unsafeReference(rule.params);
        return;
      }
      const offset = 7 + match[0].indexOf(match[1]!) + 1;
      if (options.strict && match[2]!.includes("\\")) unsafeReference(match[2]!);
      references.push({ start: offset, end: offset + match[2]!.length, url: match[2]!, functionStart: offset, functionEnd: offset + match[2]!.length });
    }
    for (const reference of references) {
      const next = rebaseDesignReference(reference.url, fromFile, toFile, options);
      if (next !== reference.url) edits.push({ start: start + reference.start, end: start + reference.end, text: next });
    }
  });
  return applyEdits(source, edits);
}

/** Parser-backed value splices for render composition. Definition URLs are
 * rebased before instance/slot content is inserted; no document serialization. */
export function rebaseDesignHtmlReferences(source: string, fromFile: string, toFile: string, options: DesignReferenceRebaseOptions = {}): string {
  if (fromFile === toFile && !options.movedFiles && !options.strict) return source;
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const visit = (parent: DefaultTreeAdapterTypes.Document | DefaultTreeAdapterTypes.DocumentFragment | DefaultTreeAdapterTypes.Element) => {
    for (const element of parent.childNodes) {
      if (!("tagName" in element)) continue;
      const location = element.sourceCodeLocation;
      if (options.strict && element.tagName === "base" && element.attrs.some((attribute) => attribute.name === "href"))
        unsafeReference("<base href>");
      if (element.tagName === "style" && location?.startTag) {
        const start = location.startTag.endOffset;
        // parse5 leaves an unterminated raw-text element's own end at its
        // start tag. Its text-node locations still cover the authored CSS.
        const end = location.endTag?.startOffset ?? Math.max(location.endOffset, start,
          ...element.childNodes.map(child => child.sourceCodeLocation?.endOffset ?? start));
        const css = source.slice(start, end);
        const text = rebaseDesignCssReferences(css, fromFile, toFile, options);
        if (text !== css) edits.push({ start, end, text });
      }
      for (const attribute of element.attrs) {
        if (!["href", "src", "poster", "action", "formaction", "srcset", "style"].includes(attribute.name)) continue;
        const key = attribute.prefix ? attribute.prefix + ":" + attribute.name : attribute.name;
        const span = location?.attrs?.[key];
        if (!span) continue;
        const raw = source.slice(span.startOffset, span.endOffset);
        const equal = raw.indexOf("=");
        if (equal < 0) continue;
        const valueStart = equal + 1 + (raw.slice(equal + 1).match(/^\s*/)?.[0].length ?? 0);
        const quote = raw[valueStart] === '"' || raw[valueStart] === "'" ? raw[valueStart] : "";
        const contentStart = valueStart + quote.length;
        const contentEnd = quote ? raw.lastIndexOf(quote) : raw.length;
        if (contentEnd < contentStart) {
          if (options.strict) unsafeReference(raw);
          continue;
        }
        const authoredValue = raw.slice(contentStart, contentEnd);
        // Migration edits raw values, retaining query entities and unrelated
        // bytes. Entity-encoded paths/quotes need explicit source repair.
        const original = options.strict ? authoredValue : attribute.value;
        const checkPath = (url: string) => {
          if (options.strict && /&(?:#|[a-z][a-z0-9]*;)/i.test(url.split(/[?#]/, 1)[0]!)) unsafeReference(url);
          return rebaseDesignReference(url, fromFile, toFile, options);
        };
        let next = original;
        if (["href", "src", "poster", "action", "formaction"].includes(attribute.name)) {
          next = checkPath(next);
        } else if (attribute.name === "srcset") {
          next = applyEdits(next, designSrcsetReferences(next).map((ref) => ({ ...ref, text: checkPath(ref.url) })));
        } else if (attribute.name === "style") {
          if (options.strict && /&(?:quot|apos|#)/i.test(next)) unsafeReference(next);
          next = rebaseDesignCssReferences("a{" + next + "}", fromFile, toFile, options).slice(2, -1);
        }
        if (next === original) continue;
        const text = options.strict ? next : next.replace(/&/g, "&amp;").replace(quote === "'" ? /'/g : /"/g, quote === "'" ? "&#39;" : "&quot;");
        edits.push({ start: span.startOffset + contentStart, end: span.startOffset + contentEnd, text });
      }
      visit(element);
      if ("content" in element && element.content && typeof element.content === "object")
        visit(element.content);
    }
  };
  visit(document);
  return applyEdits(source, edits);
}
