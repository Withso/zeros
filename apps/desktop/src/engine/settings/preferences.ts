import { personalPreferencesSchema } from "@zeros/protocol/personal-preferences";
import { opSettingsRead, opSettingsWrite } from "./ops";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** A preference object is one value: removing an optional field in its UI
 * must remove the TOML override too. Other preference keys remain untouched. */
function replacementPatch(previous: unknown, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return value;
  const old = object(previous),
    next = object(value);
  return Object.fromEntries(
    [...new Set([...Object.keys(old), ...Object.keys(next)])].map((key) => [
      key,
      key in next ? replacementPatch(old[key], next[key]) : null,
    ]),
  );
}
export function syncPersonalPreferences(
  legacy: unknown,
  changes: unknown = {},
): Record<string, unknown> {
  const read = opSettingsRead("user");
  if (read.error) throw new Error(read.error);
  const current = object(read.doc.preferences);
  const patch: Record<string, unknown> = {};
  if (read.doc.preferences_version !== 1) {
    const parsed = personalPreferencesSchema.parse(legacy);
    for (const [key, value] of Object.entries(parsed))
      if (!(key in current)) patch[key] = value;
  }
  for (const [key, value] of Object.entries(object(changes))) {
    if (!Object.hasOwn(personalPreferencesSchema.shape, key))
      throw new Error(`Unknown personal preference: ${key}`);
    if (value === null) patch[key] = null;
    else {
      const parsed = personalPreferencesSchema.parse({ [key]: value });
      patch[key] = replacementPatch(current[key], object(parsed)[key]);
    }
  }
  const result =
    read.doc.preferences_version !== 1 || Object.keys(patch).length
      ? opSettingsWrite("user", { preferences_version: 1, preferences: patch })
      : read;
  return personalPreferencesSchema.parse(result.doc.preferences ?? {});
}
