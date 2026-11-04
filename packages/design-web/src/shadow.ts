import type { DefaultTreeAdapterTypes } from "parse5";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type DocumentFragment = DefaultTreeAdapterTypes.DocumentFragment;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Template = DefaultTreeAdapterTypes.Template;

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
/** Elements attachShadow() accepts besides autonomous custom elements. */
const SHADOW_HOST_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "main",
  "nav",
  "p",
  "section",
  "span",
]);
const RESERVED_CUSTOM_ELEMENT_NAMES = new Set([
  "annotation-xml",
  "color-profile",
  "font-face",
  "font-face-format",
  "font-face-name",
  "font-face-src",
  "font-face-uri",
  "missing-glyph",
]);
// A custom element name is a lowercase letter, then name characters, with a
// hyphen somewhere after it. One character class keeps the test linear.
const CUSTOM_ELEMENT_CHARACTERS = /^[a-z][-.0-9_a-z\u00b7\u00c0-\ufffd]*$/;

const contentOwners = new WeakMap<DocumentFragment, Template>();
const slotsByHost = new WeakMap<Element, Map<string, Element>>();

function isElement(node: ChildNode | ParentNode): node is Element {
  return "tagName" in node;
}

function attribute(element: Element, name: string): string | undefined {
  return element.attrs.find((item) => item.name === name)?.value;
}

/** parse5 keeps template content in a detached fragment with no parent link.
 * Walks register each fragment so shadow content can reach its host. */
export function registerDesignTemplateContent(template: Template): DocumentFragment {
  contentOwners.set(template.content, template);
  return template.content;
}

export function designTemplateOfContent(fragment: DocumentFragment): Template | null {
  return contentOwners.get(fragment) ?? null;
}

function canHostShadowRoot(element: Element): boolean {
  if (element.namespaceURI !== HTML_NAMESPACE) return false;
  if (SHADOW_HOST_TAGS.has(element.tagName)) return true;
  return (
    element.tagName.includes("-") &&
    CUSTOM_ELEMENT_CHARACTERS.test(element.tagName) &&
    !RESERVED_CUSTOM_ELEMENT_NAMES.has(element.tagName)
  );
}

/** The template the HTML parser attaches as this element's open shadow root:
 * the first `<template shadowrootmode>` child of an element that can host
 * one. Later templates and those on other elements stay inert. A closed root
 * renders, but the Design runtime cannot read it, so it stays opaque too. */
export function declarativeShadowTemplateOf(host: Element): Template | null {
  if (!canHostShadowRoot(host)) return null;
  for (const child of host.childNodes) {
    if (!isElement(child) || child.tagName !== "template") continue;
    const mode = attribute(child, "shadowrootmode")?.toLowerCase();
    if (mode !== "open" && mode !== "closed") continue;
    return mode === "open" ? (child as Template) : null;
  }
  return null;
}

export function isDeclarativeShadowTemplate(element: Element): boolean {
  if (element.tagName !== "template") return false;
  const host = element.parentNode;
  return !!host && isElement(host) && declarativeShadowTemplateOf(host) === element;
}

/** The host a registered template fragment renders into, when that template
 * is its host's declarative shadow root. */
export function designShadowHostOfContent(fragment: DocumentFragment): Element | null {
  const template = designTemplateOfContent(fragment);
  if (!template || !isDeclarativeShadowTemplate(template)) return null;
  return template.parentNode as Element;
}

function shadowHostOf(node: Element): Element | null {
  for (let current: ParentNode | null = node.parentNode; current; ) {
    if (isElement(current)) {
      current = current.parentNode;
      continue;
    }
    return current.nodeName === "#document-fragment"
      ? designShadowHostOfContent(current as DocumentFragment)
      : null;
  }
  return null;
}

/** The first slot of each name receives the host children with that name. */
function slotsOf(host: Element, template: Template): Map<string, Element> {
  const cached = slotsByHost.get(host);
  if (cached) return cached;
  const slots = new Map<string, Element>();
  const visit = (parent: ParentNode) => {
    for (const child of parent.childNodes) {
      if (!isElement(child)) continue;
      if (child.tagName === "slot" && child.namespaceURI === HTML_NAMESPACE) {
        const name = attribute(child, "name") ?? "";
        if (!slots.has(name)) slots.set(name, child);
      }
      visit(child);
    }
  };
  visit(template.content);
  slotsByHost.set(host, slots);
  return slots;
}

/** The host children a slot renders, or null when it renders its fallback.
 * Any assigned node, even whitespace text, replaces the fallback. */
function assignedNodesOf(slot: Element): ChildNode[] | null {
  const host = shadowHostOf(slot);
  const template = host ? declarativeShadowTemplateOf(host) : null;
  if (!host || !template) return null;
  const name = attribute(slot, "name") ?? "";
  if (slotsOf(host, template).get(name) !== slot) return null;
  const assigned = host.childNodes.filter((child) => {
    if (child === template) return false;
    if (isElement(child)) return (attribute(child, "slot") ?? "") === name;
    return name === "" && child.nodeName === "#text";
  });
  return assigned.length > 0 ? assigned : null;
}

/** An element's children in the rendered (flat) tree: a declarative shadow
 * root's content replaces its host's children, and a slot renders the host
 * children assigned to it, or else its own fallback children. */
export function designComposedChildElements(element: Element): Element[] {
  const template = declarativeShadowTemplateOf(element);
  if (template) return registerDesignTemplateContent(template).childNodes.filter(isElement);
  if (element.tagName === "slot") {
    const assigned = assignedNodesOf(element);
    if (assigned) return assigned.filter(isElement);
  }
  return element.childNodes.filter(isElement);
}
