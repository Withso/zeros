import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";
import { portableDesignName } from "@zeros/protocol/design-path";
import {
  CssReferenceLexer,
  hasCssReferenceFunction,
  isReferenceWhitespace,
  referenceWhitespaceStart,
  referenceWhitespaceEnd,
  type CssLiteralSpan,
} from "./css-reference-lexer";

/** Resolve URLs against the containing source file, bounded by the Design root.
 * This is lexical; filesystem readers still check the canonical target. */
export function resolveDesignLocalReference(
  reference: string,
  sourceFile = "",
): string | null {
  const value = reference.trim();
  if (
    !value ||
    value.startsWith("#") ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /%(?:2e|2f|5c)/i.test(value)
  )
    return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(value.split(/[?#]/, 1)[0]!);
  } catch {
    return null;
  }
  if (/[\\\u0000-\u001f\u007f]/.test(pathname) || pathname.startsWith("/"))
    return null;
  const sourceParts = sourceFile ? sourceFile.split("/") : [];
  if (
    sourceParts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\\u0000-\u001f\u007f]/.test(part),
    )
  )
    return null;
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

export function isContainedDesignReference(
  reference: string,
  sourceFile = "",
): boolean {
  const value = reference.trim();
  return (
    !value ||
    value.startsWith("#") ||
    resolveDesignLocalReference(value, sourceFile) !== null
  );
}

export interface DesignReferenceRebaseOptions {
  /** With strict rebasing, a move plan preserves other URLs' authored spelling. */
  movedFiles?: Readonly<Record<string, string>>;
  /** Authoring safety, independent of render containment. */
  strict?: boolean;
}

const HTML_CHARACTER_REFERENCE =
  /&(?:#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]*);?/gi;

function decodeHtmlAttributeValue(value: string): string {
  if (!value.includes("&")) return value;
  const fragment = parseFragment(
    '<i data-reference="' + value.replace(/"/g, "&quot;") + '">',
  );
  const element = fragment.childNodes[0];
  return element && "attrs" in element ? element.attrs[0]!.value : value;
}

/** Attribute parsing decodes entities, while edits must address their original
 * spans. URL boundaries never split a character reference. */
function migrationHtmlAttributeSource(source: string): {
  value: string;
  offset: (index: number) => number;
} {
  if (!source.includes("&")) return { value: source, offset: (index) => index };
  let value = "";
  let cursor = 0;
  const offsets = [0];
  const append = (raw: string, decoded: string, start: number) => {
    value += decoded;
    for (let index = 0; index < decoded.length; index++)
      offsets.push(
        raw === decoded
          ? start + index + 1
          : index === decoded.length - 1
            ? start + raw.length
            : start,
      );
  };
  for (const match of source.matchAll(HTML_CHARACTER_REFERENCE)) {
    append(
      source.slice(cursor, match.index),
      source.slice(cursor, match.index),
      cursor,
    );
    const end = match.index + match[0].length;
    // A following '=' or letter affects semicolonless named references.
    const following = source.slice(end, end + 1);
    const decoded = decodeHtmlAttributeValue(match[0] + following);
    append(
      match[0],
      following ? decoded.slice(0, -following.length) : decoded,
      match.index,
    );
    cursor = end;
  }
  append(source.slice(cursor), source.slice(cursor), cursor);
  return { value, offset: (index) => offsets[index]! };
}

/** Stationary source only needs inspection when it might name a moved frame.
 * Keep original bytes for parsing; normalization is only a conservative filter. */
export function mayReferenceMovedDesignFrame(
  source: string,
  movedFiles: Readonly<Record<string, string>> = {},
): boolean {
  const text = portableDesignName(
    decodeHtmlAttributeValue(source).replace(/(?:%[0-9a-f]{2})+/gi, (value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }),
  );
  return Object.keys(movedFiles).some((file) =>
    text.includes(portableDesignName(file.split("/").at(-1)!)),
  );
}

function resolveMigrationReference(
  reference: string,
  sourceFile: string,
  htmlAttribute: boolean,
): { target: string | null; suffix: string; trailingSlash: string } | null {
  if (/[\\\u0000-\u001f\u007f]/.test(reference)) return null;
  const raw = reference.trim();
  const decoded = htmlAttribute
    ? migrationHtmlAttributeSource(raw)
    : { value: raw, offset: (index: number) => index };
  const value = decoded.value;
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value) ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  const suffixIndex = value.search(/[?#]/);
  const pathname = value.split(/[?#]/, 1)[0]!;
  const suffix = suffixIndex < 0 ? "" : raw.slice(decoded.offset(suffixIndex));
  const rawPath =
    suffixIndex < 0 ? raw : raw.slice(0, decoded.offset(suffixIndex));
  const result = {
    target: sourceFile || ".",
    suffix,
    trailingSlash: pathname.endsWith("/") ? "/" : "",
  };
  if (!pathname) return result;
  if (/%(?:2f|5c)/i.test(pathname)) return null;
  const parts = sourceFile.split("/").slice(0, -1);
  let invalidEncoding = false;
  for (const authored of rawPath.split("/")) {
    let part: string;
    try {
      part = decodeURIComponent(
        htmlAttribute ? decodeHtmlAttributeValue(authored) : authored,
      );
    } catch {
      invalidEncoding = true;
      continue;
    }
    if (
      /[\/\\\u0000-\u001f\u007f]/.test(part) ||
      ((part === "." || part === "..") && part !== authored)
    )
      return null;
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return { ...result, target: invalidEncoding ? null : parts.join("/") || "." };
}

function unsafeReference(reference: string): never {
  throw new Error(
    "Cannot safely rebase an unsupported or ambiguous Design reference: " +
      reference,
  );
}

function relativeDesignPath(target: string, toFile: string): string {
  const base = toFile.split("/").slice(0, -1);
  const destination = target === "." || !target ? [] : target.split("/");
  let shared = 0;
  while (shared < base.length && base[shared] === destination[shared]) shared++;
  return (
    [
      ...base.slice(shared).map(() => ".."),
      ...destination.slice(shared).map(encodeURIComponent),
    ].join("/") || "."
  );
}

function rebaseMigrationReference(
  reference: string,
  fromFile: string,
  toFile: string,
  options: DesignReferenceRebaseOptions,
  htmlAttribute = false,
): string {
  const value = reference.trim();
  if (!options.movedFiles) {
    // Duplicate/detach retain their existing normalization and exclusions.
    const pathname = value.split(/[?#]/, 1)[0]!;
    if (
      pathname.includes("%") ||
      (pathname.endsWith("&") && value[pathname.length] === "#") ||
      /&(?:#|[a-z][a-z0-9]*;)/i.test(pathname)
    )
      return reference;
  }
  const resolved = resolveMigrationReference(
    reference,
    fromFile,
    htmlAttribute,
  );
  if (!resolved) return reference;
  const moved =
    resolved.target !== null &&
    options.movedFiles &&
    Object.hasOwn(options.movedFiles, resolved.target)
      ? options.movedFiles[resolved.target]
      : undefined;
  if (
    !moved &&
    resolved.target !== null &&
    Object.keys(options.movedFiles ?? {}).some(
      (file) =>
        portableDesignName(file) === portableDesignName(resolved.target!),
    )
  )
    unsafeReference(reference);
  if (!moved && fromFile === toFile) return reference;
  const leading = reference.slice(0, referenceWhitespaceStart(reference));
  const trailing = reference.slice(referenceWhitespaceEnd(reference));
  const fromDirectory = fromFile.split("/").slice(0, -1).join("/");
  const toDirectory = toFile.split("/").slice(0, -1).join("/");
  const target = moved ?? (options.movedFiles ? null : resolved.target);
  if (target !== null) {
    if (!moved && fromDirectory === toDirectory && !value.startsWith("?"))
      return reference;
    return (
      leading +
      relativeDesignPath(target, toFile) +
      resolved.trailingSlash +
      resolved.suffix +
      trailing
    );
  }
  if (fromDirectory === toDirectory) return reference;
  const prefix = relativeDesignPath(fromDirectory, toFile);
  // Preserve the URL itself, including invalid escapes and dot segments.
  return (
    leading +
    (prefix === "." ? "" : prefix + "/") +
    value.replace(/^\.\//, "") +
    trailing
  );
}

export function rebaseDesignReference(
  reference: string,
  fromFile: string,
  toFile: string,
  options: DesignReferenceRebaseOptions = {},
): string {
  if (options.strict)
    return rebaseMigrationReference(reference, fromFile, toFile, options);
  if (fromFile === toFile && !options.movedFiles && !options.strict)
    return reference;
  const value = reference.trim();
  if (
    !value ||
    value.startsWith("#") ||
    value.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(value)
  )
    return reference;
  const target = resolveDesignLocalReference(reference, fromFile);
  if (!target) return reference;
  const moved =
    options.movedFiles && Object.hasOwn(options.movedFiles, target)
      ? options.movedFiles[target]
      : undefined;
  if (fromFile === toFile && !moved) return reference;
  const base = toFile.split("/").slice(0, -1);
  const destination =
    (moved ?? target) === "." ? [] : (moved ?? target).split("/");
  let shared = 0;
  while (shared < base.length && base[shared] === destination[shared]) shared++;
  const relative =
    [
      ...base.slice(shared).map(() => ".."),
      ...destination.slice(shared).map(encodeURIComponent),
    ].join("/") || ".";
  const trailingSlash = value.split(/[?#]/, 1)[0]!.endsWith("/") ? "/" : "";
  const suffixIndex = value.search(/[?#]/);
  const suffix = suffixIndex < 0 ? "" : value.slice(suffixIndex);
  return (
    reference.slice(0, referenceWhitespaceStart(reference)) +
    relative +
    trailingSlash +
    suffix +
    reference.slice(referenceWhitespaceEnd(reference))
  );
}

interface ReferenceSpan {
  start: number;
  end: number;
  url: string;
}
interface CssReferenceSpan extends ReferenceSpan {
  functionStart: number;
  functionEnd: number;
}

/** Skip comments and literal strings before looking for URL functions. Quoted
 * URLs may contain parentheses; CSS escapes remain unsupported by policy. */
export function designCssUrlReferences(
  value: string,
  strict = false,
): CssReferenceSpan[] {
  const lexer = new CssReferenceLexer(value);
  if (strict) {
    const syntax = lexer.syntax();
    if (hasCssReferenceFunction(syntax, ["image-set", "image"], true))
      unsafeReference(value);
  }
  const references: CssReferenceSpan[] = [];
  for (const span of lexer.urls()) {
    const url = span.url;
    if (
      strict &&
      (url.includes("\\") ||
        url.includes("/*") ||
        hasCssReferenceFunction(url, ["var", "attr", "env"]))
    )
      unsafeReference(url);
    if (!url || url.includes("\\") || url.includes("/*")) continue;
    references.push(span);
  }
  return references;
}

/** URL spans, retaining descriptors and data-URL commas rather than splitting
 * srcset on every comma. Offsets address the decoded attribute value. */
export function designSrcsetReferences(value: string): ReferenceSpan[] {
  const result: ReferenceSpan[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (
      cursor < value.length &&
      (isReferenceWhitespace(value[cursor]) || value[cursor] === ",")
    )
      cursor++;
    const start = cursor;
    while (cursor < value.length && !isReferenceWhitespace(value[cursor]))
      cursor++;
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

function applyEdits(
  source: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  if (!edits.length) return source;
  type Chunk = { text: string; offset: number; next: Chunk | null };
  let head: Chunk | null = null;
  let cursor = source.length;
  // Preserve descending splice precedence, including overlapping parser spans,
  // by trimming/prepending chunks instead of copying the entire source per edit.
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    if (edit.end < cursor) {
      head = { text: source.slice(edit.end, cursor), offset: 0, next: head };
    } else {
      let discard = edit.end - cursor;
      while (head && discard > 0) {
        const length = head.text.length - head.offset;
        if (discard >= length) {
          discard -= length;
          head = head.next;
        } else {
          head.offset += discard;
          discard = 0;
        }
      }
    }
    if (edit.text) head = { text: edit.text, offset: 0, next: head };
    cursor = edit.start;
  }
  const chunks = [source.slice(0, cursor)];
  for (let chunk = head; chunk; chunk = chunk.next)
    chunks.push(chunk.text.slice(chunk.offset));
  return chunks.join("");
}

function literalLookup(literals: readonly CssLiteralSpan[]) {
  let cursor = 0;
  return (start: number) => {
    while (cursor < literals.length && literals[cursor]!.end <= start) cursor++;
    const span = literals[cursor];
    return !!span && start >= span.start;
  };
}

function migrationCssReferences(
  source: string,
  options: DesignReferenceRebaseOptions,
): CssReferenceSpan[] {
  const lexer = new CssReferenceLexer(source);
  const literals = lexer.literals(true);
  const imageInLiteral = literalLookup(literals);
  // Quoted URLs in image functions are not URL tokens. Refuse only a possible
  // moved target, instead of unrelated unsupported syntax elsewhere in CSS.
  for (const span of lexer.images())
    if (
      !imageInLiteral(span.start) &&
      mayReferenceMovedDesignFrame(
        source.slice(span.bodyStart, span.bodyEnd),
        options.movedFiles,
      )
    )
      unsafeReference(source.slice(span.start, span.end));
  const urlInLiteral = literalLookup(literals);
  const references = lexer
    .urls()
    .filter(
      (ref) =>
        !!ref.url &&
        !ref.url.includes("\\") &&
        !ref.url.includes("/*") &&
        !urlInLiteral(ref.functionStart) &&
        !hasCssReferenceFunction(ref.url, ["var", "attr", "env"]),
    );
  // Also cover quoted @import during the token fallback for malformed CSS.
  references.push(...lexer.imports());
  return references;
}

/** Use PostCSS's declaration offsets; comments and unrelated CSS retain their
 * original bytes. Unsupported URL spellings are left to the policy validator. */
export function rebaseDesignCssReferences(
  source: string,
  fromFile: string,
  toFile: string,
  options: DesignReferenceRebaseOptions = {},
): string {
  return rebaseCssReferences(source, fromFile, toFile, options);
}

function rebaseCssReferences(
  source: string,
  fromFile: string,
  toFile: string,
  options: DesignReferenceRebaseOptions,
  htmlAttribute = false,
): string {
  if (fromFile === toFile && !options.movedFiles && !options.strict)
    return source;
  if (
    options.strict &&
    fromFile === toFile &&
    !mayReferenceMovedDesignFrame(source, options.movedFiles)
  )
    return source;
  const css = htmlAttribute
    ? migrationHtmlAttributeSource(source)
    : { value: source, offset: (index: number) => index };
  const referenceEdit = (reference: ReferenceSpan, offset = 0) => {
    const start = css.offset(offset + reference.start);
    const end = css.offset(offset + reference.end);
    const url = source.slice(start, end);
    return {
      start,
      end,
      text: options.strict
        ? rebaseMigrationReference(
            url,
            fromFile,
            toFile,
            options,
            htmlAttribute,
          )
        : rebaseDesignReference(url, fromFile, toFile, options),
    };
  };
  let root: postcss.Root;
  try {
    root = postcss.parse(css.value);
  } catch (error) {
    if (!options.strict) throw error;
    return applyEdits(
      source,
      migrationCssReferences(css.value, options).map((ref) =>
        referenceEdit(ref),
      ),
    );
  }
  const edits: Array<{ start: number; end: number; text: string }> = [];
  root.walkDecls((declaration) => {
    const start = declaration.source?.start?.offset;
    const end = declaration.source?.end?.offset;
    if (start === undefined || end === undefined) return;
    const authored = css.value.slice(start, end + 1);
    for (const reference of options.strict
      ? migrationCssReferences(authored, options)
      : designCssUrlReferences(authored)) {
      const edit = referenceEdit(reference, start);
      if (edit.text !== source.slice(edit.start, edit.end)) edits.push(edit);
    }
  });
  root.walkAtRules((rule) => {
    if (rule.name.toLowerCase() !== "import") return;
    const start = rule.source?.start?.offset,
      end = rule.source?.end?.offset;
    if (start === undefined || end === undefined) {
      return;
    }
    const authored = css.value.slice(start, end + 1);
    const references = options.strict
      ? migrationCssReferences(authored, options)
      : designCssUrlReferences(authored);
    if (!references.length) {
      const reference = new CssReferenceLexer(authored).imports()[0];
      if (!reference || reference.functionStart !== 0) return;
      references.push(reference);
    }
    for (const reference of references) {
      const edit = referenceEdit(reference, start);
      if (edit.text !== source.slice(edit.start, edit.end)) edits.push(edit);
    }
  });
  return applyEdits(source, edits);
}

/** Parser-backed value splices for render composition. Definition URLs are
 * rebased before instance/slot content is inserted; no document serialization. */
export function rebaseDesignHtmlReferences(
  source: string,
  fromFile: string,
  toFile: string,
  options: DesignReferenceRebaseOptions = {},
): string {
  if (fromFile === toFile && !options.movedFiles && !options.strict)
    return source;
  if (
    options.strict &&
    fromFile === toFile &&
    !mayReferenceMovedDesignFrame(source, options.movedFiles)
  )
    return source;
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let hasBase = false;
  const visit = (
    parent:
      | DefaultTreeAdapterTypes.Document
      | DefaultTreeAdapterTypes.DocumentFragment
      | DefaultTreeAdapterTypes.Element,
  ) => {
    for (const element of parent.childNodes) {
      if (!("tagName" in element)) continue;
      const location = element.sourceCodeLocation;
      if (
        options.strict &&
        element.tagName === "base" &&
        element.attrs.some((attribute) => attribute.name === "href")
      ) {
        if (fromFile !== toFile) unsafeReference("<base href>");
        hasBase = true;
      }
      if (element.tagName === "style" && location?.startTag) {
        const start = location.startTag.endOffset;
        // parse5 leaves an unterminated raw-text element's own end at its
        // start tag. Its text-node locations still cover the authored CSS.
        const end =
          location.endTag?.startOffset ??
          Math.max(
            location.endOffset,
            start,
            ...element.childNodes.map(
              (child) => child.sourceCodeLocation?.endOffset ?? start,
            ),
          );
        const css = source.slice(start, end);
        const text = rebaseDesignCssReferences(css, fromFile, toFile, options);
        if (text !== css) edits.push({ start, end, text });
      }
      for (const attribute of element.attrs) {
        if (
          ![
            "href",
            "src",
            "poster",
            "action",
            "formaction",
            "srcset",
            "style",
          ].includes(attribute.name)
        )
          continue;
        const key = attribute.prefix
          ? attribute.prefix + ":" + attribute.name
          : attribute.name;
        const span = location?.attrs?.[key];
        if (!span) continue;
        const raw = source.slice(span.startOffset, span.endOffset);
        const equal = raw.indexOf("=");
        if (equal < 0) continue;
        const valueStart = referenceWhitespaceStart(raw, equal + 1);
        const quote =
          raw[valueStart] === '"' || raw[valueStart] === "'"
            ? raw[valueStart]
            : "";
        const contentStart = valueStart + quote.length;
        const contentEnd = quote ? raw.lastIndexOf(quote) : raw.length;
        if (contentEnd < contentStart) {
          continue;
        }
        const authoredValue = raw.slice(contentStart, contentEnd);
        // Migration edits raw values; decoding is only for target detection.
        const original = options.strict ? authoredValue : attribute.value;
        const checkPath = (url: string) =>
          options.strict
            ? rebaseMigrationReference(url, fromFile, toFile, options, true)
            : rebaseDesignReference(url, fromFile, toFile, options);
        let next = original;
        if (
          ["href", "src", "poster", "action", "formaction"].includes(
            attribute.name,
          )
        ) {
          next = checkPath(next);
        } else if (attribute.name === "srcset") {
          next = applyEdits(
            next,
            designSrcsetReferences(next).map((ref) => ({
              ...ref,
              text: checkPath(ref.url),
            })),
          );
        } else if (attribute.name === "style") {
          next = rebaseCssReferences(
            "a{" + next + "}",
            fromFile,
            toFile,
            options,
            options.strict,
          ).slice(2, -1);
        }
        if (next === original) continue;
        const text = options.strict
          ? next
          : next
              .replace(/&/g, "&amp;")
              .replace(
                quote === "'" ? /'/g : /"/g,
                quote === "'" ? "&#39;" : "&quot;",
              );
        edits.push({
          start: span.startOffset + contentStart,
          end: span.startOffset + contentEnd,
          text,
        });
      }
      visit(element);
      if (
        "content" in element &&
        element.content &&
        typeof element.content === "object"
      )
        visit(element.content);
    }
  };
  visit(document);
  if (hasBase && edits.length) unsafeReference("<base href>");
  return applyEdits(source, edits);
}
