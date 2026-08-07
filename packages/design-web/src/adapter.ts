import {
  canonicalDesignJson,
  designComponentDefinitionSchema,
  designFoundationManifestSchema,
  designParameterDocumentId,
  designParameterSchema,
  designVariantSchema,
  type DesignFoundationManifest,
  type DesignComponentDefinition,
  type DesignOperation,
  type DesignParameter,
  type DesignParameterBinding,
  type DesignParameterValue,
  type DesignTransactionAdapter,
} from "@zeros/design-core";

import {
  mutateDesignCssRuleDeclaration,
  mutateDesignNodeStyles,
  mutateDesignTokenDeclaration,
} from "./css";
import {
  assertDesignComponentDefinitionIdentities,
  assertSafeDesignHtmlDocument,
  assertSafeDesignHtmlFragment,
  designHtmlUsesComponent,
  healDesignHtmlIdentities,
  mutateDesignNodeAttributeSource,
  mutateDesignNodeHtmlSource,
  mutateDesignNodeTextSource,
  parseDesignWebProjection,
} from "./html";
import type {
  DesignSourceSplice,
  DesignWebDocumentState,
  DesignWebMutation,
} from "./model";
import { updateDesignWebState } from "./revision";

function inverseId(operation: DesignOperation, suffix = "0"): string {
  return `inverse:${operation.operationId}:${suffix}`;
}

