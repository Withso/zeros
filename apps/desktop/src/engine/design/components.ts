import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";

import { parse, parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { sharedDesignParse } from "./shared-parse";

import { assertDesignComponentDefinitionIdentities, rebaseDesignCssReferences, rebaseDesignHtmlReferences } from "@zeros/design-web";
import {
  ComponentExpressionError,
  componentExpressionScope,
  componentOptionCss,
  componentOptionPropertyNames,
  componentOptionValues,
  componentIgnoresAttribute,
  componentInheritedValues,
  readComponentDeclaration,
  COMPONENT_VARIANT_ATTRIBUTE,
  type ComponentDeclaration,
  type ComponentDeclarationElement,
  type ComponentOptionProblem,
} from "@zeros/design-core/components";

import { DESIGN_COMPONENT_RECORD_LIMITS, DESIGN_FRAME_INSTANCE_LIMITS, designComponentRecordWithinLimits, designFrameInstanceComponentSchema,
  type DesignFrameInstances } from "@zeros/protocol/design-catalog";
import { lastGoodDesignComponentRender, rememberDesignComponentRender } from "./component-last-good";
import { designComponentRegistry } from "./component-registry";
import {
  ComponentTemplateError,
  createComponentTemplateBudget,
  designComponentSummaryOf,
  renderComponentTemplate,
  type ComponentTemplateBudget,
  type DesignComponentSummary,
} from "@zeros/design-web/component-template";
import { designDirectoryNameFor } from "./directory-registry";
import { readSharedCanvasContext } from "./document-storage";
import { diagnoseSafeRegularFile, readSafeRegularFile, type SafeRegularFileProblem } from "./safe-files";

const MAX_COMPONENTS_PER_FRAME = 1_024;
const MAX_COMPONENT_BYTES = 512 * 1024;
const MAX_COMPONENT_SOURCE_BYTES_PER_FRAME = 16 * 1024 * 1024;
const MAX_EXPANSION_BYTES = 2 * 1024 * 1024;
const MAX_EXPANSION_DEPTH = 8;
const MAX_EXPANSION_INSTANCES = 2_048;
const MAX_EXPANSION_WORK = 32 * 1024 * 1024;
const MAX_COMPONENT_DIAGNOSTICS = 128;
const REFUSAL_REASONS: Record<Exclude<SafeRegularFileProblem, "missing">, string> = {
  link: "it is a symbolic link, which Zeros does not follow",
  outside: "it resolves outside the Design folder",
  "too-large": `it is over ${MAX_COMPONENT_BYTES / 1024} KiB`,
  unreadable: "it is not a readable file",
};

class ComponentBudgetExceeded extends Error {
  constructor() { super("Component expansion exceeded its work or output limit."); }
}

class ExpansionBudget {
  remaining = MAX_EXPANSION_WORK;
  instances = 0;
  charge(characters: number): void {
    this.remaining -= characters;
    if (this.remaining < 0) throw new ComponentBudgetExceeded();
  }
  output(size: number): void {
    if (size > MAX_EXPANSION_BYTES) throw new ComponentBudgetExceeded();
  }
}

interface ComponentDefinition {
  name: string;
  body: string;
  styles: string[];
  /** Set for a component with options or a registered frame: its markup is
   * a template and its inner layers carry data-zd-part. Absent for a plain
   * components/<name>.html, which expands exactly as it always has. */
  template?: {
    /** Design-root-relative file the definition came from. */
    file: string;
    declaration: ComponentDeclaration;
    /** The definition's own stylesheet links, as written in its file. */
    links: string[];
    /** What the Style panel shows for its instances; read on first use. */
    summary?: () => DesignComponentSummary | null;
  };
}

export type DesignComponentExpansionCode =
  | "component-invalid"
  | "component-option-invalid"
  | "component-expression-invalid"
  | "component-value-invalid";

export interface DesignComponentExpansionError {
  component: string;
  message: string;
  /** Set on diagnostics about options and templates; plain component
   * diagnostics keep their original shape. */
  code?: DesignComponentExpansionCode;
  severity?: "error" | "warning";
  /** The file the problem is in, when it is not the frame itself. */
  file?: string;
  /** Where in that file. */
  offset?: number;
  /** The line of `offset` in `file`, for a file the caller has not read. */
  line?: number;
}

export interface DesignComponentExpansion {
  html: string;
  usedComponents: string[];
  errors: DesignComponentExpansionError[];
  /** Some options could not be applied: an instance shows its defaults, or
   * nothing when those fail too. Absent when every option applied. */
  optionsFailed?: true;
  /** Something renders nothing where its options failed: the frame's own
   * template (its body is empty), or an instance whose defaults failed too. */
  showsNothing?: { main: boolean; instances: boolean };
  /** Names whose source is there but cannot be used; `errors` says why. */
  unavailable?: readonly string[];
  /** Registered names whose frame file is gone, to the file they name. */
  missing?: ReadonlyMap<string, string>;
}

export interface DesignComponentExpansionOptions {
  /** Registered frame components, name to file; read from the canvas when absent. */
  registry?: ReadonlyMap<string, string>;
  /** The variant a main component frame shows. Personal view state. */
  variant?: string | null;
}

/** What an expansion learned about the frame's own instances. */
interface DesignComponentExpansionUsage {
  templated: boolean;
  /** Kept in Maps while a frame expands: layer ids and component names are
   * authored text, and a plain object would take "__proto__" as its
   * prototype. */
  instances?: {
    components: Map<string, DesignFrameInstances["components"][string]>;
    hosts: Map<string, DesignFrameInstances["hosts"][string]>;
  };
}

/** Names every object already answers to: never a key of a reported record. */
const INHERITED_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

type ParentNode =
  | DefaultTreeAdapterTypes.Document
  | DefaultTreeAdapterTypes.DocumentFragment
  | DefaultTreeAdapterTypes.Element;

function elements(node: ParentNode): DefaultTreeAdapterTypes.Element[] {
  const result: DefaultTreeAdapterTypes.Element[] = [];
  const pending: Array<{ node: ParentNode; index: number }> = [{ node, index: 0 }];
  while (pending.length) {
    const current = pending[pending.length - 1]!;
    const child = current.node.childNodes[current.index++];
    if (!child) { pending.pop(); continue; }
    if ("tagName" in child) {
      if (result.length >= 50_000) throw new ComponentBudgetExceeded();
      result.push(child);
      pending.push({ node: child, index: 0 });
    }
  }
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
  sources: Readonly<Record<string, string>> | undefined,
  registry: ReadonlyMap<string, string>,
): Promise<{
  definitions: Map<string, ComponentDefinition>;
  errors: DesignComponentExpansionError[];
  /** Names whose source exists but could not be used; their instances are
   * reported through errors, not as missing components. */
  unavailable: Set<string>;
  /** Registered names whose frame file is gone, to the file they name. */
  missing: Map<string, string>;
}> {
  const errors: DesignComponentExpansionError[] = [];
  const unavailable = new Set<string>();
  const missing = new Map<string, string>();
  const designRoot = path.join(
    workspacePath,
    ...designDirectoryNameFor(workspacePath).split("/"),
  );
  const directory = path.join(designRoot, "components");
  let canonicalDirectory: string | null;
  try {
    canonicalDirectory = sources ? directory : await realpath(directory);
  } catch {
    canonicalDirectory = null;
  }
  let canonicalDesignRoot: string;
  try {
    canonicalDesignRoot = sources ? designRoot : await realpath(designRoot);
  } catch {
    return { definitions: new Map(), errors, unavailable: new Set(referencedComponentNames(sharedDesignParse(frameSource) ?? parse(frameSource))), missing };
  }
  // A components/ folder that resolves elsewhere is read from nowhere, but
  // its definitions are still reported as refused rather than missing.
  const escapes = canonicalDirectory !== null && !canonicalDirectory.startsWith(`${canonicalDesignRoot}${path.sep}`);
  if (escapes) canonicalDirectory = null;
  if (!canonicalDirectory && !escapes && registry.size === 0) return { definitions: new Map(), errors, unavailable, missing };

  const frameDocument = sharedDesignParse(frameSource) ?? parse(frameSource);
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
      for (const rest of pending.slice(index)) unavailable.add(rest);
      break;
    }
    const readSource = async (root: string | null, target: string, relative: string) => {
      if (sources) {
        const captured = sources[relative];
        return captured === undefined ? null : { body: Buffer.from(captured), size: Buffer.byteLength(captured) };
      }
      return root ? readSafeRegularFile(root, target, MAX_COMPONENT_BYTES) : null;
    };
    const registered = registry.get(name);
    // Reads use the checkout's own path spelling, the one read sets record and
    // worktree changes report; the reader confines each file to the real
    // Design root when it opens it.
    const legacyPath = path.join(directory, `${name}.html`);
    const legacy = await readSource(canonicalDirectory && designRoot, legacyPath, `components/${name}.html`);
    if (registered && legacy) {
      errors.push({
        component: name,
        code: "component-invalid",
        message: `zd-${name} is both a registered frame (${registered}) and components/${name}.html; rename one.`,
      });
      unavailable.add(name);
      continue;
    }
    // Only a file that is gone leaves its instances missing; one that is
    // there but refused (a link, too large, not a file) is reported as such.
    const refusal = async (target: string, read: { size: number } | null) =>
      read ? (read.size > MAX_COMPONENT_BYTES ? "too-large" : null)
        : sources ? "missing" : await diagnoseSafeRegularFile(designRoot, target, MAX_COMPONENT_BYTES);
    const registeredPath = registered && path.join(designRoot, ...registered.split("/"));
    const safe = registeredPath ? await readSource(designRoot, registeredPath, registered) : legacy;
    const refused = await refusal(registeredPath || legacyPath, safe);
    if (refused === "missing") {
      if (registered) missing.set(name, registered);
      continue;
    }
    if (refused) {
      errors.push(registered
        ? { component: name, code: "component-invalid", file: registered,
          message: `The frame registered as zd-${name} (${registered}) cannot be used: ${REFUSAL_REASONS[refused]}.` }
        : { component: name, message: `Component zd-${name}'s definition components/${name}.html cannot be used: ${REFUSAL_REASONS[refused]}.` });
      unavailable.add(name);
      continue;
    }
    if (!safe) continue;
    if (totalSourceBytes + safe.size > MAX_COMPONENT_SOURCE_BYTES_PER_FRAME) {
      errors.push({
        component: name,
        message:
          "Referenced component source exceeded the 16 MiB per-frame limit.",
      });
      for (const rest of pending.slice(index)) unavailable.add(rest);
      break;
    }
    totalSourceBytes += safe.size;
    const source = safe.body.toString("utf8");
    const parseErrors: Array<{ code: string }> = [];
    const document = parse(source, {
      sourceCodeLocationInfo: true,
      onParseError: (error) => { if (!parseErrors.length) parseErrors.push(error); },
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
      !registered &&
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
    const declared = declarationElementsOf(document);
    if (registered || declared) {
      const file = registered ?? `components/${name}.html`;
      const read = readDeclaration(declared ?? [], name, file, errors, source);
      let summary: DesignComponentSummary | null | undefined;
      definitions.set(name, {
        name,
        body: body ? innerSource(source, body) : "",
        styles,
        template: { file, declaration: read, links: stylesheetLinksOf(document),
          summary: () => (summary === undefined ? (summary = designComponentSummaryOf(source)) : summary) },
      });
      continue;
    }
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
  return { definitions, errors, unavailable, missing };
}

/** The <zd-option>, <zd-derive> and <zd-variant> lines of a file's
 * <template data-zd-options>, or null when the file declares none. */
function declarationElementsOf(document: ParentNode): (ComponentDeclarationElement & { nested: boolean })[] | null {
  // Declared in <head> only, where the fast check looks.
  const head = elements(document).find((element) => element.tagName === "head");
  const template = head?.childNodes.find(
    (child) => "tagName" in child && child.tagName === "template" && child.attrs.some((attribute) => attribute.name === "data-zd-options"),
  ) as DefaultTreeAdapterTypes.Template | undefined;
  if (!template) return null;
  const declared: (ComponentDeclarationElement & { nested: boolean })[] = [];
  const visit = (node: ParentNode, nested: boolean) => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      declared.push({
        tag: child.tagName,
        attributes: child.attrs.map((attribute) => ({ name: attribute.name, value: attribute.value })),
        offset: child.sourceCodeLocation?.startOffset ?? 0,
        nested,
      });
      if (declared.length > 1_024) throw new ComponentBudgetExceeded();
      visit(child, true);
    }
  };
  visit(template.content, false);
  return declared;
}

