import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { DESIGN_DIRECTORY_ID_PATTERN } from "./directory-path";

export const DESIGN_MANIFEST_FILE = "design.toml";
export const DESIGN_MANIFEST_FORMAT = "zeros-design";
export const designManifestSchema = z
  .object({
    format: z.literal(DESIGN_MANIFEST_FORMAT),
    version: z.literal(1),
    id: z.string().regex(DESIGN_DIRECTORY_ID_PATTERN),
    nulls: z.array(z.string()).optional(),
    document: z.record(z.string(), z.unknown()),
  })
  .strict();

const escapePointer = (key: string) =>
  key.replace(/~/g, "~0").replace(/\//g, "~1");

function mapJson(
  value: unknown,
  visitNull: (pointer: string) => unknown,
  pointer = "",
  depth = 0,
): unknown {
  if (depth > 100) throw new Error("Design metadata is too deeply nested.");
  if (value === null) return visitNull(pointer);
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value))
    return value.map((item, index) =>
      mapJson(item, visitNull, `${pointer}/${index}`, depth + 1),
    );
  if (
    value &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapJson(item, visitNull, `${pointer}/${escapePointer(key)}`, depth + 1),
      ]),
    );
  }
  throw new Error("Design metadata must contain JSON values.");
}

/** TOML has no null. An explicit list of JSON pointers preserves nulls without
 * reserving any document keys or hiding the whole document in a JSON string. */
export function serializeDesignManifest(
  id: string,
  document: Record<string, unknown>,
): string {
  const nulls: string[] = [];
  const encoded = mapJson(document, (pointer) => {
    nulls.push(pointer);
    return "";
  });
  const envelope = designManifestSchema.parse({
    format: DESIGN_MANIFEST_FORMAT,
    version: 1,
    id,
    ...(nulls.length ? { nulls } : {}),
    document: encoded,
  });
  const source = stringify(envelope) + "\n";
  if (Buffer.byteLength(source) > 16 * 1024 * 1024)
    throw new Error("Design metadata exceeds its size limit.");
  return source;
}

/** A filename alone never claims a folder. A damaged Zeros manifest fails
 * closed; unrelated TOML belongs to the repository and is left alone. */
export function parseDesignManifest(
  source: string,
): { id: string; document: Record<string, unknown> } | null {
  if (Buffer.byteLength(source) > 16 * 1024 * 1024)
    throw new Error("Design manifest is too large.");
  let raw: Record<string, unknown>;
  try {
    raw = parse(source);
  } catch (error) {
    if (/zeros-design/.test(source)) throw error;
    return null;
  }
  if (raw.format !== DESIGN_MANIFEST_FORMAT) return null;
  const envelope = designManifestSchema.parse(raw);
  const document = mapJson(envelope.document, () => {
    throw new Error("Invalid TOML null.");
  }) as Record<string, unknown>;
  const pointers = envelope.nulls ?? [];
  if (new Set(pointers).size !== pointers.length)
    throw new Error("Duplicate Design null pointer.");
  for (const pointer of pointers) {
    if (!pointer.startsWith("/") || /~(?![01])/u.test(pointer))
      throw new Error("Invalid Design null pointer.");
    const keys = pointer
      .slice(1)
      .split("/")
      .map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"));
    let parent: unknown = document;
    for (const key of keys.slice(0, -1)) {
      if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key))
        throw new Error("Invalid Design null pointer.");
      parent = (parent as Record<string, unknown>)[key];
    }
    const key = keys.at(-1)!;
    if (
      !parent ||
      typeof parent !== "object" ||
      !Object.hasOwn(parent, key) ||
      (parent as Record<string, unknown>)[key] !== ""
    )
      throw new Error("Invalid Design null pointer.");
    Object.defineProperty(parent, key, {
      value: null,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { id: envelope.id, document };
}
