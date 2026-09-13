import { parse, type DefaultTreeAdapterTypes } from "parse5";

export function designDocumentBody(
  document: DefaultTreeAdapterTypes.Document,
): DefaultTreeAdapterTypes.Element {
  const html = document.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      "tagName" in node && node.tagName === "html",
  );
  const body = html?.childNodes.find(
    (node): node is DefaultTreeAdapterTypes.Element =>
      "tagName" in node && node.tagName === "body",
  );
  if (!body) throw new Error("Design document has no body.");
  return body;
}

/** HTML permits omitted document tags. Reparse after adding an opening tag so
 * an already-authored closing tag acquires its source span. Keep every authored
 * byte and child identity in place, including comments and raw style text. */
export function withExplicitDesignBody(source: string): string {
  const read = () => {
    const document = parse(source, { sourceCodeLocationInfo: true });
    const body = designDocumentBody(document);
    const html = body.parentNode as DefaultTreeAdapterTypes.Element;
    return { document, body, html };
  };
  const insert = (at: number, text: string) => {
    source = source.slice(0, at) + text + source.slice(at);
  };
  let current = read();
  if (
    current.body.sourceCodeLocation?.startTag &&
    current.body.sourceCodeLocation.endTag
  )
    return source;
  if (!current.html.sourceCodeLocation?.startTag) {
    const doctype = current.document.childNodes.find(
      (node) => node.nodeName === "#documentType",
    );
    insert(doctype?.sourceCodeLocation?.endOffset ?? 0, "<html>");
    current = read();
  }
  if (!current.body.sourceCodeLocation?.startTag) {
    const head = current.html.childNodes.find(
      (node): node is DefaultTreeAdapterTypes.Element =>
        "tagName" in node && node.tagName === "head",
    );
    const start =
      current.body.childNodes.find((node) => node.sourceCodeLocation)
        ?.sourceCodeLocation?.startOffset ??
      head?.sourceCodeLocation?.endOffset ??
      head?.childNodes
        .slice()
        .reverse()
        .find((node) => node.sourceCodeLocation)?.sourceCodeLocation
        ?.endOffset ??
      current.html.sourceCodeLocation!.startTag!.endOffset;
    insert(start, "<body>");
    current = read();
  }
  if (!current.body.sourceCodeLocation?.endTag)
    insert(
      current.html.sourceCodeLocation?.endTag?.startOffset ?? source.length,
      "</body>",
    );
  return source;
}
