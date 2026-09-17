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
