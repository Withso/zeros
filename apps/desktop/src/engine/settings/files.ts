
import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { patch as tomlPatch } from "@decimalturn/toml-patch";
import { legacySharedStateRoot, zerosDotDirName, zerosStateRoot } from "../db/paths";
import { isLocalDevelopmentRuntime } from "../runtime";
import { readBoundedUtf8FileSync } from "../files/bounded-read-sync";
import {
  SCHEMA_URL_REPO,
  SCHEMA_URL_USER,
  type RawSettingsDoc,
} from "./schema";

export const REPO_SETTINGS_DIRNAME = ".zeros";

/** Settings follow the release channel so Alpha edits do not affect Production. */
export function userSettingsDir(): string {
  if (isLocalDevelopmentRuntime()) return zerosStateRoot();
  if (process.env.ZEROS_USER_SETTINGS_DIR)
    return process.env.ZEROS_USER_SETTINGS_DIR;
  return path.join(homedir(), zerosDotDirName());
}

export function userSettingsPath(): string {
  return path.join(userSettingsDir(), "settings.toml");
}

export function managedSettingsPath(): string {
  return path.join(userSettingsDir(), "settings.managed.toml");
}

export function repoSettingsPath(repoRoot: string): string {
  return path.join(repoRoot, REPO_SETTINGS_DIRNAME, "settings.toml");
}

export function repoLocalSettingsPath(repoRoot: string): string {
  return path.join(repoRoot, REPO_SETTINGS_DIRNAME, "settings.local.toml");
}

const SEEDABLE_SETTINGS_FILES = [
  "settings.toml",
  "settings.managed.toml",
] as const;

/** Seed the two legacy settings files without copying channel-owned workspace state or live locks. */
export function seedUserSettingsFromLegacyRoot(
  /** Inject paths in tests: the environment override opts out of seeding. */
  opts: { dest?: string; legacy?: string } = {},
): void {
  const injected = opts.dest !== undefined || opts.legacy !== undefined;
  if (!injected && isLocalDevelopmentRuntime()) return;
  const dest = opts.dest ?? userSettingsDir();
  const legacy = opts.legacy ?? legacySharedStateRoot();
  if (path.resolve(dest) === path.resolve(legacy)) return;
  // Caller-owned settings roots, such as sandbox overrides, must not inherit host settings.
  if (!injected && process.env.ZEROS_USER_SETTINGS_DIR) return;

  for (const name of SEEDABLE_SETTINGS_FILES) {
    const to = path.join(dest, name);
    const from = path.join(legacy, name);
    try {
      if (existsSync(to)) continue;
      if (!existsSync(from)) continue;
      mkdirSync(dest, { recursive: true });
      // Exclusive copy prevents a concurrent boot from overwriting the first seed.
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      console.log(
        `[Zeros] seeded ${name} from the pre-split ${legacy} into ${dest} (one-time)`,
      );
    } catch {
      // Seeding is best effort; an inaccessible or concurrently created file must not block boot.
    }
  }
}

export interface ReadSettingsResult {
  doc: RawSettingsDoc;
  exists: boolean;
  error?: string;
  /** BOM-stripped source for format-preserving patches. */
  text?: string;
}

