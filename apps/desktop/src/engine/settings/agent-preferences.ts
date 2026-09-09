import { z } from "zod";
import { opSettingsRead, opSettingsWrite } from "./ops";
import { sanitizeLayer, userSettingsSchema } from "./schema";

const changesSchema = z
  .array(
    z
      .object({
        path: z.array(z.string().min(1).max(128)).min(2).max(3),
        value: z.unknown(),
      })
      .strict(),
  )
  .max(512);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const modelShape = userSettingsSchema.shape.models.unwrap().shape;
const providerShape =
  userSettingsSchema.shape.providers.unwrap().valueType.shape;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One synchronous read/validate/write turn per request: renderer caches cannot
 * replace unrelated fields. Legacy import runs once, beneath existing tables.
 * Unknown file text is retained by the settings writer, never round-tripped
 * through a stripped schema. Secrets never enter this operation. */
export function syncAgentPreferences(
  legacy: unknown,
  changes: unknown = [],
): {
  models: Record<string, unknown>;
  providers: Record<string, unknown>;
} {
  const read = opSettingsRead("user");
  if (read.error) throw new Error(read.error);
  const patch: Record<string, unknown> = {};
  if (read.doc.agent_preferences_version !== 1) {
    const imported = sanitizeLayer(legacy, "user").doc;
    if (!Object.hasOwn(read.doc, "models") && imported.models)
      patch.models = imported.models;
    const existing = object(read.doc.providers);
    for (const [agent, value] of Object.entries(object(imported.providers))) {
      if (!Object.hasOwn(existing, agent) && !unsafeKeys.has(agent))
        patch.providers = { ...object(patch.providers), [agent]: value };
    }
  }
  for (const change of changesSchema.parse(changes)) {
    const [table, key, leaf] = change.path;
    if (change.path.some((segment) => unsafeKeys.has(segment)))
      throw new Error("Invalid agent preference path");
    let field: z.ZodType | undefined;
    if (table === "providers" && leaf) {
      if (Object.hasOwn(providerShape, leaf))
        field = providerShape[leaf as keyof typeof providerShape];
    } else if (table === "models" && Object.hasOwn(modelShape, key)) {
      const candidate = modelShape[key as keyof typeof modelShape];
      if (!leaf) field = candidate;
      else if (key === "claude_code" || key === "codex") {
        const shape = modelShape[key].unwrap().shape;
        if (Object.hasOwn(shape, leaf))
          field = (shape as Record<string, z.ZodType>)[leaf];
      }
    }
    if (!field) throw new Error("Unsupported agent preference path");
    const value = change.value === null ? null : field.parse(change.value);
    const edit = leaf
      ? { [table]: { [key]: { [leaf]: value } } }
      : { [table]: { [key]: value } };
    // Merge patches without applying null deletions until writing the real file.
    const tablePatch = object(patch[table]);
    patch[table] = {
      ...tablePatch,
      ...object(edit[table]),
      ...(leaf ? { [key]: { ...object(tablePatch[key]), [leaf]: value } } : {}),
    };
  }
  const result =
    read.doc.agent_preferences_version !== 1 || Object.keys(patch).length
      ? opSettingsWrite("user", { ...patch, agent_preferences_version: 1 })
      : read;
  // The per-leaf sanitizer allows valid siblings of a malformed hand edit.
  const effective = sanitizeLayer(result.doc, "user").doc;
  return {
    models: object(effective.models),
    providers: object(effective.providers),
  };
}
