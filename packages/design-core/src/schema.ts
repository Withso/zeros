import { z } from "zod";

export const DESIGN_FOUNDATION_SCHEMA_VERSION = 1 as const;
export const DESIGN_TRANSACTION_MAX_OPERATIONS = 256;
export const DESIGN_TRANSACTION_MAX_INPUT_UNITS = 4 * 1024 * 1024;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const CSS_PROPERTY = /^(?:--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/;
const CSS_CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]+$/;

/** Allocation-light preflight for untrusted transaction envelopes. The unit
 * count is conservative JavaScript string/code-unit storage rather than a
 * wire encoding; transport adapters may impose a smaller byte limit. */
export function assertDesignTransactionInputSize(input: unknown): void {
  let units = 0;
  const seen = new WeakSet<object>();
  const add = (amount: number) => {
    units += amount;
    if (units > DESIGN_TRANSACTION_MAX_INPUT_UNITS) {
      throw new Error("Design transaction exceeds the 4 MiB input limit.");
    }
  };
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      add(value.length + 2);
      return;
    }
    if (
      value === null ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      add(24);
      return;
    }
    if (typeof value !== "object") {
      add(32);
      return;
    }
    if (seen.has(value)) {
      throw new Error("Design transaction input cannot contain cycles.");
    }
    seen.add(value);
    add(2);
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else {
      for (const key of Object.keys(value)) {
        add(key.length + 3);
        visit((value as Record<string, unknown>)[key]);
      }
    }
    seen.delete(value);
  };
  visit(input);
}

export const designIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => !CONTROL_CHARACTER.test(value),
    "ID contains control characters",
  );

export const designPortableIdSchema = designIdSchema.refine(
  (value) => SAFE_ID.test(value),
  "ID must be portable",
);

export const designNodeIdSchema = designIdSchema;
export const designDocumentIdSchema = designPortableIdSchema;
export const designRevisionSchema = z
  .string()
  .min(8)
  .max(128)
  .refine(
    (value) => !CONTROL_CHARACTER.test(value),
    "Revision contains control characters",
  );

export const designRelativeFileSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      SAFE_FILE.test(value) &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((part) => part !== "." && part !== ".."),
    "File must be a portable relative path",
  );

