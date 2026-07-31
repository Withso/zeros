import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { readSafeRegularFile } from "./safe-files";

const MAX_COMPONENTS = 64;
const MAX_COMPONENT_BYTES = 512 * 1024;
const MAX_EXPANSION_BYTES = 2 * 1024 * 1024;
const MAX_EXPANSION_DEPTH = 8;

interface ComponentDefinition {
  name: string;
  body: string;
  styles: string[];
}

export interface DesignComponentExpansionError {
  component: string;
  message: string;
}

export interface DesignComponentExpansion {
  html: string;
  usedComponents: string[];
  errors: DesignComponentExpansionError[];
}

type ParentNode =
  | DefaultTreeAdapterTypes.Document
  | DefaultTreeAdapterTypes.DocumentFragment
  | DefaultTreeAdapterTypes.Element;

function elements(node: ParentNode): DefaultTreeAdapterTypes.Element[] {
  const result: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (current: ParentNode) => {
    for (const child of current.childNodes ?? []) {
      if ("tagName" in child) {
        result.push(child);
        visit(child);
      }
    }
  };
  visit(node);
  return result;
}

function innerSource(
  source: string,
  element: DefaultTreeAdapterTypes.Element,
): string {
  const location = element.sourceCodeLocation;
  if (!location?.startTag || !location.endTag) return "";
  return source.slice(location.startTag.endOffset, location.endTag.startOffset);
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripDefinitionOids(source: string): string {
  return source.replace(/\s+data-oid\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

async function loadDefinitions(workspacePath: string): Promise<{
  definitions: Map<string, ComponentDefinition>;
  errors: DesignComponentExpansionError[];
}> {
  const errors: DesignComponentExpansionError[] = [];
  const designRoot = path.join(workspacePath, "Zeros Design");
  const directory = path.join(designRoot, "components");
  let canonicalDirectory: string;
  try {
    canonicalDirectory = await realpath(directory);
  } catch {
    return { definitions: new Map(), errors };
  }
  const canonicalDesignRoot = await realpath(designRoot);
  if (!canonicalDirectory.startsWith(`${canonicalDesignRoot}${path.sep}`)) {
    return { definitions: new Map(), errors };
  }
  const entries = (await readdir(canonicalDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        /^[a-z][a-z0-9-]*\.html$/.test(entry.name) &&
        entry.name !== ".gitkeep",
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_COMPONENTS);
  const definitions = new Map<string, ComponentDefinition>();
  for (const entry of entries) {
    const target = path.join(canonicalDirectory, entry.name);
    const safe = await readSafeRegularFile(
      canonicalDirectory,
      target,
      MAX_COMPONENT_BYTES,
    );
    if (!safe) continue;
    const source = safe.body.toString("utf8");
    const parseErrors: Array<{ code: string }> = [];
    const document = parse(source, {
      sourceCodeLocationInfo: true,
      onParseError: (error) => parseErrors.push(error),
    });
    const name = entry.name.slice(0, -".html".length);
    if (parseErrors.length > 0) {
      errors.push({
        component: name,
        message: `Component zd-${name} contains invalid HTML (${parseErrors[0]!.code}).`,
      });
    }
    const unsafeElement = elements(document).find(
      (element) =>
        element.tagName === "script" ||
        element.attrs.some((attribute) => /^on/i.test(attribute.name)),
    );
    if (unsafeElement) {
      errors.push({
        component: name,
        message: `Component zd-${name} must contain HTML and CSS only; scripts and event handlers are not allowed.`,
      });
    }
    if (
      elements(document).some((element) =>
        element.attrs.some((attribute) => attribute.name === "data-oid"),
      )
    ) {
      errors.push({
        component: name,
        message: `Component zd-${name} must not declare data-oid values; the authored instance owns selection.`,
      });
    }
    const externalReference = elements(document).some((element) =>
      element.attrs.some(
        (attribute) =>
          ["href", "src", "action", "poster"].includes(attribute.name) &&
          (attribute.value.startsWith("/") ||
            attribute.value.startsWith("//") ||
            /^[a-z][a-z0-9+.-]*:/i.test(attribute.value)),
      ),
    );
    if (externalReference) {
      errors.push({
        component: name,
        message: `Component zd-${name} must use only relative references inside Zeros Design/.`,
      });
    }
    const body = elements(document).find(
      (element) => element.tagName === "body",
    );
    if (!body) {
      errors.push({
        component: name,
        message: `Component zd-${name} is missing a body element.`,
      });
    }
    const styles = elements(document)
      .filter((element) => element.tagName === "style")
      .map((element) => innerSource(source, element));
    definitions.set(name, {
      name,
      body: body ? stripDefinitionOids(innerSource(source, body)) : "",
      styles,
    });
  }
  return { definitions, errors };
}

function hasComponentAncestor(
  element: DefaultTreeAdapterTypes.Element,
): boolean {
  let parent = element.parentNode;
  while (parent && "tagName" in parent) {
    if (parent.tagName.startsWith("zd-")) return true;
    parent = parent.parentNode;
  }
  return false;
}

function fillSlots(
  definitionBody: string,
  instanceSource: string,
  instance: DefaultTreeAdapterTypes.Element,
): string {
  const fragment = parseFragment(definitionBody, {
    sourceCodeLocationInfo: true,
  });
  const instanceChildren = innerSource(instanceSource, instance);
  const attributes = new Map(
    instance.attrs.map((attribute) => [attribute.name, attribute.value]),
  );
  const slots = elements(fragment).filter(
    (element) => element.tagName === "slot" && element.sourceCodeLocation,
  );
  let result = definitionBody;
  for (const slot of slots.sort(
    (left, right) =>
      (right.sourceCodeLocation?.startOffset ?? 0) -
      (left.sourceCodeLocation?.startOffset ?? 0),
  )) {
    const location = slot.sourceCodeLocation!;
    const attributeName = slot.attrs.find(
      (attribute) => attribute.name === "data-zd-attr",
    )?.value;
    const fallback = innerSource(definitionBody, slot);
    const replacement = attributeName
      ? attributes.has(attributeName)
        ? escapeText(attributes.get(attributeName) ?? "")
        : fallback
      : instanceChildren || fallback;
    result = `${result.slice(0, location.startOffset)}${replacement}${result.slice(location.endOffset)}`;
  }
  return result;
}

function injectComponentStyles(
  source: string,
  used: readonly string[],
  definitions: ReadonlyMap<string, ComponentDefinition>,
): string {
  const styleMarkup = used
    .flatMap((name) =>
      (definitions.get(name)?.styles ?? []).map(
        (style) => `<style data-zeros-component="${name}">${style}</style>`,
      ),
    )
    .join("");
  if (!styleMarkup) return source;
  if (/<\/head\s*>/i.test(source)) {
    return source.replace(/<\/head\s*>/i, `${styleMarkup}</head>`);
  }
  return `${styleMarkup}${source}`;
}

export async function expandDesignComponents(
  workspacePath: string,
  source: string,
): Promise<DesignComponentExpansion> {
  const loaded = await loadDefinitions(workspacePath);
  const definitions = loaded.definitions;
  const used = new Set<string>();
  const errors: DesignComponentExpansionError[] = [];

  const expand = (
    markup: string,
    stack: readonly string[],
    depth: number,
  ): string => {
    if (depth > MAX_EXPANSION_DEPTH) return markup;
    const fragment = parseFragment(markup, { sourceCodeLocationInfo: true });
    const instances = elements(fragment).filter(
      (element) =>
        element.tagName.startsWith("zd-") &&
        element.sourceCodeLocation &&
        !hasComponentAncestor(element),
    );
    let result = markup;
    for (const instance of instances.sort(
      (left, right) =>
        (right.sourceCodeLocation?.startOffset ?? 0) -
        (left.sourceCodeLocation?.startOffset ?? 0),
    )) {
      const name = instance.tagName.slice(3);
      const definition = definitions.get(name);
      if (!definition) continue;
      if (stack.includes(name) || depth === MAX_EXPANSION_DEPTH) {
        errors.push({
          component: name,
          message: `Component cycle or depth limit reached for zd-${name}.`,
        });
        continue;
      }
      used.add(name);
      const filled = fillSlots(definition.body, markup, instance);
      const expanded = expand(filled, [...stack, name], depth + 1);
      const location = instance.sourceCodeLocation!;
      if (location.startTag && location.endTag) {
        result = `${result.slice(0, location.startTag.endOffset)}${expanded}${result.slice(location.endTag.startOffset)}`;
      } else {
        const startTag = result
          .slice(location.startOffset, location.endOffset)
          .replace(/\/\s*>$/, ">");
        result = `${result.slice(0, location.startOffset)}${startTag}${expanded}</${instance.tagName}>${result.slice(location.endOffset)}`;
      }
      if (Buffer.byteLength(result, "utf8") > MAX_EXPANSION_BYTES) {
        errors.push({
          component: name,
          message: "Expanded component output exceeded the 2 MiB limit.",
        });
        return markup;
      }
    }
    return result;
  };

  const html = injectComponentStyles(
    expand(source, [], 0),
    [...used].sort(),
    definitions,
  );
  return {
    html,
    usedComponents: [...used].sort(),
    errors: [
      ...loaded.errors.filter((error) => used.has(error.component)),
      ...errors,
    ],
  };
}
