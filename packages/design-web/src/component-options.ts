// Source edits to a component's declared options, in its own file: one
// attribute of one <zd-option> or <zd-variant>, or one added <zd-variant>
// line. Everything else in the file keeps its bytes, so a Git diff shows
// only the line a person changed.

import {
  COMPONENT_OPTION_LIMITS,
  componentOptionValues,
  parseComponentOptionValue,
  readComponentDeclaration,
  type ComponentDeclaration,
  type ComponentDeclarationElement,
} from "@zeros/design-core/components";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

type Element = DefaultTreeAdapterTypes.Element;

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** An option value as the attribute text a file stores. */
export function componentOptionAttributeValue(value: string | number | boolean): string {
  return typeof value === "boolean" ? String(value) : String(value);
}

interface Declared {
  declaration: ComponentDeclaration;
  template: DefaultTreeAdapterTypes.Template;
  elements: Element[];
}

function declaredIn(source: string, file: string): Declared {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const isElement = (node: DefaultTreeAdapterTypes.ChildNode): node is Element => "tagName" in node;
  // Only <head> declares options, as the engine reads them; a template
  // elsewhere is ignored there and must not be written to here.
  const head = document.childNodes.find(isElement)?.childNodes.find((node): node is Element => isElement(node) && node.tagName === "head");
  const template = head?.childNodes.find((child) =>
    isElement(child) && child.tagName === "template" && child.attrs.some((attribute) => attribute.name === "data-zd-options"),
  ) as DefaultTreeAdapterTypes.Template | undefined;
  if (!template) throw new Error(`${file} declares no options.`);
  const elements = template.content.childNodes.filter((child): child is Element => "tagName" in child);
  const read: ComponentDeclarationElement[] = elements.map((element) => ({
    tag: element.tagName,
    attributes: element.attrs.map(({ name, value }) => ({ name, value })),
    offset: element.sourceCodeLocation?.startOffset ?? 0,
  }));
  return { declaration: readComponentDeclaration(read).declaration, template, elements };
}

const nameOf = (element: Element) => element.attrs.find((attribute) => attribute.name === "name")?.value;

function setAttribute(source: string, element: Element, attribute: string, value: string | null): string {
  const location = element.sourceCodeLocation;
  const startTag = location?.startTag;
  if (!location || !startTag) throw new Error("The declaration has no source location.");
  const existing = location.attrs?.[attribute];
  if (existing) {
    if (value === null) {
      let start = existing.startOffset;
      while (start > startTag.startOffset && /\s/.test(source[start - 1] ?? "")) start -= 1;
      return source.slice(0, start) + source.slice(existing.endOffset);
    }
    return `${source.slice(0, existing.startOffset)}${attribute}="${escapeAttribute(value)}"${source.slice(existing.endOffset)}`;
  }
  if (value === null) return source;
  const end = source.slice(startTag.endOffset - 2, startTag.endOffset) === "/>" ? startTag.endOffset - 2 : startTag.endOffset - 1;
  return `${source.slice(0, end)} ${attribute}="${escapeAttribute(value)}"${source.slice(end)}`;
}

/** Set an option's default (variant null) or a variant's value for it. A null
 * value removes a variant's own value; a default cannot be removed. */
export function mutateComponentOption(
  source: string,
  file: string,
  input: { option: string; variant: string | null; value: string | number | boolean | null },
): string {
  const { declaration, elements } = declaredIn(source, file);
  const option = declaration.options.find((entry) => entry.name === input.option);
  if (!option) throw new Error(`This component has no option ${input.option}.`);
  const raw = input.value === null ? null : componentOptionAttributeValue(input.value);
  if (raw !== null) {
    const parsed = parseComponentOptionValue(option, raw);
    if (!parsed.ok) throw new Error(parsed.message);
  }
  if (input.variant === null) {
    if (raw === null) throw new Error("A default cannot be removed; set another value.");
    // The declaration keeps the first valid <zd-option> of a name; an earlier
    // invalid one with that name is ignored, so the write goes where it kept.
    const element = elements.find((entry) => entry.tagName === "zd-option" && entry.sourceCodeLocation?.startOffset === option.offset)!;
    return setAttribute(source, element, "default", raw);
  }
  const variant = elements.find((entry) => entry.tagName === "zd-variant" && nameOf(entry) === input.variant);
  if (!variant || !declaration.variants.some((entry) => entry.name === input.variant))
    throw new Error(`This component has no variant ${input.variant}.`);
  return setAttribute(source, variant, input.option, raw);
}

/** Add a variant with these values on its own line after the last one. */
export function appendComponentVariant(
  source: string,
  file: string,
  input: { name: string; values: Readonly<Record<string, string | number | boolean>> },
): string {
  const { declaration, template, elements } = declaredIn(source, file);
  if (input.name === "default") throw new Error("A variant cannot be named default: Default is the declared defaults.");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.name) || input.name.length > COMPONENT_OPTION_LIMITS.name)
    throw new Error(`The variant name ${JSON.stringify(input.name)}: use lowercase letters, digits and single hyphens.`);
  if (declaration.variants.some((entry) => entry.name === input.name)) throw new Error(`The variant ${input.name} already exists.`);
  const attributes = new Map(Object.entries(input.values).map(([name, value]) => [name, componentOptionAttributeValue(value)]));
  for (const name of attributes.keys())
    if (!declaration.options.some((option) => option.name === name)) throw new Error(`This component has no option ${name}.`);
  const { problems } = componentOptionValues(declaration, attributes);
  const refused = problems.find((problem) => problem.severity === "error");
  if (refused) throw new Error(refused.message);
  const line = `<zd-variant name="${input.name}"${[...attributes].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("")}></zd-variant>`;
  const after = [...elements].reverse().find((entry) => entry.tagName === "zd-variant") ?? elements.at(-1);
  if (!after?.sourceCodeLocation) {
    const end = template.sourceCodeLocation?.endTag?.startOffset;
    if (end === undefined) throw new Error("The options template has no source location.");
    return `${source.slice(0, end)}${line}${source.slice(end)}`;
  }
  const lineStart = source.lastIndexOf("\n", after.sourceCodeLocation.startOffset) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart))![0];
  const at = after.sourceCodeLocation.endOffset;
  return `${source.slice(0, at)}\n${indent}${line}${source.slice(at)}`;
}

/** Whether a file declares options (so its instances need explicit values). */
export function designSourceDeclaresComponentOptions(source: string): boolean {
  const end = source.search(/<\/head\b|<body\b/i);
  return /<template\b[^>]*\sdata-zd-options\b/i.test(end < 0 ? source : source.slice(0, end));
}

/** The declaration in a component file, for checking instance values. */
export function readDesignComponentDeclaration(source: string, file: string): ComponentDeclaration {
  return declaredIn(source, file).declaration;
}