export const designComponentNodeAddressSchema = z
  .object({
    rootInstanceId: designNodeIdSchema,
    definitionPath: z
      .array(
        z
          .object({
            componentId: designPortableIdSchema,
            definitionNodeId: designNodeIdSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export type DesignComponentNodeAddress = z.infer<
  typeof designComponentNodeAddressSchema
>;

export const designActorSchema = z
  .object({
    kind: z.enum(["human", "agent", "system"]),
    id: designPortableIdSchema,
    displayName: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type DesignActor = z.infer<typeof designActorSchema>;

export const designParameterValueSchema = z.union([
  z.string().max(2_048),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type DesignParameterValue = z.infer<typeof designParameterValueSchema>;

type DesignValueType =
  | "number"
  | "string"
  | "boolean"
  | "color"
  | "length"
  | "angle"
  | "enum";

function parameterValueMatchesType(
  type: DesignValueType,
  value: DesignParameterValue,
): boolean {
  if (type === "number") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string" || type === "color") return typeof value === "string";
  if (type === "length" || type === "angle") {
    return typeof value === "number" || typeof value === "string";
  }
  return value !== null;
}

function parameterValuesEqual(
  left: DesignParameterValue,
  right: DesignParameterValue,
): boolean {
  return Object.is(left, right);
}

function parameterValueSatisfiesContract(
  parameter: {
    type: DesignValueType;
    min?: number;
    max?: number;
    options?: readonly { value: DesignParameterValue }[];
  },
  value: DesignParameterValue,
): boolean {
  if (!parameterValueMatchesType(parameter.type, value)) return false;
  if (typeof value === "number") {
    if (parameter.min !== undefined && value < parameter.min) return false;
    if (parameter.max !== undefined && value > parameter.max) return false;
  }
  return (
    parameter.type !== "enum" ||
    Boolean(
      parameter.options?.some((option) =>
        parameterValuesEqual(option.value, value),
      ),
    )
  );
}

const designBindingBaseSchema = z.object({
  documentId: designDocumentIdSchema,
});

export const designParameterBindingSchema = z.discriminatedUnion("kind", [
  designBindingBaseSchema
    .extend({
      kind: z.literal("css-custom-property"),
      name: z.string().regex(CSS_CUSTOM_PROPERTY).max(128),
      selector: z.string().min(1).max(1_024).default(":root"),
      file: designRelativeFileSchema,
    })
    .strict(),
  designBindingBaseSchema
    .extend({
      kind: z.literal("css-declaration"),
      nodeId: designNodeIdSchema,
      property: z.string().regex(CSS_PROPERTY).max(128),
      scope: z.enum(["inline", "rule", "component", "instance"]),
      file: designRelativeFileSchema,
      selector: z.string().min(1).max(1_024).optional(),
    })
    .strict(),
  designBindingBaseSchema
    .extend({
      kind: z.literal("component-prop"),
      instanceId: designNodeIdSchema,
      prop: designPortableIdSchema,
    })
    .strict(),
  designBindingBaseSchema
    .extend({
      kind: z.literal("svg-attribute"),
      nodeId: designNodeIdSchema,
      attribute: designPortableIdSchema,
    })
    .strict(),
  designBindingBaseSchema
    .extend({
      kind: z.literal("shader-uniform"),
      materialId: designPortableIdSchema,
      uniform: designPortableIdSchema,
    })
    .strict(),
  designBindingBaseSchema
    .extend({
      kind: z.literal("material-input"),
      materialId: designPortableIdSchema,
      input: designPortableIdSchema,
    })
    .strict(),
  designBindingBaseSchema
    .extend({
      kind: z.literal("transform"),
      nodeId: designNodeIdSchema,
      channel: z.enum([
        "x",
        "y",
        "z",
        "rotation-x",
        "rotation-y",
        "rotation-z",
        "scale-x",
        "scale-y",
        "scale-z",
      ]),
    })
    .strict(),
]);
export type DesignParameterBinding = z.infer<
  typeof designParameterBindingSchema
>;

export const designParameterSchema = z
  .object({
    id: designPortableIdSchema,
    name: z.string().trim().min(1).max(160),
    type: z.enum([
      "number",
      "string",
      "boolean",
      "color",
      "length",
      "angle",
      "enum",
    ]),
    defaultValue: designParameterValueSchema,
    value: designParameterValueSchema,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    step: z.number().finite().positive().optional(),
    unit: z.string().trim().max(32).optional(),
    options: z
      .array(
        z
          .object({
            label: z.string().trim().min(1).max(120),
            value: designParameterValueSchema,
          })
          .strict(),
      )
      .max(128)
      .optional(),
    bindings: z.array(designParameterBindingSchema).max(64).default([]),
    description: z.string().trim().max(1_000).optional(),
    visibleWhen: z
      .object({
        parameterId: designPortableIdSchema,
        equals: designParameterValueSchema,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((parameter, context) => {
    if (!parameterValueMatchesType(parameter.type, parameter.defaultValue)) {
      context.addIssue({
        code: "custom",
        message: `${parameter.type} default value has the wrong type`,
        path: ["defaultValue"],
      });
    }
    if (!parameterValueMatchesType(parameter.type, parameter.value)) {
      context.addIssue({
        code: "custom",
        message: `${parameter.type} value has the wrong type`,
        path: ["value"],
      });
    }
    if (
      parameter.min !== undefined &&
      parameter.max !== undefined &&
      parameter.min > parameter.max
    ) {
      context.addIssue({
        code: "custom",
        message: "Parameter min cannot exceed max",
        path: ["min"],
      });
    }
    if (parameter.type === "enum" && !parameter.options?.length) {
      context.addIssue({
        code: "custom",
        message: "Enum parameters require options",
        path: ["options"],
      });
    }
    if (parameter.options && parameter.type !== "enum") {
      context.addIssue({
        code: "custom",
        message: "Only enum parameters may declare options",
        path: ["options"],
      });
    }
    if (parameter.type === "enum" && parameter.options?.length) {
      const values = parameter.options.map((option) => option.value);
      if (
        !values.some((value) =>
          parameterValuesEqual(value, parameter.defaultValue),
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Enum default value must match one declared option",
          path: ["defaultValue"],
        });
      }
      if (
        !values.some((value) => parameterValuesEqual(value, parameter.value))
      ) {
        context.addIssue({
          code: "custom",
          message: "Enum value must match one declared option",
          path: ["value"],
        });
      }
      values.forEach((value, index) => {
        if (
          values.some(
            (candidate, candidateIndex) =>
              candidateIndex < index && parameterValuesEqual(candidate, value),
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Enum option values must be unique",
            path: ["options", index, "value"],
          });
        }
      });
    }
    (
      [
        ["defaultValue", parameter.defaultValue],
        ["value", parameter.value],
      ] as const
    ).forEach(([label, value]) => {
      if (typeof value !== "number") return;
      if (parameter.min !== undefined && value < parameter.min) {
        context.addIssue({
          code: "custom",
          message: `Parameter ${label} is below min`,
          path: [label],
        });
      }
      if (parameter.max !== undefined && value > parameter.max) {
        context.addIssue({
          code: "custom",
          message: `Parameter ${label} exceeds max`,
          path: [label],
        });
      }
    });
    const bindingKeys = new Set<string>();
    const bindingDocuments = new Set<string>();
    parameter.bindings.forEach((binding, index) => {
      const key = JSON.stringify(binding);
      if (bindingKeys.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Parameter bindings must be unique",
          path: ["bindings", index],
        });
      }
      bindingKeys.add(key);
      bindingDocuments.add(binding.documentId);
    });
    if (bindingDocuments.size > 1) {
      context.addIssue({
        code: "custom",
        message:
          "A Foundation 1.0 parameter may bind to only one document; use a workspace transaction for cross-document parameters",
        path: ["bindings"],
      });
    }
  });
export type DesignParameter = z.infer<typeof designParameterSchema>;

/** The owning document for an executable parameter, or null while the
 * parameter is an unbound workspace-level control. The schema guarantees at
 * most one distinct owner in Foundation 1.0. */
export function designParameterDocumentId(
  parameter: Pick<DesignParameter, "bindings">,
): string | null {
  return parameter.bindings[0]?.documentId ?? null;
}

export const designVariantSchema = z
  .object({
    id: designPortableIdSchema,
    name: z.string().trim().min(1).max(160),
    axis: z.string().trim().min(1).max(120),
    baseId: designPortableIdSchema.optional(),
    parameterValues: z
      .record(designPortableIdSchema, designParameterValueSchema)
      .default({}),
  })
  .strict();
export type DesignVariant = z.infer<typeof designVariantSchema>;

export const designComponentPropSchema = z
  .object({
    name: designPortableIdSchema,
    type: z.enum(["string", "number", "boolean", "enum", "slot"]),
    defaultValue: designParameterValueSchema.optional(),
    options: z.array(designParameterValueSchema).max(128).optional(),
  })
  .strict()
  .superRefine((prop, context) => {
    if (
      prop.type === "slot" &&
      (prop.defaultValue !== undefined || prop.options !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Slot props cannot declare a default value or options",
        path: [prop.defaultValue !== undefined ? "defaultValue" : "options"],
      });
    }
    if (prop.type === "enum" && !prop.options?.length) {
      context.addIssue({
        code: "custom",
        message: "Enum component props require options",
        path: ["options"],
      });
    }
    if (prop.options && prop.type !== "enum") {
      context.addIssue({
        code: "custom",
        message: "Only enum component props may declare options",
        path: ["options"],
      });
    }
    if (prop.defaultValue === undefined || prop.type === "slot") return;
    const type = prop.type === "enum" ? "enum" : prop.type;
    if (!parameterValueMatchesType(type, prop.defaultValue)) {
      context.addIssue({
        code: "custom",
        message: `${prop.type} component prop default has the wrong type`,
        path: ["defaultValue"],
      });
    }
    if (
      prop.type === "enum" &&
      prop.options &&
      !prop.options.some((option) =>
        parameterValuesEqual(option, prop.defaultValue!),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Enum component prop default must match one option",
        path: ["defaultValue"],
      });
    }
    if (prop.type === "enum" && prop.options) {
      prop.options.forEach((option, index) => {
        if (option === null) {
          context.addIssue({
            code: "custom",
            message: "Enum component options cannot be null",
            path: ["options", index],
          });
        }
        if (
          prop.options!.some(
            (candidate, candidateIndex) =>
              candidateIndex < index && parameterValuesEqual(candidate, option),
          )
        ) {
          context.addIssue({
            code: "custom",
            message: "Enum component options must be unique",
            path: ["options", index],
          });
        }
      });
    }
  });

export const designComponentDefinitionSchema = z
  .object({
    id: designPortableIdSchema,
    name: z.string().trim().min(1).max(160),
    file: designRelativeFileSchema,
    props: z.array(designComponentPropSchema).max(128).default([]),
    slots: z.array(designPortableIdSchema).max(64).default([]),
  })
  .strict();
export type DesignComponentDefinition = z.infer<
  typeof designComponentDefinitionSchema
>;

const operationBase = z.object({
  operationId: designPortableIdSchema,
});

const styleValueSchema = z.union([z.string().max(2_048), z.null()]);

export const designOperationSchema = z.discriminatedUnion("type", [
  // Internal inverse primitive. Public adapters must not grant callers this
  // operation directly; it exists so undo can restore the exact authored
  // declaration/span chosen by a provenance-aware semantic operation.
  operationBase
    .extend({
      type: z.literal("source.splice"),
      file: designRelativeFileSchema,
      start: z.number().int().nonnegative(),
      deleteText: z.string().max(1_000_000),
      insertText: z.string().max(1_000_000),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("node.set-styles"),
      nodeId: designNodeIdSchema,
      styles: z.record(
        z.string().regex(CSS_PROPERTY).max(128),
        styleValueSchema,
      ),
      scope: z
        .enum(["auto", "inline", "rule", "component", "instance"])
        .default("auto"),
      responsiveContext: z.string().trim().max(120).default("base"),
      stateContext: z.string().trim().max(120).default("default"),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("node.set-text"),
      nodeId: designNodeIdSchema,
      text: z.string().max(100_000),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("node.set-attribute"),
      nodeId: designNodeIdSchema,
      attribute: designPortableIdSchema,
      value: z.string().max(100_000).nullable(),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("node.set-html"),
      nodeId: designNodeIdSchema,
      html: z.string().max(500_000),
      mode: z.enum(["append", "replace-inner"]).default("replace-inner"),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("frame.set-geometry"),
      frame: designRelativeFileSchema,
      geometry: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
          z: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("token.set"),
      file: designRelativeFileSchema,
      name: z.string().regex(CSS_CUSTOM_PROPERTY).max(128),
      theme: z
        .string()
        .regex(/^[a-z][a-z0-9_-]{0,63}$/)
        .nullable(),
      value: styleValueSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("component.create"),
      component: designComponentDefinitionSchema,
      html: z.string().max(500_000),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("component.delete"),
      componentId: designPortableIdSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("instance.create"),
      componentId: designPortableIdSchema,
      parentNodeId: designNodeIdSchema,
      instanceNodeId: designNodeIdSchema,
      props: z
        .record(designPortableIdSchema, designParameterValueSchema)
        .default({}),
      slotHtml: z.string().max(500_000).default(""),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("parameter.create"),
      parameter: designParameterSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("parameter.delete"),
      parameterId: designPortableIdSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("parameter.set"),
      parameterId: designPortableIdSchema,
      value: designParameterValueSchema,
      variantId: designPortableIdSchema.optional(),
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("parameter.bind"),
      parameterId: designPortableIdSchema,
      binding: designParameterBindingSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("parameter.unbind"),
      parameterId: designPortableIdSchema,
      binding: designParameterBindingSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("variant.create"),
      variant: designVariantSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("variant.delete"),
      variantId: designPortableIdSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("variant.set-parameter"),
      variantId: designPortableIdSchema,
      parameterId: designPortableIdSchema,
      value: designParameterValueSchema,
    })
    .strict(),
  operationBase
    .extend({
      type: z.literal("variant.unset-parameter"),
      variantId: designPortableIdSchema,
      parameterId: designPortableIdSchema,
    })
    .strict(),
]);
export type DesignOperation = z.infer<typeof designOperationSchema>;

export const designTransactionSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_FOUNDATION_SCHEMA_VERSION),
    transactionId: designPortableIdSchema,
    documentId: designDocumentIdSchema,
    baseRevision: designRevisionSchema,
    actor: designActorSchema,
    intent: z.string().trim().min(1).max(1_000),
    createdAt: z.number().int().nonnegative(),
    coalesceKey: designPortableIdSchema.optional(),
    operations: z
      .array(designOperationSchema)
      .min(1)
      .max(DESIGN_TRANSACTION_MAX_OPERATIONS),
  })
  .strict()
  .superRefine((transaction, context) => {
    try {
      assertDesignTransactionInputSize(transaction);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message:
          error instanceof Error
            ? error.message
            : "Design transaction exceeds its input limit.",
        path: [],
      });
    }
    const operationIds = new Set<string>();
    transaction.operations.forEach((operation, index) => {
      if (operationIds.has(operation.operationId)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate operation id: ${operation.operationId}`,
          path: ["operations", index, "operationId"],
        });
      }
      operationIds.add(operation.operationId);
    });
  });
export type DesignTransaction = z.infer<typeof designTransactionSchema>;

export const designFoundationManifestSchema = z
  .object({
    schemaVersion: z.literal(DESIGN_FOUNDATION_SCHEMA_VERSION),
    parameters: z.array(designParameterSchema).max(1_024).default([]),
    variants: z.array(designVariantSchema).max(1_024).default([]),
    components: z.array(designComponentDefinitionSchema).max(1_024).default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    const checkUnique = (
      values: readonly { id: string }[],
      path: "parameters" | "variants" | "components",
    ) => {
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value.id)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${path} id: ${value.id}`,
            path: [path, index, "id"],
          });
        }
        seen.add(value.id);
      });
    };
    checkUnique(manifest.parameters, "parameters");
    checkUnique(manifest.variants, "variants");
    checkUnique(manifest.components, "components");

    const parameterById = new Map(
      manifest.parameters.map((parameter) => [parameter.id, parameter]),
    );
    manifest.parameters.forEach((parameter, index) => {
      const dependency = parameter.visibleWhen;
      if (!dependency) return;
      const referenced = parameterById.get(dependency.parameterId);
      if (!referenced) {
        context.addIssue({
          code: "custom",
          message: `visibleWhen references unknown parameter: ${dependency.parameterId}`,
          path: ["parameters", index, "visibleWhen", "parameterId"],
        });
      } else if (referenced.id === parameter.id) {
        context.addIssue({
          code: "custom",
          message: "A parameter cannot control its own visibility",
          path: ["parameters", index, "visibleWhen", "parameterId"],
        });
      } else if (
        !parameterValueMatchesType(referenced.type, dependency.equals)
      ) {
        context.addIssue({
          code: "custom",
          message: "visibleWhen value has the wrong type",
          path: ["parameters", index, "visibleWhen", "equals"],
        });
      }

      const visited = new Set<string>([parameter.id]);
      let dependencyId: string | undefined = dependency.parameterId;
      while (dependencyId) {
        if (visited.has(dependencyId)) {
          context.addIssue({
            code: "custom",
            message: `Parameter visibility cycle includes: ${parameter.id}`,
            path: ["parameters", index, "visibleWhen", "parameterId"],
          });
          break;
        }
        visited.add(dependencyId);
        dependencyId =
          parameterById.get(dependencyId)?.visibleWhen?.parameterId;
      }
    });

    const variantById = new Map(
      manifest.variants.map((variant) => [variant.id, variant]),
    );
    manifest.variants.forEach((variant, index) => {
      if (variant.baseId && !variantById.has(variant.baseId)) {
        context.addIssue({
          code: "custom",
          message: `Variant base references unknown variant: ${variant.baseId}`,
          path: ["variants", index, "baseId"],
        });
      }
      for (const [parameterId, value] of Object.entries(
        variant.parameterValues,
      )) {
        const parameter = parameterById.get(parameterId);
        if (!parameter) {
          context.addIssue({
            code: "custom",
            message: `Variant references unknown parameter: ${parameterId}`,
            path: ["variants", index, "parameterValues", parameterId],
          });
        } else if (!parameterValueSatisfiesContract(parameter, value)) {
          context.addIssue({
            code: "custom",
            message: `Variant value for ${parameterId} violates its parameter contract`,
            path: ["variants", index, "parameterValues", parameterId],
          });
        }
      }
      const visited = new Set<string>([variant.id]);
      let baseId = variant.baseId;
      while (baseId) {
        if (visited.has(baseId)) {
          context.addIssue({
            code: "custom",
            message: `Variant inheritance cycle includes: ${variant.id}`,
            path: ["variants", index, "baseId"],
          });
          break;
        }
        visited.add(baseId);
        baseId = variantById.get(baseId)?.baseId;
      }
    });

    const componentFiles = new Set<string>();
    manifest.components.forEach((component, componentIndex) => {
      if (componentFiles.has(component.file)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate component file: ${component.file}`,
          path: ["components", componentIndex, "file"],
        });
      }
      componentFiles.add(component.file);
      const propNames = new Set<string>();
      component.props.forEach((prop, propIndex) => {
        if (propNames.has(prop.name)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate component prop: ${prop.name}`,
            path: ["components", componentIndex, "props", propIndex, "name"],
          });
        }
        propNames.add(prop.name);
      });
      const slotNames = new Set<string>();
      component.slots.forEach((slot, slotIndex) => {
        if (slotNames.has(slot)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate component slot: ${slot}`,
            path: ["components", componentIndex, "slots", slotIndex],
          });
        }
        slotNames.add(slot);
      });
    });
  });
export type DesignFoundationManifest = z.infer<
  typeof designFoundationManifestSchema
>;

export const EMPTY_DESIGN_FOUNDATION_MANIFEST = Object.freeze({
  schemaVersion: DESIGN_FOUNDATION_SCHEMA_VERSION,
  parameters: Object.freeze([] as DesignParameter[]),
  variants: Object.freeze([] as DesignVariant[]),
  components: Object.freeze([] as DesignComponentDefinition[]),
});

/** Forward-only read migration. Unknown future versions fail closed. */
export function migrateDesignFoundationManifest(
  input: unknown,
): DesignFoundationManifest {
  if (input === undefined || input === null) {
    return {
      schemaVersion: DESIGN_FOUNDATION_SCHEMA_VERSION,
      parameters: [],
      variants: [],
      components: [],
    };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Design foundation manifest must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion === undefined || record.schemaVersion === 0) {
    return designFoundationManifestSchema.parse({
      schemaVersion: DESIGN_FOUNDATION_SCHEMA_VERSION,
      parameters: record.parameters ?? [],
      variants: record.variants ?? [],
      components: record.components ?? [],
    });
  }
  if (record.schemaVersion !== DESIGN_FOUNDATION_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Design Foundation schema version: ${String(record.schemaVersion)}`,
    );
  }
  return designFoundationManifestSchema.parse(record);
}