export function readSettingsFile(filePath: string): ReadSettingsResult {
  let text: string;
  try {
    text = readBoundedUtf8FileSync(filePath, 4 * 1024 * 1024, { noFollow: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR")
      return { doc: {}, exists: false };
    if (code === "EISDIR") {
      return {
        doc: {},
        exists: true,
        error: `${filePath} is a directory, not a settings file`,
      };
    }
    return {
      doc: {},
      exists: true,
      error: String((err as Error).message ?? err),
    };
  }
  // Strip a Windows editor BOM before smol-toml parses the file.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { doc: parseToml(text) as RawSettingsDoc, exists: true, text };
  } catch (err) {
    return {
      doc: {},
      exists: true,
      error: String((err as Error).message ?? err),
    };
  }
}

function serializeSettings(
  ordered: RawSettingsDoc,
  existingText?: string,
): string {
  if (existingText && existingText.trim().length > 0) {
    try {
      const patched = tomlPatch(existingText, ordered);
      // toml-patch can return malformed or incomplete TOML without throwing; verify the parsed result before writing.
      const parsed = parseToml(patched);
      if (!settingsValuesEqual(parsed, ordered)) {
        throw new Error("TOML patch did not preserve the requested document");
      }
      return patched;
    } catch {
      // Fall back to serialization if a format-preserving patch cannot preserve the requested values.
    }
  }
  return stringifyToml(ordered);
}

/** Compare TOML values rather than parser representations, including table prototypes, dates and signed zero. */
function settingsValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "number" && typeof right === "number") {
    return left === right;
  }
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date &&
      right instanceof Date &&
      left.toISOString() === right.toISOString()
    );
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => settingsValuesEqual(value, right[index]))
    );
  }
  if (
    typeof left !== "object" ||
    left === null ||
    typeof right !== "object" ||
    right === null
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        settingsValuesEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

/** smol-toml rejects undefined values. */
function prune(value: unknown): unknown {
  if (Array.isArray(value))
    return value.filter((v) => v !== undefined).map(prune);
  if (value instanceof Date) return value;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      out[k] = prune(v);
    }
    return out;
  }
  return value;
}

/** Normalize the final line break so repeated patches do not grow trailing blank lines. */
function withFinalNewline(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return `${text.slice(0, end)}${text.includes("\r\n") ? "\r\n" : "\n"}`;
}

export interface WriteSettingsOptions {
  /** Pass null to omit the default schema URL without removing an existing one. */
  schemaUrl?: string | null;
  existingText?: string;
}

export function writeSettingsFile(
  filePath: string,
  doc: RawSettingsDoc,
  opts: WriteSettingsOptions = {},
): void {
  const { schemaUrl, existingText } = opts;
  const pruned = prune(doc) as RawSettingsDoc;
  const ordered: RawSettingsDoc = {};
  const schema = pruned.$schema ?? (schemaUrl === null ? undefined : schemaUrl);
  if (schema !== undefined) ordered.$schema = schema;
  for (const [k, v] of Object.entries(pruned)) {
    if (k === "$schema") continue;
    ordered[k] = v;
  }
  const text = withFinalNewline(serializeSettings(ordered, existingText));
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}

/** The raw write bypasses serialization; the caller must validate the TOML. */
export function writeSettingsFileRaw(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    throw err;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys that could poison Object.prototype via a parsed (null-proto) TOML doc. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Bridge patches merge tables, replace arrays and scalars, and use null to delete keys. */
export function applySettingsPatch(
  doc: RawSettingsDoc,
  patch: RawSettingsDoc,
): RawSettingsDoc {
  const out: RawSettingsDoc = { ...doc };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (DANGEROUS_KEYS.has(key)) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    if (isPlainObject(value)) {
      const existing = isPlainObject(out[key])
        ? (out[key] as RawSettingsDoc)
        : {};
      const merged = applySettingsPatch(existing, value);
      if (Object.keys(merged).length === 0) delete out[key];
      else out[key] = merged;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Refuse malformed existing TOML so a patch cannot silently discard the user's document. */
export function updateSettingsFile(
  filePath: string,
  patch: RawSettingsDoc,
  opts: WriteSettingsOptions = {},
): RawSettingsDoc {
  const current = readSettingsFile(filePath);
  if (current.error) {
    throw new Error(
      `refusing to overwrite malformed settings file ${filePath}: ${current.error}`,
    );
  }
  const next = applySettingsPatch(current.doc, patch);
  writeSettingsFile(filePath, next, { ...opts, existingText: current.text });
  return next;
}

export function schemaUrlForLayer(layer: "user" | "repo"): string {
  return layer === "user" ? SCHEMA_URL_USER : SCHEMA_URL_REPO;
}
