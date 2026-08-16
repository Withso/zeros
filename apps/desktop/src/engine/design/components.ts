import { realpath } from "node:fs/promises";
import path from "node:path";

import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";

import { assertDesignComponentDefinitionIdentities } from "@zeros/design-web";

import { designDirectoryNameFor } from "./directory-registry";
import { readSafeRegularFile } from "./safe-files";

const MAX_COMPONENTS_PER_FRAME = 1_024;
const MAX_COMPONENT_BYTES = 512 * 1024;
const MAX_COMPONENT_SOURCE_BYTES_PER_FRAME = 16 * 1024 * 1024;
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

function referencedComponentNames(node: ParentNode): string[] {
  return [
    ...new Set(
      elements(node)
        .filter((element) => element.tagName.startsWith("zd-"))
        .map((element) => element.tagName.slice(3))
        .filter((name) => /^[a-z][a-z0-9-]*$/.test(name)),
    ),
  ];
}

async function loadDefinitions(
  workspacePath: string,
  frameSource: string,
): Promise<{
  definitions: Map<string, ComponentDefinition>;
  errors: DesignComponentExpansionError[];
}> {
  const errors: DesignComponentExpansionError[] = [];
  const designRoot = path.join(
    workspacePath,
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
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

  const frameDocument = parse(frameSource);
  const pending = referencedComponentNames(frameDocument);
  const scheduled = new Set(pending);
  const definitions = new Map<string, ComponentDefinition>();
  let totalSourceBytes = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const name = pending[index]!;
    if (index >= MAX_COMPONENTS_PER_FRAME) {
      errors.push({
        component: name,
        message: `A frame may reference at most ${MAX_COMPONENTS_PER_FRAME} component definitions.`,
      });
      break;
    }
    const target = path.join(canonicalDirectory, `${name}.html`);
    const safe = await readSafeRegularFile(
      canonicalDirectory,
      target,
      MAX_COMPONENT_BYTES,
    );
    if (!safe) continue;
    if (totalSourceBytes + safe.size > MAX_COMPONENT_SOURCE_BYTES_PER_FRAME) {
      errors.push({
        component: name,
        message:
          "Referenced component source exceeded the 16 MiB per-frame limit.",
      });
      break;
    }
    totalSourceBytes += safe.size;
    const source = safe.body.toString("utf8");
    const parseErrors: Array<{ code: string }> = [];
    const document = parse(source, {
      sourceCodeLocationInfo: true,
      onParseError: (error) => parseErrors.push(error),
    });
    for (const nestedName of referencedComponentNames(document)) {
      if (!scheduled.has(nestedName)) {
        scheduled.add(nestedName);
        pending.push(nestedName);
      }
    }
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
    // Pre-Foundation component files had no definition-local IDs. Preserve
    // those files as a compatibility shape; once a definition declares any
    // data-zid (and for every component.create operation), require the complete
    // all-elements identity contract rather than accepting a partial upgrade.
    const declaresDefinitionIdentity = elements(document).some((element) =>
      element.attrs.some((attribute) => attribute.name === "data-zid"),
    );
    if (declaresDefinitionIdentity) {
      try {
        assertDesignComponentDefinitionIdentities(source);
      } catch (error) {
        errors.push({
          component: name,
          message:
            error instanceof Error
              ? error.message
              : `Component zd-${name} has invalid definition-local identity.`,
        });
      }
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
    // Keep the safe remainder previewable even when lint found an invalid
    // definition. The composed-frame sanitizer and CSP remain the rendering
    // boundary, while component-invalid stays a blocking save/PR diagnostic;
    // dropping the whole definition here would hide useful repair context.
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
  const loaded = await loadDefinitions(workspacePath, source);
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
    // loadDefinitions visits only the frame's bounded transitive dependency
    // graph. Keep nested diagnostics even when an ancestor is also invalid:
    // invalid definitions remain previewable and their safe remainder expands.
    errors: [...loaded.errors, ...errors],
  };
}
