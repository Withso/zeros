import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { DESIGN_RUNTIME_SOURCE } from "@zeros/protocol/design-runtime";

export interface ElementRecord {
  element: DefaultTreeAdapterTypes.Element;
  oid: string | null;
}

const templateOwners = new WeakMap<
  DefaultTreeAdapterTypes.DocumentFragment,
  DefaultTreeAdapterTypes.Element
>();

/** parse5 keeps template content in a detached fragment with no parent link.
 * Every walk through elementRecords remembers the template that owns each
 * fragment, so callers can follow declarative shadow content to its host. */
export function templateOwningFragment(
  fragment: DefaultTreeAdapterTypes.DocumentFragment,
): DefaultTreeAdapterTypes.Element | null {
  return templateOwners.get(fragment) ?? null;
}

export function elementRecords(
  document: DefaultTreeAdapterTypes.Document,
): ElementRecord[] {
  const records: ElementRecord[] = [];
  const pending: DefaultTreeAdapterTypes.Node[] = [document];
  while (pending.length) {
    const node = pending.pop()!;
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        pending.push(node.childNodes[index]!);
      }
    }
    if ("tagName" in node) {
      const oid =
        node.attrs.find((attribute) => attribute.name === "data-oid")?.value ??
        null;
      records.push({ element: node, oid });
      if (node.tagName === "template" && "content" in node) {
        templateOwners.set(node.content, node);
        pending.push(node.content);
      }
    }
  }
  return records;
}

export interface DesignSourceEdit {
  start: number;
  end: number;
  text: string;
}

export function applyDesignSourceEdits(
  source: string,
  edits: readonly DesignSourceEdit[],
): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const edit of [...edits].sort(
    (left, right) => left.start - right.start || right.end - left.end,
  )) {
    if (
      !Number.isInteger(edit.start) ||
      !Number.isInteger(edit.end) ||
      edit.start < 0 ||
      edit.end < edit.start ||
      edit.end > source.length
    ) {
      throw new Error("Invalid Design source edit range.");
    }
    // An outer removal owns its nested ranges. Applying the inner edit first
    // would shift offsets and cause the outer edit to erase following content.
    if (edit.start < cursor) {
      if (edit.end <= cursor) continue;
      throw new Error("Overlapping Design source edits.");
    }
    chunks.push(source.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join("");
}

function attributeRemovalStart(source: string, start: number): number {
  let cursor = start;
  while (cursor > 0 && /\s/.test(source[cursor - 1] ?? "")) cursor -= 1;
  return cursor;
}

function activeUrl(value: string): boolean {
  const normalized = [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x20 && codePoint !== 0x7f;
    })
    .join("")
    .toLowerCase();
  if (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:")
  ) {
    return true;
  }
  if (!normalized.startsWith("data:")) return false;
  // Local design assets are inlined into these exact passive raster forms.
  // Every other data payload is authored active content and is removed,
  // including SVG and text MIME types that can carry markup or script.
  return !/^data:image\/(?:avif|gif|jpeg|png|webp);base64,[a-z0-9+/]*={0,2}$/i.test(
    normalized,
  );
}

/** Remove active authored markup using parse5's decoded attribute values and
 * exact source locations. Regex sanitizers inspect encoded text rather than
 * the DOM the browser executes, so `java&#115;cript:` and mixed/unquoted event
 * handlers bypass them. This parser-backed sanitizer is shared by srcDoc and
 * custom-protocol rendering. */
