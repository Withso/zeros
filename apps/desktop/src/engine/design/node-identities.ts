import { nativeDesignIdentityBase } from "@zeros/design-web";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { elementRecords, type ElementRecord } from "./source";

const NON_DESIGN_NODE_TAGS = new Set([
  "base",
  "body",
  "head",
  "html",
  "link",
  "meta",
  "noscript",
  "script",
  "style",
  "template",
  "title",
]);

type DesignAncestor =
  | DefaultTreeAdapterTypes.Document
  | DefaultTreeAdapterTypes.DocumentFragment
  | DefaultTreeAdapterTypes.Element;

/** A selectable design node is authored visual content inside body, never
 * document plumbing. One predicate shared by healing, lint, mutations, and
 * rendering keeps metadata nodes out of the canvas contract. */
export function isDesignNodeElement(
  element: DefaultTreeAdapterTypes.Element,
): boolean {
  if (NON_DESIGN_NODE_TAGS.has(element.tagName)) return false;
  let current = element.parentNode as DesignAncestor | null;
  while (current) {
    if ("tagName" in current) {
      if (current.tagName === "head" || current.tagName === "template") {
        return false;
      }
      if (current.tagName === "body") return true;
    }
    current =
      "parentNode" in current
        ? (current.parentNode as DesignAncestor | null)
        : null;
  }
  return false;
}

export function designNodeRecords(
  document: DefaultTreeAdapterTypes.Document,
): ElementRecord[] {
  return elementRecords(document).filter(({ element }) =>
    isDesignNodeElement(element),
  );
}

/** Legacy frames may carry data-oid on html/head/style/body. Strip those ids
 * from the composed render only: authored source remains intact, while an old
 * broad `[data-oid]` reset can no longer reveal head content or expose
 * document plumbing as selectable layers. */
export function stripNonDesignOidsForRender(source: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: Array<{ start: number; end: number }> = [];
  for (const { element } of elementRecords(document)) {
    if (isDesignNodeElement(element)) continue;
    const location = element.sourceCodeLocation?.attrs?.["data-oid"];
    const startTag = element.sourceCodeLocation?.startTag;
    if (!location || !startTag) continue;
    let start = location.startOffset;
    while (start > startTag.startOffset && /\s/.test(source[start - 1] ?? "")) {
      start -= 1;
    }
    edits.push({ start, end: location.endOffset });
  }
  let rendered = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rendered = `${rendered.slice(0, edit.start)}${rendered.slice(edit.end)}`;
  }
  return rendered;
}

function oidForElement(
  source: string,
  element: DefaultTreeAdapterTypes.Element,
): string {
  const offset = element.sourceCodeLocation?.startOffset ?? 0;
  return nativeDesignIdentityBase(element.tagName, offset, source);
}

export function healDesignOids(source: string): {
  html: string;
  changed: boolean;
  fixed: Array<{ kind: "missing" | "duplicate"; line: number; oid: string }>;
} {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = designNodeRecords(document);
  const used = new Set<string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const fixed: Array<{
    kind: "missing" | "duplicate";
    line: number;
    oid: string;
  }> = [];
  for (const record of records) {
    const location = record.element.sourceCodeLocation;
    const startTag = location?.startTag;
    if (!startTag) continue;
    const usableOid =
      record.oid !== null && record.oid.trim().length > 0 ? record.oid : null;
    const duplicate = usableOid !== null && used.has(usableOid);
    if (usableOid !== null && !duplicate) {
      used.add(usableOid);
      continue;
    }
    const oidBase = oidForElement(source, record.element);
    let oid = oidBase;
    for (let suffix = 2; used.has(oid); suffix++) {
      oid = `${oidBase}-${suffix}`;
    }
    used.add(oid);
    const attrLocation = location?.attrs?.["data-oid"];
    if (attrLocation) {
      const original = source.slice(
        attrLocation.startOffset,
        attrLocation.endOffset,
      );
      const equalsAt = original.indexOf("=");
      if (equalsAt < 0) {
        edits.push({
          start: attrLocation.startOffset,
          end: attrLocation.endOffset,
          text: `${original}="${oid}"`,
        });
        fixed.push({
          kind: duplicate ? "duplicate" : "missing",
          line: attrLocation.startLine,
          oid,
        });
        continue;
      }
      let valueStart = equalsAt + 1;
      while (/\s/.test(original[valueStart] ?? "")) valueStart += 1;
      const quote = original[valueStart];
      let valueEnd = valueStart;
      if (quote === '"' || quote === "'") {
        valueStart += 1;
        valueEnd = original.indexOf(quote, valueStart);
      } else {
        while (
          valueEnd < original.length &&
          !/[\s"'`=<>]/.test(original[valueEnd] ?? "")
        ) {
          valueEnd += 1;
        }
      }
      if (valueEnd < valueStart) continue;
      const replacement = `${original.slice(0, valueStart)}${oid}${original.slice(valueEnd)}`;
      edits.push({
        start: attrLocation.startOffset,
        end: attrLocation.endOffset,
        text: replacement,
      });
      fixed.push({
        kind: duplicate ? "duplicate" : "missing",
        line: attrLocation.startLine,
        oid,
      });
    } else {
      const insertAt = source.lastIndexOf(">", startTag.endOffset - 1);
      if (insertAt < startTag.startOffset) continue;
      const slashAt = source.lastIndexOf("/", insertAt);
      const offset =
        slashAt >= startTag.startOffset &&
        source.slice(slashAt, insertAt).trim() === "/"
          ? slashAt
          : insertAt;
      edits.push({
        start: offset,
        end: offset,
        text: ` data-oid="${oid}"`,
      });
      fixed.push({ kind: "missing", line: startTag.startLine, oid });
    }
  }
  let html = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    html = `${html.slice(0, edit.start)}${edit.text}${html.slice(edit.end)}`;
  }
  return { html, changed: edits.length > 0, fixed };
}
