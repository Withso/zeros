// ──────────────────────────────────────────────────────────
// Settings foundation — TOML file layer (engine-owned)
// ──────────────────────────────────────────────────────────
//
// The only module that touches settings files on disk; renderer and web clients
// go through the bridge operations. Locations:
//
//   ~/.zeros/settings.toml              user      (dev: ~/.zeros-dev)
//   ~/.zeros/settings.managed.toml      managed
//   <repo>/.zeros/settings.toml         repo      (shared — committed)
//   <repo>/.zeros/settings.local.toml   repo-local (personal — gitignored)
//
// Writes are FORMAT-PRESERVING: editing an existing file patches the TOML in
// place (toml-patch), so a user's hand-written comments + layout survive an
// engine/UI write. Any patch failure (or a fresh file) falls back to a full
// smol-toml rewrite, so a write never throws/corrupts — it just loses comments
// for that one write. Unknown keys ALWAYS survive a read-modify-write. Writes
// are atomic (tmp + rename, same dir).
// ──────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { patch as tomlPatch } from "@decimalturn/toml-patch";
import { legacySharedStateRoot, zerosDotDirName } from "../db/paths";
import {
  SCHEMA_URL_REPO,
  SCHEMA_URL_USER,
  type RawSettingsDoc,
} from "./schema";

/** Folder name for in-repo settings — a dot-dir named after the product, the
 *  same convention every other tool in this space uses. */
export const REPO_SETTINGS_DIRNAME = ".zeros";

/** The user settings dir, PER CHANNEL: `~/.zeros` (stable) / `~/.zeros-beta` /
 *  `~/.zeros-dev`. Delegates the leaf name to db/paths.ts's zerosDotDirName() so
 *  there is exactly one implementation.
 *
 *  This used to inline a TWO-way `isDevRuntime()` split, which meant **Beta and
 *  Production shared one `settings.toml`** — changing a setting in Beta silently
 *  changed Production (and vice versa), and MCP servers registered in one appeared
 *  in the other (mcp-registry.ts reads these layers). Override with
 *  ZEROS_USER_SETTINGS_DIR (tests, cloud sandboxes). */