const lineOf = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

function readDeclaration(
  declared: readonly (ComponentDeclarationElement & { nested: boolean })[],
  component: string,
  file: string,
  errors: DesignComponentExpansionError[],
  source: string,
): ComponentDeclaration {
  const nested = declared.find((element) => element.nested);
  if (nested) {
    const parent = declared[declared.indexOf(nested) - 1];
    errors.push({
      component,
      code: "component-option-invalid",
      file,
      offset: parent?.offset ?? nested.offset,
      line: lineOf(source, parent?.offset ?? nested.offset),
      message: `Close each <${parent?.tag ?? nested.tag}> with </${parent?.tag ?? nested.tag}>; it cannot hold other elements.`,
    });
  }
  const { declaration, problems } = readComponentDeclaration(declared.filter((element) => !element.nested));
  for (const problem of problems)
    errors.push({ component, code: "component-option-invalid", file, message: problem.message,
      ...(problem.offset !== undefined ? { offset: problem.offset, line: lineOf(source, problem.offset) } : {}), ...(problem.severity === "warning" ? { severity: "warning" as const } : {}) });
  return declaration;
}

function stylesheetLinksOf(document: ParentNode): string[] {
  return elements(document)
    .filter((element) => element.tagName === "link" &&
      element.attrs.some((attribute) => attribute.name === "rel" && attribute.value.split(/\s+/).some((part) => part.toLowerCase() === "stylesheet")))
    .map((element) => element.attrs.find((attribute) => attribute.name === "href")?.value ?? "")
    .filter((href) => href !== "" && !href.startsWith("/") && !/^[a-z][a-z0-9+.-]*:/i.test(href));
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
  budget: ExpansionBudget,
): string {
  budget.charge(definitionBody.length);
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
    budget.charge(result.length + replacement.length);
    budget.output(Buffer.byteLength(result) - Buffer.byteLength(result.slice(location.startOffset, location.endOffset)) + Buffer.byteLength(replacement));
    result = `${result.slice(0, location.startOffset)}${replacement}${result.slice(location.endOffset)}`;
  }
  return result;
}

