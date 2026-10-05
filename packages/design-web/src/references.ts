import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import postcss from "postcss";

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
  const text = decodeHtmlAttributeValue(source)
    .replace(/(?:%[0-9a-f]{2})+/gi, (value) => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    })
    .normalize("NFC")
    .toLowerCase();
  return Object.keys(movedFiles).some((file) =>
    text.includes(file.split("/").at(-1)!.normalize("NFC").toLowerCase()),
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
        file.normalize("NFC").toLowerCase() ===
        resolved.target!.normalize("NFC").toLowerCase(),
    )
  )
    unsafeReference(reference);
  if (!moved && fromFile === toFile) return reference;
  const leading = reference.match(/^\s*/)?.[0] ?? "";
  const trailing = reference.match(/\s*$/)?.[0] ?? "";
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
  const suffix = value.match(/[?#][\s\S]*$/)?.[0] ?? "";
  return (
    (reference.match(/^\s*/)?.[0] ?? "") +
    relative +
    trailingSlash +
    suffix +
    (reference.match(/\s*$/)?.[0] ?? "")
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
  if (strict) {
    const syntax = value.replace(
      /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g,
      "",
    );
    if (
      /(?:image-set|image)\s*\(/i.test(syntax) ||
      /[a-z_-][a-z0-9_\\-]*\\[a-z0-9_\\-]*\s*\(/i.test(syntax)
    )
      unsafeReference(value);
  }
  const tokens =
    /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|(?<![-\w\\])url\(\s*(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|([^)]*?))\s*\)/gi;
  const references: CssReferenceSpan[] = [];
  for (const match of value.matchAll(tokens)) {
    const raw = match[1] ?? match[2] ?? match[3];
    if (raw === undefined) continue;
    const url = raw.trim();
    if (
      strict &&
      (url.includes("\\") ||
        url.includes("/*") ||
        /(?:var|attr|env)\s*\(/i.test(url))
    )
      unsafeReference(url);
    if (!url || url.includes("\\") || url.includes("/*")) continue;
    let start = match.index + match[0].indexOf("(") + 1;
    while (/\s/.test(value[start] ?? "") && start < value.length) start++;
    if (value[start] === '"' || value[start] === "'") start++;
    start += raw.length - raw.trimStart().length;
    references.push({
      start,
      end: start + url.length,
      url,
      functionStart: match.index,
      functionEnd: match.index + match[0].length,
    });
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

function applyEdits(
  source: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start))
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

function migrationCssReferences(
  source: string,
  options: DesignReferenceRebaseOptions,
): CssReferenceSpan[] {
  const literals = [
    ...source.matchAll(
      /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)/g,
    ),
  ].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const inLiteral = (start: number) =>
    literals.some((span) => start >= span.start && start < span.end);
  // Quoted URLs in image functions are not URL tokens. Refuse only a possible
  // moved target, instead of unrelated unsupported syntax elsewhere in CSS.
  for (const match of source.matchAll(/(?:image-set|image)\s*\(([\s\S]*?)\)/gi))
    if (
      !inLiteral(match.index) &&
      mayReferenceMovedDesignFrame(match[1]!, options.movedFiles)
    )
      unsafeReference(match[0]);
  const references = designCssUrlReferences(source).filter(
    (ref) =>
      !inLiteral(ref.functionStart) && !/(?:var|attr|env)\s*\(/i.test(ref.url),
  );
  // Also cover quoted @import during the token fallback for malformed CSS.
  const tokens =
    /\/\*[\s\S]*?(?:\*\/|$)|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|@import(?:\s|\/\*[\s\S]*?\*\/)*(['"])((?:\\[\s\S]|[^\\])*?)\1/gi;
  for (const match of source.matchAll(tokens)) {
    if (!match[1]) continue;
    const start = match.index + match[0].indexOf(match[1]) + 1;
    references.push({
      start,
      end: start + match[2]!.length,
      url: match[2]!,
      functionStart: match.index,
      functionEnd: match.index + match[0].length,
    });
  }
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
      const params = authored.slice(7);
      const match = /^(?:\s|\/\*[\s\S]*?\*\/)*(['"])([\s\S]*?)\1/.exec(params);
      if (!match) {
        return;
      }
      const offset = 7 + match[0].indexOf(match[1]!) + 1;
      references.push({
        start: offset,
        end: offset + match[2]!.length,
        url: match[2]!,
        functionStart: offset,
        functionEnd: offset + match[2]!.length,
      });
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
        const valueStart =
          equal + 1 + (raw.slice(equal + 1).match(/^\s*/)?.[0].length ?? 0);
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