function oneSourceSplice(
  file: string,
  before: string,
  after: string,
): DesignSourceSplice | null {
  if (before === after) return null;
  let start = 0;
  const maximumPrefix = Math.min(before.length, after.length);
  while (start < maximumPrefix && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return {
    file,
    start,
    deleteText: after.slice(start, afterEnd),
    insertText: before.slice(start, beforeEnd),
  };
}

function sourceInverseOperations(
  operation: DesignOperation,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): DesignOperation[] {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  const inverse: DesignOperation[] = [];
  for (const file of [...files].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const previous = before[file];
    const next = after[file];
    if (previous === undefined || next === undefined) continue;
    const splice = oneSourceSplice(file, previous, next);
    if (!splice) continue;
    inverse.push({
      operationId: inverseId(operation, String(inverse.length)),
      type: "source.splice",
      ...splice,
    });
  }
  return inverse;
}

function noOpInverse(operation: DesignOperation): DesignOperation {
  return { ...operation, operationId: inverseId(operation) };
}

function withFiles(
  state: DesignWebDocumentState,
  operation: DesignOperation,
  files: Readonly<Record<string, string>>,
  affectedNodeIds: string[],
  decisions?: DesignWebMutation["decisions"],
): DesignWebMutation {
  const affectedFiles = [
    ...new Set([...Object.keys(state.files), ...Object.keys(files)]),
  ].filter((file) => files[file] !== state.files[file]);
  const changed = affectedFiles.length > 0;
  const next = changed ? updateDesignWebState(state, { files }) : state;
  const inverseOperations = sourceInverseOperations(
    operation,
    state.files,
    files,
  );
  return {
    state: next,
    changed,
    inverseOperations:
      inverseOperations.length > 0
        ? inverseOperations
        : [noOpInverse(operation)],
    affectedNodeIds,
    affectedFiles,
    ...(decisions ? { decisions } : {}),
  };
}

function withManifest(
  state: DesignWebDocumentState,
  operation: DesignOperation,
  manifest: DesignFoundationManifest,
  inverse: DesignOperation | readonly DesignOperation[],
  files: Readonly<Record<string, string>> = state.files,
): DesignWebMutation {
  const parsed = designFoundationManifestSchema.parse(manifest);
  const next = updateDesignWebState(state, { manifest: parsed, files });
  const inverses = Array.isArray(inverse) ? inverse : [inverse];
  return {
    state: next,
    changed: next.revision !== state.revision,
    inverseOperations: inverses.map((item, index) => ({
      ...item,
      operationId: inverseId(operation, String(index)),
    })) as DesignOperation[],
    affectedNodeIds: [],
    affectedFiles: [
      ...new Set([...Object.keys(state.files), ...Object.keys(files)]),
    ].filter((file) => files[file] !== state.files[file]),
  };
}

function parameterValueText(value: DesignParameterValue): string {
  if (value === null)
    throw new Error("A bound parameter value cannot be null.");
  return typeof value === "boolean"
    ? value
      ? "true"
      : "false"
    : String(value);
}

function bindingKey(binding: DesignParameterBinding): string {
  return canonicalDesignJson(binding);
}

function applyParameterBindings(
  state: DesignWebDocumentState,
  filesInput: Readonly<Record<string, string>>,
  parameter: DesignParameter,
  value: DesignParameterValue,
): Readonly<Record<string, string>> {
  const files = { ...filesInput };
  for (const binding of parameter.bindings) {
    if (binding.documentId !== state.documentId) {
      throw new Error(
        `Parameter binding targets another document: ${binding.documentId}`,
      );
    }
    const text = parameterValueText(value);
    if (binding.kind === "css-custom-property") {
      const source = files[binding.file];
      if (source === undefined)
        throw new Error(`Bound CSS file is missing: ${binding.file}`);
      files[binding.file] = mutateDesignCssRuleDeclaration(
        source,
        binding.selector,
        binding.name,
        text,
      );
      continue;
    }
    if (binding.kind === "css-declaration") {
      if (binding.scope === "inline") {
        const mutation = mutateDesignNodeStyles(
          { ...state, files },
          {
            nodeId: binding.nodeId,
            styles: { [binding.property]: text },
            scope: "inline",
          },
        );
        Object.assign(files, mutation.files);
        continue;
      }
      if (binding.scope === "rule" && binding.selector) {
        const source = files[binding.file];
        if (source === undefined)
          throw new Error(`Bound CSS file is missing: ${binding.file}`);
        files[binding.file] = mutateDesignCssRuleDeclaration(
          source,
          binding.selector,
          binding.property,
          text,
        );
        continue;
      }
    }
    if (binding.kind === "component-prop") {
      files[state.entryFile] = mutateDesignNodeAttributeSource(
        files[state.entryFile]!,
        binding.instanceId,
        binding.prop,
        text,
      );
      continue;
    }
    if (binding.kind === "svg-attribute") {
      files[state.entryFile] = mutateDesignNodeAttributeSource(
        files[state.entryFile]!,
        binding.nodeId,
        binding.attribute,
        text,
      );
      continue;
    }
    throw new Error(
      `Parameter binding is not executable by the web adapter: ${binding.kind}`,
    );
  }
  return files;
}

function assertParameterDocument(
  state: DesignWebDocumentState,
  parameter: DesignParameter,
): void {
  const owner = designParameterDocumentId(parameter);
  if (owner !== null && owner !== state.documentId) {
    throw new Error(
      `Design parameter ${parameter.id} belongs to another document: ${owner}.`,
    );
  }
}

function assertComponentFile(componentId: string, file: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(componentId)) {
    throw new Error(
      "Web component ids must be lowercase custom-element names.",
    );
  }
  if (file !== `components/${componentId}.html`) {
    throw new Error(
      `Web component file must match its id: components/${componentId}.html.`,
    );
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

function instanceMarkup(
  operation: Extract<DesignOperation, { type: "instance.create" }>,
): string {
  const attributes = Object.entries(operation.props)
    .filter(([, value]) => value !== null && value !== false)
    .map(([name, value]) =>
      value === true
        ? ` ${name}`
        : ` ${name}="${escapeAttribute(String(value))}"`,
    )
    .join("");
  return `<zd-${operation.componentId} data-oid="${escapeAttribute(operation.instanceNodeId)}"${attributes}>${operation.slotHtml}</zd-${operation.componentId}>`;
}

function assertInstanceProps(
  component: DesignComponentDefinition,
  props: Readonly<Record<string, DesignParameterValue>>,
): void {
  const definitions = new Map(component.props.map((prop) => [prop.name, prop]));
  for (const [name, value] of Object.entries(props)) {
    const definition = definitions.get(name);
    if (!definition) {
      throw new Error(`Unknown component prop for ${component.id}: ${name}`);
    }
    const valid =
      definition.type === "string"
        ? typeof value === "string"
        : definition.type === "number"
          ? typeof value === "number"
          : definition.type === "boolean"
            ? typeof value === "boolean"
            : definition.type === "enum"
              ? (definition.options ?? []).some((option) =>
                  Object.is(option, value),
                )
              : false;
    if (!valid) {
      throw new Error(`Invalid component prop ${name} for ${component.id}.`);
    }
  }
}

function applyOperation(
  state: DesignWebDocumentState,
  operation: DesignOperation,
): DesignWebMutation {
  if (operation.type === "source.splice") {
    const source = state.files[operation.file];
    if (source === undefined)
      throw new Error(`Design source file is missing: ${operation.file}`);
    if (
      source.slice(
        operation.start,
        operation.start + operation.deleteText.length,
      ) !== operation.deleteText
    ) {
      throw new Error(
        `Design source inverse no longer matches: ${operation.file}.`,
      );
    }
    const updated = `${source.slice(0, operation.start)}${operation.insertText}${source.slice(operation.start + operation.deleteText.length)}`;
    const files = { ...state.files, [operation.file]: updated };
    const next = updateDesignWebState(state, { files });
    return {
      state: next,
      changed: updated !== source,
      inverseOperations: [
        {
          operationId: inverseId(operation),
          type: "source.splice",
          file: operation.file,
          start: operation.start,
          deleteText: operation.insertText,
          insertText: operation.deleteText,
        },
      ],
      affectedNodeIds: [],
      affectedFiles: [operation.file],
    };
  }
  if (operation.type === "node.set-styles") {
    const mutation = mutateDesignNodeStyles(state, {
      nodeId: operation.nodeId,
      styles: operation.styles,
      scope: operation.scope,
      responsiveContext: operation.responsiveContext,
      stateContext: operation.stateContext,
    });
    return withFiles(
      state,
      operation,
      mutation.files,
      [operation.nodeId],
      mutation.decisions,
    );
  }
  if (operation.type === "node.set-text") {
    const source = state.files[state.entryFile]!;
    const updated = mutateDesignNodeTextSource(
      source,
      operation.nodeId,
      operation.text,
    );
    return withFiles(
      state,
      operation,
      { ...state.files, [state.entryFile]: updated },
      [operation.nodeId],
    );
  }
  if (operation.type === "node.set-attribute") {
    const source = state.files[state.entryFile]!;
    const updated = mutateDesignNodeAttributeSource(
      source,
      operation.nodeId,
      operation.attribute,
      operation.value,
    );
    return withFiles(
      state,
      operation,
      { ...state.files, [state.entryFile]: updated },
      [operation.nodeId],
    );
  }
  if (operation.type === "node.set-html") {
    const source = state.files[state.entryFile]!;
    const updated = mutateDesignNodeHtmlSource(
      source,
      operation.nodeId,
      operation.html,
      operation.mode,
    );
    const healed = healDesignHtmlIdentities(updated).source;
    return withFiles(
      state,
      operation,
      { ...state.files, [state.entryFile]: healed },
      [operation.nodeId],
    );
  }
  if (operation.type === "frame.set-geometry") {
    const previous = state.frames[operation.frame];
    if (!previous) {
      throw new Error(`Frame geometry not found: ${operation.frame}`);
    }
    const geometry = operation.geometry;
    const frames = {
      ...state.frames,
      [operation.frame]: {
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        z: geometry.z,
      },
    };
    const next = updateDesignWebState(state, { frames });
    const inverse: DesignOperation = {
      operationId: inverseId(operation),
      type: "frame.set-geometry",
      frame: operation.frame,
      geometry: previous,
    };
    return {
      state: next,
      changed: next.revision !== state.revision,
      inverseOperations: [inverse],
      affectedNodeIds: [],
      affectedFiles: [".zeros-canvas.json"],
    };
  }
  if (operation.type === "token.set") {
    if (!operation.file.toLowerCase().endsWith(".css")) {
      throw new Error(`Design token file is not CSS: ${operation.file}`);
    }
    const source = state.files[operation.file];
    if (source === undefined) {
      throw new Error(`Design token file is missing: ${operation.file}`);
    }
    const files = {
      ...state.files,
      [operation.file]: mutateDesignTokenDeclaration(
        source,
        operation.name,
        operation.theme,
        operation.value,
      ),
    };
    return withFiles(state, operation, files, []);
  }
  if (operation.type === "component.create") {
    const component = designComponentDefinitionSchema.parse(
      operation.component,
    );
    assertComponentFile(component.id, component.file);
    if (state.manifest.components.some((item) => item.id === component.id)) {
      throw new Error(`Design component already exists: ${component.id}`);
    }
    if (state.files[component.file] !== undefined) {
      throw new Error(
        `Design component file already exists: ${component.file}`,
      );
    }
    assertSafeDesignHtmlDocument(operation.html);
    if (/\bdata-oid\b/i.test(operation.html)) {
      throw new Error(
        "Component definitions use definition-local identity, not data-oid.",
      );
    }
    assertDesignComponentDefinitionIdentities(operation.html);
    const manifest = {
      ...state.manifest,
      components: [...state.manifest.components, component],
    };
    const files = { ...state.files, [component.file]: operation.html };
    return withManifest(
      state,
      operation,
      manifest,
      {
        operationId: inverseId(operation),
        type: "component.delete",
        componentId: component.id,
      },
      files,
    );
  }
  if (operation.type === "component.delete") {
    const component = state.manifest.components.find(
      (item) => item.id === operation.componentId,
    );
    if (!component)
      throw new Error(`Design component not found: ${operation.componentId}`);
    const referencingFile = Object.entries(state.files).find(
      ([file, source]) =>
        file !== component.file &&
        file.toLowerCase().endsWith(".html") &&
        designHtmlUsesComponent(source, operation.componentId),
    )?.[0];
    if (referencingFile) {
      throw new Error(
        `Design component still has instances: ${operation.componentId}`,
      );
    }
    const html = state.files[component.file];
    if (html === undefined)
      throw new Error(`Design component file is missing: ${component.file}`);
    const files = { ...state.files };
    delete files[component.file];
    const manifest = {
      ...state.manifest,
      components: state.manifest.components.filter(
        (item) => item.id !== component.id,
      ),
    };
    return withManifest(
      state,
      operation,
      manifest,
      {
        operationId: inverseId(operation),
        type: "component.create",
        component,
        html,
      },
      files,
    );
  }
  if (operation.type === "instance.create") {
    const component = state.manifest.components.find(
      (item) => item.id === operation.componentId,
    );
    if (!component)
      throw new Error(`Design component not found: ${operation.componentId}`);
    assertInstanceProps(component, operation.props);
    assertSafeDesignHtmlFragment(operation.slotHtml);
    const source = state.files[state.entryFile]!;
    const inserted = mutateDesignNodeHtmlSource(
      source,
      operation.parentNodeId,
      instanceMarkup(operation),
      "append",
    );
    const healed = healDesignHtmlIdentities(inserted).source;
    return withFiles(
      state,
      operation,
      { ...state.files, [state.entryFile]: healed },
      [operation.parentNodeId, operation.instanceNodeId],
    );
  }
  if (operation.type === "parameter.create") {
    const parameter = designParameterSchema.parse(operation.parameter);
    assertParameterDocument(state, parameter);
    if (state.manifest.parameters.some((item) => item.id === parameter.id)) {
      throw new Error(`Design parameter already exists: ${parameter.id}`);
    }
    const files = applyParameterBindings(
      state,
      state.files,
      parameter,
      parameter.value,
    );
    const sourceInverses = sourceInverseOperations(
      operation,
      state.files,
      files,
    );
    return withManifest(
      state,
      operation,
      {
        ...state.manifest,
        parameters: [...state.manifest.parameters, parameter],
      },
      [
        {
          operationId: inverseId(operation),
          type: "parameter.delete",
          parameterId: parameter.id,
        },
        ...sourceInverses,
      ],
      files,
    );
  }
  if (operation.type === "parameter.delete") {
    const parameter = state.manifest.parameters.find(
      (item) => item.id === operation.parameterId,
    );
    if (!parameter)
      throw new Error(`Design parameter not found: ${operation.parameterId}`);
    assertParameterDocument(state, parameter);
    if (
      state.manifest.variants.some(
        (variant) => variant.parameterValues[parameter.id] !== undefined,
      )
    ) {
      throw new Error(
        `Design parameter is still referenced by a variant: ${parameter.id}`,
      );
    }
    return withManifest(
      state,
      operation,
      {
        ...state.manifest,
        parameters: state.manifest.parameters.filter(
          (item) => item.id !== parameter.id,
        ),
      },
      {
        operationId: inverseId(operation),
        type: "parameter.create",
        parameter,
      },
    );
  }
  if (operation.type === "parameter.set") {
    const index = state.manifest.parameters.findIndex(
      (item) => item.id === operation.parameterId,
    );
    const parameter = state.manifest.parameters[index];
    if (!parameter)
      throw new Error(`Design parameter not found: ${operation.parameterId}`);
    assertParameterDocument(state, parameter);
    if (operation.variantId) {
      const variantIndex = state.manifest.variants.findIndex(
        (item) => item.id === operation.variantId,
      );
      const variant = state.manifest.variants[variantIndex];
      if (!variant)
        throw new Error(`Design variant not found: ${operation.variantId}`);
      const hadValue = Object.prototype.hasOwnProperty.call(
        variant.parameterValues,
        parameter.id,
      );
      const previous = variant.parameterValues[parameter.id];
      const variants = [...state.manifest.variants];
      variants[variantIndex] = designVariantSchema.parse({
        ...variant,
        parameterValues: {
          ...variant.parameterValues,
          [parameter.id]: operation.value,
        },
      });
      return withManifest(
        state,
        operation,
        { ...state.manifest, variants },
        hadValue
          ? {
              operationId: inverseId(operation),
              type: "variant.set-parameter",
              variantId: variant.id,
              parameterId: parameter.id,
              value: previous!,
            }
          : {
              operationId: inverseId(operation),
              type: "variant.unset-parameter",
              variantId: variant.id,
              parameterId: parameter.id,
            },
      );
    }
    const updated = designParameterSchema.parse({
      ...parameter,
      value: operation.value,
    });
    const parameters = [...state.manifest.parameters];
    parameters[index] = updated;
    const files = applyParameterBindings(
      state,
      state.files,
      updated,
      operation.value,
    );
    return withManifest(
      state,
      operation,
      { ...state.manifest, parameters },
      {
        operationId: inverseId(operation),
        type: "parameter.set",
        parameterId: parameter.id,
        value: parameter.value,
      },
      files,
    );
  }
  if (
    operation.type === "parameter.bind" ||
    operation.type === "parameter.unbind"
  ) {
    const index = state.manifest.parameters.findIndex(
      (item) => item.id === operation.parameterId,
    );
    const parameter = state.manifest.parameters[index];
    if (!parameter)
      throw new Error(`Design parameter not found: ${operation.parameterId}`);
    assertParameterDocument(state, parameter);
    if (operation.binding.documentId !== state.documentId) {
      throw new Error(
        `Parameter binding targets another document: ${operation.binding.documentId}`,
      );
    }
    const target = bindingKey(operation.binding);
    const existing = parameter.bindings.some(
      (binding) => bindingKey(binding) === target,
    );
    if (operation.type === "parameter.bind" && existing)
      return {
        state,
        changed: false,
        inverseOperations: [noOpInverse(operation)],
        affectedNodeIds: [],
        affectedFiles: [],
      };
    if (operation.type === "parameter.unbind" && !existing)
      return {
        state,
        changed: false,
        inverseOperations: [noOpInverse(operation)],
        affectedNodeIds: [],
        affectedFiles: [],
      };
    const bindings =
      operation.type === "parameter.bind"
        ? [...parameter.bindings, operation.binding]
        : parameter.bindings.filter(
            (binding) => bindingKey(binding) !== target,
          );
    const parameters = [...state.manifest.parameters];
    const updated = designParameterSchema.parse({ ...parameter, bindings });
    parameters[index] = updated;
    const files =
      operation.type === "parameter.bind"
        ? applyParameterBindings(state, state.files, updated, updated.value)
        : state.files;
    const sourceInverses = sourceInverseOperations(
      operation,
      state.files,
      files,
    );
    return withManifest(
      state,
      operation,
      { ...state.manifest, parameters },
      [
        {
          operationId: inverseId(operation),
          type:
            operation.type === "parameter.bind"
              ? "parameter.unbind"
              : "parameter.bind",
          parameterId: parameter.id,
          binding: operation.binding,
        },
        ...sourceInverses,
      ],
      files,
    );
  }
  if (operation.type === "variant.create") {
    const variant = designVariantSchema.parse(operation.variant);
    if (state.manifest.variants.some((item) => item.id === variant.id)) {
      throw new Error(`Design variant already exists: ${variant.id}`);
    }
    return withManifest(
      state,
      operation,
      { ...state.manifest, variants: [...state.manifest.variants, variant] },
      {
        operationId: inverseId(operation),
        type: "variant.delete",
        variantId: variant.id,
      },
    );
  }
  if (operation.type === "variant.delete") {
    const variant = state.manifest.variants.find(
      (item) => item.id === operation.variantId,
    );
    if (!variant)
      throw new Error(`Design variant not found: ${operation.variantId}`);
    return withManifest(
      state,
      operation,
      {
        ...state.manifest,
        variants: state.manifest.variants.filter(
          (item) => item.id !== variant.id,
        ),
      },
      { operationId: inverseId(operation), type: "variant.create", variant },
    );
  }
  if (
    operation.type === "variant.set-parameter" ||
    operation.type === "variant.unset-parameter"
  ) {
    const index = state.manifest.variants.findIndex(
      (item) => item.id === operation.variantId,
    );
    const variant = state.manifest.variants[index];
    if (!variant)
      throw new Error(`Design variant not found: ${operation.variantId}`);
    const parameter = state.manifest.parameters.find(
      (item) => item.id === operation.parameterId,
    );
    if (!parameter) {
      throw new Error(`Design parameter not found: ${operation.parameterId}`);
    }
    assertParameterDocument(state, parameter);
    const hadValue = Object.prototype.hasOwnProperty.call(
      variant.parameterValues,
      operation.parameterId,
    );
    const previous = variant.parameterValues[operation.parameterId];
    const parameterValues = { ...variant.parameterValues };
    if (operation.type === "variant.set-parameter")
      parameterValues[operation.parameterId] = operation.value;
    else delete parameterValues[operation.parameterId];
    const variants = [...state.manifest.variants];
    variants[index] = designVariantSchema.parse({
      ...variant,
      parameterValues,
    });
    const inverse: DesignOperation = hadValue
      ? {
          operationId: inverseId(operation),
          type: "variant.set-parameter",
          variantId: variant.id,
          parameterId: operation.parameterId,
          value: previous!,
        }
      : {
          operationId: inverseId(operation),
          type: "variant.unset-parameter",
          variantId: variant.id,
          parameterId: operation.parameterId,
        };
    return withManifest(
      state,
      operation,
      { ...state.manifest, variants },
      inverse,
    );
  }
  const exhaustive: never = operation;
  throw new Error(`Unsupported design operation: ${String(exhaustive)}`);
}

export const designWebTransactionAdapter: DesignTransactionAdapter<DesignWebDocumentState> =
  {
    documentId: (state) => state.documentId,
    revision: (state) => state.revision,
    apply: (state, operation) => {
      const mutation = applyOperation(state, operation);
      return {
        state: mutation.state,
        changed: mutation.changed,
        inverse: mutation.inverseOperations,
        affectedNodeIds: mutation.affectedNodeIds,
        affectedFiles: mutation.affectedFiles,
      };
    },
  };

export function readDesignWebProjection(state: DesignWebDocumentState) {
  return parseDesignWebProjection({
    documentId: state.documentId,
    revision: state.revision,
    entryFile: state.entryFile,
    source: state.files[state.entryFile]!,
  });
}