function injectComponentStyles(
  source: string,
  used: readonly string[],
  definitions: ReadonlyMap<string, ComponentDefinition>,
  budget: ExpansionBudget,
  extra: { rules: readonly string[]; entryFile: string; entryLinks: readonly string[] } = { rules: [], entryFile: "", entryLinks: [] },
): string {
  let bytes = Buffer.byteLength(source);
  for (const name of used) for (const style of definitions.get(name)?.styles ?? []) {
    bytes += Buffer.byteLength(style) + Buffer.byteLength(name) + 40;
    budget.output(bytes);
  }
  // A templated component's own stylesheets come along once each, rebased to
  // the frame, unless the frame already links the same file.
  const linked = new Set(extra.entryLinks.map((href) => resolveFrom(extra.entryFile, href)));
  let linkMarkup = "";
  for (const name of used) {
    const template = definitions.get(name)?.template;
    for (const href of template?.links ?? []) {
      const target = resolveFrom(template!.file, href);
      if (target.startsWith("../") || linked.has(target)) continue;
      linked.add(target);
      const rebased = posix.relative(posix.dirname(extra.entryFile || "x"), target) || posix.basename(target);
      linkMarkup += `<link rel="stylesheet" href="${rebased.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" data-zeros-component="${name}">`;
    }
  }
  const optionsMarkup = extra.rules.length ? `<style data-zeros-options>${extra.rules.join("\n")}</style>` : "";
  bytes += Buffer.byteLength(linkMarkup) + Buffer.byteLength(optionsMarkup);
  budget.output(bytes);
  const styleMarkup = linkMarkup + used
    .flatMap((name) =>
      (definitions.get(name)?.styles ?? []).map(
        (style) => `<style data-zeros-component="${name}">${style}</style>`,
      ),
    )
    .join("") + optionsMarkup;
  if (!styleMarkup) return source;
  if (/<\/head\s*>/i.test(source)) {
    return source.replace(/<\/head\s*>/i, `${styleMarkup}</head>`);
  }
  return `${styleMarkup}${source}`;
}

