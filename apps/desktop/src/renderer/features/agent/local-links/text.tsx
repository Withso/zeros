import {
  Fragment,
  createElement,
  memo,
  useMemo,
  type CSSProperties,
  type ReactNode,
} from "react";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { parseLocalLink } from "@zeros/protocol/local-orchestration";
import { useLocalLinks } from "./context";
import { localLinkSpans } from "./model";
import { LocalLinkPill } from "./pill";

export const LocalLinkText = memo(function LocalLinkText({
  text,
}: {
  text: string;
}) {
  const { enabled, scheme } = useLocalLinks();
  const spans = useMemo(
    () => (enabled ? localLinkSpans(text, scheme) : []),
    [enabled, scheme, text],
  );
  if (spans.length === 0) return <>{text}</>;
  return (
    <>
      {spans.map((span, i) => (
        <Fragment key={span.start}>
          {text.slice(i ? spans[i - 1].end : 0, span.start)}
          <LocalLinkPill href={span.href} />
        </Fragment>
      ))}
      {text.slice(spans[spans.length - 1].end)}
    </>
  );
});

type HtmlNode = DefaultTreeAdapterMap["childNode"];
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const VERBATIM = new Set([
  "pre",
  "a",
  "button",
  "summary",
  "select",
  "textarea",
]);
const ATTR_NAMES: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  colspan: "colSpan",
  rowspan: "rowSpan",
  datetime: "dateTime",
  srcset: "srcSet",
  readonly: "readOnly",
};

function reactStyle(value: string): CSSProperties | undefined {
  if (typeof document === "undefined") return undefined;
  const style = document.createElement("span").style;
  style.cssText = value;
  const result: Record<string, string> = {};
  for (let i = 0; i < style.length; i++) {
    const property = style.item(i);
    const key = property.startsWith("--")
      ? property
      : property.replace(/-([a-z])/g, (_, letter: string) =>
          letter.toUpperCase(),
        );
    result[key] = style.getPropertyValue(property);
  }
  return result;
}

/** Input is already sanitized by markdown.ts. Transform only the rendered
 * prose; fenced/nested pre blocks and raw tool output keep their exact code.
 * No query or scheme is ever promoted into an executable URL. */
export const LocalLinkHtml = memo(function LocalLinkHtml({
  html,
  className,
  id,
}: {
  html: string;
  className?: string;
  id?: string;
}) {
  const { enabled, scheme } = useLocalLinks();
  const content = useMemo(() => {
    if (!enabled || !html.includes(`${scheme}://`)) return null;
    const render = (node: HtmlNode, key: number): ReactNode => {
      if (node.nodeName === "#text")
        return (
          <LocalLinkText
            key={key}
            text={(node as DefaultTreeAdapterMap["textNode"]).value}
          />
        );
      if (!("tagName" in node)) return null;
      const attrs = Object.fromEntries(
        node.attrs.map((attr) => [attr.name, attr.value]),
      );
      const href = attrs["data-local-link"] ?? attrs.href;
      if (
        node.tagName === "a" &&
        href &&
        parseLocalLink(href)?.scheme === scheme
      )
        return (
          <LocalLinkPill key={key} href={href} />
        );
      const props: Record<string, unknown> = { key };
      for (const [name, value] of Object.entries(attrs)) {
        if (name.startsWith("on")) continue;
        if (name === "style") props.style = reactStyle(value);
        else if (
          name === "checked" ||
          name === "disabled" ||
          name === "readonly"
        )
          props[ATTR_NAMES[name] ?? name] = true;
        else props[ATTR_NAMES[name] ?? name] = value;
      }
      if (VOID.has(node.tagName)) return createElement(node.tagName, props);
      // Sanitized HTML controls and foreign anchors must not gain a nested button.
      if (
        VERBATIM.has(node.tagName) ||
        node.namespaceURI !== "http://www.w3.org/1999/xhtml"
      )
        return createElement(node.tagName, {
          ...props,
          dangerouslySetInnerHTML: { __html: serialize(node) },
        });
      return createElement(node.tagName, props, node.childNodes.map(render));
    };
    return parseFragment(html).childNodes.map(render);
  }, [enabled, scheme, html]);
  return content === null ? (
    <div
      id={id}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : (
    <div id={id} className={className}>
      {content}
    </div>
  );
});