export function sanitizeDesignFrameMarkup(source: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const edits: DesignSourceEdit[] = [];
  const urlAttributes = new Set([
    "action",
    "formaction",
    "href",
    "poster",
    "src",
  ]);
  for (const { element } of elementRecords(document)) {
    const location = element.sourceCodeLocation;
    const httpEquiv = element.attrs
      .find((attribute) => attribute.name === "http-equiv")
      ?.value.trim()
      .toLowerCase();
    const removeElement =
      element.tagName === "script" ||
      element.tagName === "base" ||
      element.tagName === "iframe" ||
      element.tagName === "object" ||
      element.tagName === "embed" ||
      (element.tagName === "meta" &&
        (httpEquiv === "content-security-policy" || httpEquiv === "refresh"));
    if (removeElement) {
      if (location) {
        edits.push({
          start: location.startOffset,
          end: location.endOffset,
          text: "",
        });
      }
      continue;
    }
    for (const attribute of element.attrs) {
      const name = attribute.name.toLowerCase();
      const dangerous =
        name.startsWith("on") ||
        name === "srcdoc" ||
        (urlAttributes.has(name) && activeUrl(attribute.value));
      if (!dangerous) continue;
      // parse5 decodes namespace-qualified attributes (`xlink:href`) to
      // name="href", prefix="xlink", while its location map retains the raw
      // qualified spelling. Check that spelling first so active SVG links are
      // removed from the exact authored range too.
      const qualifiedName = attribute.prefix
        ? `${attribute.prefix}:${attribute.name}`
        : attribute.name;
      const attributeLocation =
        location?.attrs?.[qualifiedName] ?? location?.attrs?.[attribute.name];
      if (!attributeLocation) continue;
      edits.push({
        start: attributeRemovalStart(source, attributeLocation.startOffset),
        end: attributeLocation.endOffset,
        text: "",
      });
    }
  }
  return applyDesignSourceEdits(source, edits);
}

export function createDesignRuntimeScript(sourceVersion: string): {
  markup: string;
  cspSource: string;
} {
  const body =
    `window.__zerosDesignSourceVersion=${JSON.stringify(sourceVersion)};` +
    DESIGN_RUNTIME_SOURCE;
  const digest = createHash("sha256").update(body).digest("base64");
  return {
    markup: `<script data-zeros-design-runtime>${body}</script>`,
    cspSource: `'sha256-${digest}'`,
  };
}

export function insertDesignRuntimeScript(
  source: string,
  sourceVersion: string,
): { html: string; cspSource: string } {
  const runtime = createDesignRuntimeScript(sourceVersion);
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = elementRecords(document);
  const body = records.find(
    ({ element }) => element.tagName === "body",
  )?.element;
  const html = records.find(
    ({ element }) => element.tagName === "html",
  )?.element;
  const insertAt =
    body?.sourceCodeLocation?.endTag?.startOffset ??
    html?.sourceCodeLocation?.endTag?.startOffset ??
    source.length;
  return {
    html: `${source.slice(0, insertAt)}${runtime.markup}${source.slice(insertAt)}`,
    cspSource: runtime.cspSource,
  };
}

export function insertDesignHeadMarkup(source: string, markup: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const records = elementRecords(document);
  const head = records.find(
    ({ element }) => element.tagName === "head",
  )?.element;
  const html = records.find(
    ({ element }) => element.tagName === "html",
  )?.element;
  // An implicit head still accepts metadata after the opening html/doctype.
  // Keep the doctype first so inserting styles cannot switch to quirks mode.
  const insertAt =
    head?.sourceCodeLocation?.startTag?.endOffset ??
    html?.sourceCodeLocation?.startTag?.endOffset ??
    document.childNodes.find((node) => node.nodeName === "#documentType")
      ?.sourceCodeLocation?.endOffset ??
    0;
  return `${source.slice(0, insertAt)}${markup}${source.slice(insertAt)}`;
}

/** Theme names a frame can be shown in, as the canvas Themes control uses. */
export const DESIGN_THEME_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** Show a frame in a named theme the way the canvas Themes control does:
 * `data-zd-theme` on the document element, replacing any authored value. */
export function withDesignTheme(source: string, theme: string): string {
  if (!DESIGN_THEME_NAME.test(theme)) throw new Error("Design theme is invalid.");
  const attribute = `data-zd-theme="${theme}"`;
  const document = parse(source, { sourceCodeLocationInfo: true });
  const html = elementRecords(document).find(
    ({ element }) => element.tagName === "html",
  )?.element;
  const location = html?.sourceCodeLocation;
  const authored = location?.attrs?.["data-zd-theme"];
  if (authored) {
    return `${source.slice(0, authored.startOffset)}${attribute}${source.slice(authored.endOffset)}`;
  }
  if (location?.startTag) {
    const at = location.startTag.startOffset + "<html".length;
    return `${source.slice(0, at)} ${attribute}${source.slice(at)}`;
  }
  // Without an authored html tag, add one after the doctype so the document
  // keeps its standards mode.
  const at =
    document.childNodes.find((node) => node.nodeName === "#documentType")
      ?.sourceCodeLocation?.endOffset ?? 0;
  return `${source.slice(0, at)}<html ${attribute}>${source.slice(at)}`;
}

export function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