export async function expandDesignComponents(
  workspacePath: string,
  source: string,
  sources?: Readonly<Record<string, string>>,
  entryFile = "",
  options: DesignComponentExpansionOptions = {},
  usage?: DesignComponentExpansionUsage,
): Promise<DesignComponentExpansion> {
  try {
    if (source.length > MAX_EXPANSION_BYTES || Buffer.byteLength(source) > MAX_EXPANSION_BYTES) throw new ComponentBudgetExceeded();
    return await expandBoundedComponents(workspacePath, source, sources, entryFile, options, usage);
  } catch (error) {
    if (!(error instanceof ComponentBudgetExceeded)) throw error;
    return { html: Buffer.byteLength(source) <= MAX_EXPANSION_BYTES ? source : "", usedComponents: [], errors: [{ component: "", message: error.message }] };
  }
}

/** A frame that declares options renders its own template; without that and
 * without `<zd-` there is nothing to expand. */
const DECLARES_OPTIONS_PATTERN = /<template\b[^>]*\sdata-zd-options\b/i;
/** Options are declared in <head>, so only the head is searched: a frame
 * without them pays a search that ends near the top of the file. */
const DECLARES_OPTIONS = {
  test: (source: string) => {
    const end = source.search(/<\/head\b|<body\b/i);
    return DECLARES_OPTIONS_PATTERN.test(end < 0 ? source : source.slice(0, end));
  },
};
export const designSourceDeclaresOptions = (source: string) => DECLARES_OPTIONS.test(source);

/** The custom properties a frame's own declaration sets on it, by the same
 * rule as the CSS its render carries. */
export function designFrameOptionPropertyNames(source: string, document: DefaultTreeAdapterTypes.Document): string[] {
  if (!DECLARES_OPTIONS.test(source)) return [];
  let declared: ReturnType<typeof declarationElementsOf>;
  try {
    declared = declarationElementsOf(document);
  } catch (error) {
    if (error instanceof ComponentBudgetExceeded) return [];
    throw error;
  }
  return declared ? componentOptionPropertyNames(readComponentDeclaration(declared.filter((element) => !element.nested)).declaration) : [];
}

/** Each <template data-zd-options> the engine does not read: any outside
 * <head>, or after the first one there. */