export function userSettingsDir(): string {
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

/** Settings files the one-time seed below is allowed to carry across. */
const SEEDABLE_SETTINGS_FILES = [
  "settings.toml",
  "settings.managed.toml",
] as const;

/** One-time seed of the user settings files from the pre-split shared `~/.zeros`.
 *
 *  WHY THIS EXISTS. Before the 3-way dot-dir split, `userSettingsDir()` was a
 *  TWO-way `isDevRuntime()` decision, so **Beta wrote its settings into
 *  Production's `~/.zeros`**. Splitting the dirs is correct, but doing it bare
 *  would silently reset every existing Beta user to default settings on upgrade —
 *  a regression introduced BY the fix. This copies their settings across once.
 *
 *  Deliberately narrow — ONLY the two settings files. The rest of the dot-dir is
 *  explicitly NOT copied because it references state that belongs to the other
 *  channel and would actively corrupt:
 *    • `state.db` / `worktrees/` — rows and paths pointing at the OTHER channel's
 *      workspaces root (`~/zeros/workspaces` vs `~/zeros-beta/workspaces`).
 *    • `detach.lock` — a live pid/workspace lock; copying it fabricates a held lock.
 *    • `term-zdotdir/`, `agent-auth/` — generated; they regenerate correctly.
 *
 *  Idempotent and non-destructive: it never overwrites an existing file, so once
 *  a channel has its own settings this is a no-op. No marker file needed — the
 *  presence of the destination IS the marker. Uniform across channels (no
 *  dev-vs-packaged branch), so it cannot become another flavour divergence.
 *
 *  Best-effort by design: settings are a convenience, and a failure here must
 *  never block engine boot. */
export function seedUserSettingsFromLegacyRoot(
  /** Test-only path injection. Production passes nothing and resolves both from
   *  the real channel. Injected explicitly (rather than driven through
   *  ZEROS_USER_SETTINGS_DIR) because that env var makes the function SHORT-CIRCUIT
   *  by design — so a test using it can only ever reach the early return, and the
   *  copy itself, which is the entire point of this function, would have no
   *  coverage at all. */
  opts: { dest?: string; legacy?: string } = {},
): void {
  const injected = opts.dest !== undefined || opts.legacy !== undefined;
  const dest = opts.dest ?? userSettingsDir();
  const legacy = opts.legacy ?? legacySharedStateRoot();
  // Stable already IS the legacy root — nothing to inherit from itself.
  if (path.resolve(dest) === path.resolve(legacy)) return;
  // An explicit env override means the caller owns the location (cloud sandboxes)
  // and must not inherit anything. Skipped when paths are injected, since the test
  // is then driving dest/legacy directly.
  if (!injected && process.env.ZEROS_USER_SETTINGS_DIR) return;

  for (const name of SEEDABLE_SETTINGS_FILES) {
    const to = path.join(dest, name);
    const from = path.join(legacy, name);
    try {
      if (existsSync(to)) continue; // this channel already has its own — leave it
      if (!existsSync(from)) continue;
      mkdirSync(dest, { recursive: true });
      // copyFileSync with COPYFILE_EXCL so a concurrent engine boot can't have
      // two writers race into a truncated file.
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      console.log(
        `[Zeros] seeded ${name} from the pre-split ${legacy} into ${dest} (one-time)`,
      );
    } catch {
      /* already created by a racing boot, or unreadable — settings fall back to
         defaults, which is survivable. Never block boot for this. */
    }
  }
}

export interface ReadSettingsResult {
  /** Parsed document; `{}` when the file is missing or unreadable. */
  doc: RawSettingsDoc;
  exists: boolean;
  /** Parse/read failure, when the file exists but couldn't be used. */
  error?: string;
  /** The raw file text (BOM-stripped) on a successful read. Lets
   *  updateSettingsFile patch the existing TOML in place (comment-preserving). */
  text?: string;
}

/** Read + parse one settings file. Never throws: missing → empty doc; a
 *  malformed file reports `error` and an empty doc so resolution stays alive
 *  (the resolver then simply skips this layer). */
export function readSettingsFile(filePath: string): ReadSettingsResult {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Missing, or a path component that isn't a dir → treat as absent (a write
    // will create it). EISDIR (the path is a directory) is a real misconfig:
    // surface it clearly instead of the opaque "malformed TOML".
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
  // Strip a UTF-8 BOM (some Windows editors add one) — smol-toml otherwise
  // rejects the whole file as malformed.
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

/** Serialize the ordered doc to TOML text. When the file's existing text is
 *  known, toml-patch edits it IN PLACE so comments + formatting survive; any
 *  failure (or a fresh file) falls back to a full smol-toml rewrite — so a write
 *  is comment-preserving when it can be, and never throws/corrupts otherwise. */
function serializeSettings(
  ordered: RawSettingsDoc,
  existingText?: string,
): string {
  if (existingText && existingText.trim().length > 0) {
    try {
      const patched = tomlPatch(existingText, ordered);
      // toml-patch can return syntactically invalid TOML WITHOUT throwing; round-
      // trip it so a bad patch falls through to the full rewrite, never to disk.
      parseToml(patched);
      return patched;
    } catch {
      /* exotic existing formatting / CST edge — fall back to a full rewrite
         (loses comments for this one write, never the data). */
    }
  }
  return stringifyToml(ordered);
}

/** Strip `undefined` values (smol-toml rejects them) without touching others. */
function prune(value: unknown): unknown {
  if (Array.isArray(value))
    return value.filter((v) => v !== undefined).map(prune);
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

export interface WriteSettingsOptions {
  /** `$schema` URL injected when the document doesn't carry one.
   *  Pass `null` to skip injection (managed/local files). */
  schemaUrl?: string | null;
  /** The file's CURRENT text, if known. When present + non-empty the write is
   *  format-preserving (toml-patch edits it in place, keeping comments); a fresh
   *  write (omitted/empty) is serialized by smol-toml. */
  existingText?: string;
}

/** Serialize + atomically write one settings document (tmp + rename in the
 *  same directory; parent dirs created). `$schema` is kept as the first key. */
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
  const text = `${serializeSettings(ordered, existingText)}\n`;
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort tmp cleanup */
    }
    throw err;
  }
}

/** Atomically write VERBATIM text to a settings file (tmp + rename, parent dirs
 *  created). The raw "Edit settings.toml" editor uses this — the bytes are the
 *  user's exact text, so comments + layout are preserved trivially. The caller
 *  MUST validate it parses as TOML first (see opSettingsWriteRaw). */
export function writeSettingsFileRaw(filePath: string, text: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* best-effort tmp cleanup */
    }
    throw err;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys that could poison Object.prototype via a parsed (null-proto) TOML doc. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep-merge `patch` into `doc` with delete semantics: a `null` leaf in the
 *  patch removes that key; tables merge per key; scalars/arrays replace.
 *  Returns a new document (inputs untouched). This is the bridge write-op
 *  contract. */
export function applySettingsPatch(
  doc: RawSettingsDoc,
  patch: RawSettingsDoc,
): RawSettingsDoc {
  const out: RawSettingsDoc = { ...doc };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (DANGEROUS_KEYS.has(key)) continue; // prototype-pollution guard
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

/** Read-modify-write one settings file with patch semantics. Unknown keys in
 *  the existing file survive. Refuses to clobber a malformed file (a parse
 *  error would silently discard whatever the user had) — throws instead. */
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
  // Pass the existing text so the write patches it in place (comments survive).
  writeSettingsFile(filePath, next, { ...opts, existingText: current.text });
  return next;
}

/** Default `$schema` URL for a layer's file. */
export function schemaUrlForLayer(layer: "user" | "repo"): string {
  return layer === "user" ? SCHEMA_URL_USER : SCHEMA_URL_REPO;
}