export function designIgnoredOptionsTemplates(source: string, document: DefaultTreeAdapterTypes.Document): Array<{ element: DefaultTreeAdapterTypes.Element; inHead: boolean }> {
  if (!/\sdata-zd-options\b/i.test(source)) return [];
  let all: DefaultTreeAdapterTypes.Element[];
  try {
    all = elements(document);
  } catch (error) {
    if (error instanceof ComponentBudgetExceeded) return [];
    throw error;
  }
  const declares = (element: DefaultTreeAdapterTypes.Element) =>
    element.tagName === "template" && element.attrs.some((attribute) => attribute.name === "data-zd-options");
  const head = all.find((element) => element.tagName === "head");
  const read = head?.childNodes.find((child) => "tagName" in child && declares(child));
  return all.filter((element) => element !== read && declares(element)).map((element) => ({ element, inHead: element.parentNode === head }));
}

/** Expanded markup alone, for rendering. Element names come only from start
 * tags, so without `<zd-` (or a declaration of options) there is no instance
 * and expansion is the identity; diagnostics such as the element budget need
 * `expandDesignComponents`. */
export async function expandDesignComponentsHtml(
  workspacePath: string,
  source: string,
  sources?: Readonly<Record<string, string>>,
  entryFile = "",
  options: DesignComponentExpansionOptions = {},
): Promise<string> {
  if (!/<zd-/i.test(source) && Buffer.byteLength(source) <= MAX_EXPANSION_BYTES && !DECLARES_OPTIONS.test(source)) return source;
  return (await expandDesignComponents(workspacePath, source, sources, entryFile, options)).html;
}

/** What a frame renders when its component options do not all apply. */
export interface DesignComponentOptionsFallback {
  applied: false;
  /** last-good: this session's last expansion whose options all applied.
   * defaults: no such expansion; failing instances show their defaults.
   * nothing: no such expansion, and the frame's own template failed, so its
   * body is empty. Older renderers are told "defaults" instead. */
  shows: "last-good" | "defaults" | "nothing";
}

/** Expansion for a frame render. A frame whose options do not all apply
 * shows its last good expansion from this session when there is one, and
 * says which it shows; `remember` records a good expansion for next time
 * (a full render does, an identity-only read does not). */
export async function expandDesignComponentsForRender(
  workspacePath: string,
  source: string,
  sources: Readonly<Record<string, string>> | undefined,
  entryFile: string,
  options: DesignComponentExpansionOptions,
  remember: boolean,
): Promise<{ html: string; componentOptions?: DesignComponentOptionsFallback; instances?: DesignFrameInstances }> {
  if (!/<zd-/i.test(source) && Buffer.byteLength(source) <= MAX_EXPANSION_BYTES && !DECLARES_OPTIONS.test(source)) return { html: source };
  const usage: DesignComponentExpansionUsage = { templated: false };
  const expansion = await expandDesignComponents(workspacePath, source, sources, entryFile, options, usage);
  if ((!usage.templated && !usage.instances?.hosts.size) || !entryFile) return { html: expansion.html };
  const instancesOf = (shows?: DesignComponentOptionsFallback["shows"]) => {
    if (!usage.instances || usage.instances.hosts.size === 0) return {};
    const record = {
      components: Object.fromEntries(usage.instances.components),
      hosts: Object.fromEntries(usage.instances.hosts),
      ...(shows ? { notApplied: shows } : {}),
    };
    return { instances: { key: createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 16), ...record } };
  };
  if (!expansion.optionsFailed) {
    // A variant is a view of the main, not its last good render.
    if (remember && !options.variant && usage.templated) rememberDesignComponentRender(workspacePath, entryFile, expansion.html);
    return { html: expansion.html, ...instancesOf() };
  }
  const lastGood = lastGoodDesignComponentRender(workspacePath, entryFile);
  if (lastGood !== undefined) return { html: lastGood, componentOptions: { applied: false, shows: "last-good" }, ...instancesOf("last-good") };
  return { html: expansion.html, componentOptions: { applied: false, shows: expansion.showsNothing?.main ? "nothing" : "defaults" },
    ...instancesOf(expansion.showsNothing?.instances ? "nothing" : "defaults") };
}

export { designComponentSummaryOf, type DesignComponentSummary } from "@zeros/design-web/component-template";

/** The registered frame components: given, or read from the shared canvas. */
async function registryFor(workspacePath: string, options: DesignComponentExpansionOptions): Promise<ReadonlyMap<string, string>> {
  if (options.registry) return options.registry;
  try {
    return designComponentRegistry((await readSharedCanvasContext(workspacePath)).canvas).files;
  } catch {
    return new Map();
  }
}

const posix = path.posix;
const resolveFrom = (file: string, href: string) => posix.normalize(posix.join(posix.dirname(file), href.split(/[?#]/)[0]!));

/** One expansion's options work: the template budget shared by every
 * rendering, each instance's generated rule, and whether anything failed. */
interface OptionsWork {
  budget: ComponentTemplateBudget;
  instances: number;
  rules: string[];
  failed: boolean;
  /** The frame's own template failed: it renders an empty body. */
  mainEmpty?: boolean;
  /** An instance the frame places renders nothing: its defaults failed too. */
  instancesEmpty?: boolean;
}

function problemsToErrors(component: string, problems: readonly ComponentOptionProblem[], code: DesignComponentExpansionCode): DesignComponentExpansionError[] {
  return problems.map((problem) => ({ component, code, message: problem.message, ...(problem.severity === "warning" ? { severity: "warning" as const } : {}) }));
}

const templateMessage = (error: unknown) =>
  error instanceof ComponentTemplateError || error instanceof ComponentExpressionError ? error.message : null;

/** Render a templated definition for one instance: its values, else its
 * defaults, else nothing. Returns the markup and the instance's CSS. */
function renderInstance(
  definition: ComponentDefinition & { template: NonNullable<ComponentDefinition["template"]> },
  attributes: ReadonlyMap<string, string>,
  work: OptionsWork,
  errors: DesignComponentExpansionError[],
): { body: string; css: string; failed?: true; empty?: true } {
  const { declaration } = definition.template;
  const { values, problems } = componentOptionValues(declaration, attributes);
  errors.push(...problemsToErrors(definition.name, problems, "component-value-invalid"));
  const invalid = problems.some((problem) => problem.severity === "error");
  if (invalid) work.failed = true;
  const attempt = (chosen: ReadonlyMap<string, unknown>) => {
    const holes = work.budget.holes;
    try {
      const scope = componentExpressionScope(declaration, chosen as never, work.budget.expression);
      const body = renderComponentTemplate(definition.body, { scope, ids: "part", budget: work.budget });
      return { body, css: componentOptionCss(declaration, chosen as never, scope) };
    } finally {
      // Holes are bounded per rendering; repeats and steps across the frame.
      work.budget.holes = holes;
    }
  };
  try {
    return { ...attempt(values), ...(invalid ? { failed: true as const } : {}) };
  } catch (error) {
    const message = templateMessage(error);
    if (message === null) throw error;
    work.failed = true;
    errors.push({ component: definition.name, code: "component-expression-invalid", message, file: definition.template.file });
  }
  const defaults = componentInheritedValues(declaration, null);
  try {
    return { ...attempt(defaults), failed: true };
  } catch (error) {
    if (templateMessage(error) === null) throw error;
    return { body: "", css: componentOptionCss(declaration, defaults), failed: true, empty: true };
  }
}

/** The frame's document with nothing in its body: its head's styles,
 * stylesheet links and meta, and the html and body tags. A `<style>` is kept
 * as written, since template holes never apply inside one; a link, meta or
 * html or body tag is kept only when it carries no hole, since a failed
 * template evaluates none. */
function emptyDesignDocument(source: string): string {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => node.nodeName === "html");
  const child = (name: string) => html?.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => node.nodeName === name);
  const raw = (location: { startOffset: number; endOffset: number } | undefined) =>
    location ? source.slice(location.startOffset, location.endOffset) : "";
  const tag = (element: DefaultTreeAdapterTypes.Element | undefined, name: string) => {
    const start = raw(element?.sourceCodeLocation?.startTag ?? undefined);
    return start && !start.includes("{{") ? start : `<${name}>`;
  };
  const kept = (child("head")?.childNodes ?? []).flatMap((node) => {
    if (!("tagName" in node) || !["style", "link", "meta"].includes(node.tagName)) return [];
    const text = raw(node.sourceCodeLocation ?? undefined);
    return text && (node.tagName === "style" || !text.includes("{{")) ? [text] : [];
  });
  return `<!doctype html>${tag(html, "html")}<head>${kept.join("")}</head>${tag(child("body"), "body")}</body></html>`;
}

/** The frame's own instances, for the Style panel: each host layer (its
 * data-oid), its component and the option attributes it sets. */
function recordInstance(
  usage: DesignComponentExpansionUsage,
  registry: ReadonlyMap<string, string>,
  definition: ComponentDefinition & { template: NonNullable<ComponentDefinition["template"]> },
  instance: DefaultTreeAdapterTypes.Element,
  failed: boolean,
): void {
  const oid = instance.attrs.find((attribute) => attribute.name === "data-oid")?.value;
  if (!oid || oid.length > DESIGN_COMPONENT_RECORD_LIMITS.layerId || INHERITED_NAMES.has(oid) || INHERITED_NAMES.has(definition.name)) return;
  const record = usage.instances ??= { components: new Map(), hosts: new Map() };
  if (record.hosts.size >= DESIGN_FRAME_INSTANCE_LIMITS.hosts) return;
  const { declaration, file } = definition.template;
  if (!record.components.has(definition.name)) {
    if (record.components.size >= DESIGN_FRAME_INSTANCE_LIMITS.components) return;
    const summary = definition.template.summary?.() ?? null;
    record.components.set(definition.name, designComponentRecordWithinLimits({ elements: summary?.elements ?? [], reach: summary?.reach ?? {}, file,
      frame: registry.get(definition.name) === file }, designFrameInstanceComponentSchema));
  }
  const names = new Set([...declaration.options.map((option) => option.name), COMPONENT_VARIANT_ATTRIBUTE]);
  const attributes = new Map<string, string>();
  const ignored = new Map<string, string>();
  for (const attribute of instance.attrs) {
    if (!names.has(attribute.name)) {
      if (componentIgnoresAttribute(attribute.name) && attribute.name.length <= DESIGN_COMPONENT_RECORD_LIMITS.attributeName &&
        attribute.value.length <= DESIGN_COMPONENT_RECORD_LIMITS.attributeValue && ignored.size < DESIGN_COMPONENT_RECORD_LIMITS.attributes)
        ignored.set(attribute.name, attribute.value);
      continue;
    }
    // A value too long to report would mislead; the host shows no Options.
    if (attribute.value.length > DESIGN_COMPONENT_RECORD_LIMITS.attributeValue) return;
    attributes.set(attribute.name, attribute.value);
  }
  record.hosts.set(oid, { component: definition.name, attributes: Object.fromEntries(attributes), ...(failed ? { failed: true as const } : {}),
    ...(ignored.size ? { ignored: Object.fromEntries(ignored) } : {}) });
}

/** A top-level instance of a name no definition answers to, so the panel and
 * canvas can say which component is gone instead of showing an empty layer. */
function recordMissingInstance(usage: DesignComponentExpansionUsage, name: string, instance: DefaultTreeAdapterTypes.Element): void {
  const oid = instance.attrs.find((attribute) => attribute.name === "data-oid")?.value;
  if (!oid || oid.length > DESIGN_COMPONENT_RECORD_LIMITS.layerId || INHERITED_NAMES.has(oid) || !/^[a-z][a-z0-9-]{0,63}$/.test(name)) return;
  const record = usage.instances ??= { components: new Map(), hosts: new Map() };
  if (record.hosts.size >= DESIGN_FRAME_INSTANCE_LIMITS.hosts) return;
  record.hosts.set(oid, { component: name, attributes: {}, missing: true });
}

async function expandBoundedComponents(
  workspacePath: string, source: string, sources: Readonly<Record<string, string>> | undefined, entryFile: string,
  options: DesignComponentExpansionOptions, usage?: DesignComponentExpansionUsage,
): Promise<DesignComponentExpansion> {
  const budget = new ExpansionBudget();
  const registry = /<zd-/i.test(source) ? await registryFor(workspacePath, options) : new Map<string, string>();
  const loaded = await loadDefinitions(workspacePath, source, sources, registry);
  const definitions = loaded.definitions;
  // Existing definitions use Design-root URL origins. Rebase only definition
  // markup/styles; frame-authored slot children keep the entry file's origin.
  // A registered frame's references are relative to its own file.
  for (const definition of definitions.values()) {
    const from = definition.template && registry.get(definition.name) === definition.template.file ? definition.template.file : "";
    if (from ? posix.dirname(from) === posix.dirname(entryFile || from) : !entryFile.includes("/")) continue;
    try {
      definition.body = rebaseDesignHtmlReferences(definition.body, from, entryFile);
      definition.styles = definition.styles.map((style) => rebaseDesignCssReferences(style, from, entryFile));
    } catch {
      loaded.errors.push({ component: definition.name, message: "Component URLs could not be prepared; repair its authored HTML/CSS." });
    }
  }
  const used = new Set<string>();
  const errors: DesignComponentExpansionError[] = [];
  const work: OptionsWork = { budget: createComponentTemplateBudget(), instances: 0, rules: [], failed: false };

  // A main component frame renders its own template first, with its defaults
  // or the variant it shows; its instances then expand inside the result.
  let entry = source;
  const entryDeclared = DECLARES_OPTIONS.test(source) ? declarationElementsOf(parse(source, { sourceCodeLocationInfo: true })) : null;
  if (entryDeclared) {
    const entryName = [...registry].find(([, file]) => file === entryFile)?.[0] ?? "";
    const declaration = readDeclaration(entryDeclared, entryName, entryFile, errors, source);
    const values = componentInheritedValues(declaration, options.variant ?? null);
    try {
      const scope = componentExpressionScope(declaration, values, work.budget.expression);
      entry = renderComponentTemplate(source, { scope, ids: "copy", budget: work.budget, document: true });
      const css = componentOptionCss(declaration, values, scope);
      if (css) work.rules.push(`:root { ${css} }`);
    } catch (error) {
      const message = templateMessage(error);
      if (message === null) throw error;
      work.failed = true;
      work.mainEmpty = true;
      errors.push({ component: entryName, code: "component-expression-invalid", message, file: entryFile,
        ...(error instanceof ComponentTemplateError && error.offset !== undefined ? { offset: error.offset, line: lineOf(source, error.offset) } : {}) });
      // Raw holes would show as text; render nothing, as an instance does.
      entry = emptyDesignDocument(source);
    }
    budget.charge(entry.length);
    budget.output(Buffer.byteLength(entry));
  }

  const expand = (
    markup: string,
    stack: readonly string[],
    depth: number,
  ): string => {
    if (depth > MAX_EXPANSION_DEPTH) return markup;
    budget.charge(markup.length);
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
      if (++budget.instances > MAX_EXPANSION_INSTANCES) throw new ComponentBudgetExceeded();
      const name = instance.tagName.slice(3);
      const definition = definitions.get(name);
      if (!definition) {
        if (depth === 0 && usage && !loaded.unavailable.has(name)) recordMissingInstance(usage, name, instance);
        continue;
      }
      if (stack.includes(name) || depth === MAX_EXPANSION_DEPTH) {
        if (errors.length < MAX_COMPONENT_DIAGNOSTICS) errors.push({
          component: name,
          message: `Component cycle or depth limit reached for zd-${name}.`,
        });
        continue;
      }
      used.add(name);
      const location = instance.sourceCodeLocation!;
      let startTag = location.startTag ? result.slice(location.startTag.startOffset, location.startTag.endOffset) : result.slice(location.startOffset, location.endOffset);
      let filled: string;
      if (definition.template) {
        const attributes = new Map(instance.attrs.map((attribute) => [attribute.name, attribute.value]));
        const templated = definition as ComponentDefinition & { template: NonNullable<ComponentDefinition["template"]> };
        const rendered = renderInstance(templated, attributes, work, errors);
        if (depth === 0 && usage) recordInstance(usage, registry, templated, instance, rendered.failed === true);
        if (depth === 0 && rendered.empty) work.instancesEmpty = true;
        const id = String(++work.instances);
        if (rendered.css) work.rules.push(`:where([data-zd-instance="${id}"]) { ${rendered.css} }`);
        startTag = startTag.replace(/\s*\/?>$/, (end) => ` data-zd-instance="${id}"${end.trim() === "/>" ? " />" : ">"}`);
        filled = rendered.body ? fillSlots(rendered.body, markup, instance, budget) : "";
      } else {
        filled = fillSlots(definition.body, markup, instance, budget);
      }
      const expanded = expand(filled, [...stack, name], depth + 1);
      budget.charge(result.length + expanded.length);
      // Charge construction before allocating; the exact output is checked below.
      budget.output(Buffer.byteLength(result) + Buffer.byteLength(expanded));
      if (location.startTag && location.endTag) {
        result = definition.template
          ? `${result.slice(0, location.startTag.startOffset)}${startTag}${expanded}${result.slice(location.endTag.startOffset)}`
          : `${result.slice(0, location.startTag.endOffset)}${expanded}${result.slice(location.endTag.startOffset)}`;
      } else {
        startTag = (definition.template ? startTag : result.slice(location.startOffset, location.endOffset)).replace(/\/\s*>$/, ">");
        result = `${result.slice(0, location.startOffset)}${startTag}${expanded}</${instance.tagName}>${result.slice(location.endOffset)}`;
      }
      if (Buffer.byteLength(result, "utf8") > MAX_EXPANSION_BYTES) {
        throw new ComponentBudgetExceeded();
      }
    }
    return result;
  };

  const expandedEntry = expand(entry, [], 0);
  if (usage) usage.templated = entryDeclared !== null || work.instances > 0;
  const usedNames = [...used].sort();
  const carriesLinks = usedNames.some((name) => definitions.get(name)?.template?.links.length);
  const html = injectComponentStyles(
    expandedEntry,
    usedNames,
    definitions,
    budget,
    { rules: work.rules, entryFile, entryLinks: carriesLinks ? stylesheetLinksOf(parse(expandedEntry)) : [] },
  );
  return {
    html,
    usedComponents: [...used].sort(),
    // loadDefinitions visits only the frame's bounded transitive dependency
    // graph. Keep nested diagnostics even when an ancestor is also invalid:
    // invalid definitions remain previewable and their safe remainder expands.
    errors: [...loaded.errors, ...errors].slice(0, MAX_COMPONENT_DIAGNOSTICS),
    ...(work.failed ? { optionsFailed: true as const } : {}),
    ...(work.mainEmpty || work.instancesEmpty ? { showsNothing: { main: work.mainEmpty === true, instances: work.instancesEmpty === true } } : {}),
    ...(loaded.unavailable.size ? { unavailable: [...loaded.unavailable] } : {}),
    ...(loaded.missing.size ? { missing: loaded.missing } : {}),
  };
}
