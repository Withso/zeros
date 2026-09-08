// ──────────────────────────────────────────────────────────
// Settings foundation — bridge operation implementations
// ──────────────────────────────────────────────────────────
//
// The engine-side handlers behind the workspace-service ops:
//
//   settings.resolve { repoRoot? }                 → effective + provenance
//   settings.read    { layer, repoRoot? }          → one raw layer document
//   settings.write   { layer, repoRoot?, patch }   → patch one layer file
//   settings.migrateLegacy { repos, providers }    → one-time localStorage import
//
// Remote policy: resolve/read/write are all open to paired
// devices (a paired device already holds PTY = arbitrary file edits; the
// gate is the service allowlist + isKnownRepoRoot, enforced in service.ts).
// Env values with secret-shaped NAMES are masked on remote reads as a
// defensive courtesy, and a write refusing the mask sentinel keeps a remote
// client from accidentally persisting the mask over a real value.
// ──────────────────────────────────────────────────────────

import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isSecretEnvName } from "./env-names";
import {
  applySettingsPatch,
  managedSettingsPath,
  readSettingsFile,
  repoLocalSettingsPath,
  updateSettingsFile,
  writeSettingsFileRaw,
  userSettingsPath,
  type ReadSettingsResult,
} from "./files";
import { resolveSettings, type ResolvedSettings } from "./resolve";
import { getTeamDoc } from "./team-context";
import {
  ensureLocalSettingsIgnored,
  personalRepoRoot,
  personalWorkspaceRoot,
  workspaceSettingsPath,
  readPersonalRepoSettings,
  readPersonalWorkspaceSettings,
  PERSONAL_SETTINGS_VERSION,
} from "./personal-repo";
export { ensureLocalSettingsIgnored } from "./personal-repo";
import {
  sanitizeLayer,
  SCHEMA_URL_REPO,
  SCHEMA_URL_WORKSPACE,
  SCHEMA_URL_USER,
  type RawSettingsDoc,
} from "./schema";

/** Layers addressable over the bridge. `managed` is read-only by design —
 *  admin policy is provisioned out-of-band, never written by the app. */
export const READABLE_LAYERS = [
  "user",
  "managed",
  "repo",
  "repo-local",
  "workspace-local",
] as const;
export const WRITABLE_LAYERS = [
  "user",
  "repo",
  "repo-local",
  "workspace-local",
] as const;
export type ReadableLayer = (typeof READABLE_LAYERS)[number];
export type WritableLayer = (typeof WRITABLE_LAYERS)[number];

/** Mask shown to REMOTE clients in place of a secret-shaped env value. */
export const REDACTED_SENTINEL = "<redacted>";

export type SettingsOpErrorCode =
  | "SETTINGS_BAD_PATCH"
  | "SETTINGS_BAD_TOML"
  | "SETTINGS_REPO_REQUIRED"
  | "SETTINGS_REDACTED_VALUE";

export class SettingsOpError extends Error {
  readonly code: SettingsOpErrorCode;
  constructor(code: SettingsOpErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function layerPath(layer: ReadableLayer, repoRoot?: string): string {
  switch (layer) {
    case "user":
      return userSettingsPath();
    case "managed":
      return managedSettingsPath();
    case "repo":
    case "repo-local":
    case "workspace-local": {
      if (!repoRoot) {
        throw new SettingsOpError(
          "SETTINGS_REPO_REQUIRED",
          `settings layer '${layer}' requires a repoRoot`,
        );
      }
      return layer === "workspace-local"
        ? workspaceSettingsPath(repoRoot)
        : repoLocalSettingsPath(personalRepoRoot(repoRoot));
    }
  }
}

export interface SettingsReadOpResult extends ReadSettingsResult {
  layer: ReadableLayer;
  path: string;
}

export function opSettingsRead(
  layer: ReadableLayer,
  repoRoot?: string,
): SettingsReadOpResult {
  const filePath = layerPath(layer, repoRoot);
  const read =
    repoRoot && layer !== "user" && layer !== "managed"
      ? readLocalLayer(layer, repoRoot)
      : readSettingsFile(filePath);
  return { layer, path: filePath, ...read };
}

function readLocalLayer(
  layer: ReadableLayer,
  root: string,
  persist = true,
): ReadSettingsResult {
  return layer === "workspace-local"
    ? readPersonalWorkspaceSettings(root, persist)
    : readPersonalRepoSettings(root, persist);
}

export function opSettingsResolve(
  repoRoot?: string,
  mainRepoRoot?: string,
): ResolvedSettings {
  const user = readSettingsFile(userSettingsPath());
  const managed = readSettingsFile(managedSettingsPath());
  const repoLocalRoot = mainRepoRoot ?? repoRoot;
  const repoLocal = repoLocalRoot
    ? readPersonalRepoSettings(repoLocalRoot)
    : undefined;
  const workspaceLocal =
    repoRoot &&
    repoLocalRoot &&
    personalWorkspaceRoot(repoRoot) !== personalRepoRoot(repoLocalRoot)
      ? readPersonalWorkspaceSettings(repoRoot)
      : undefined;
  const resolved = resolveSettings({
    user: user.error ? null : user.doc,
    team: getTeamDoc(),
    managed: managed.error ? null : managed.doc,
    repoLocal: repoLocal?.error ? null : repoLocal?.doc,
    workspaceLocal: workspaceLocal?.error ? null : workspaceLocal?.doc,
  });
  if (
    repoRoot &&
    workspaceLocal &&
    workspaceSettingsPath(repoRoot) ===
      repoLocalSettingsPath(personalWorkspaceRoot(repoRoot))
  ) {
    resolved.warnings.push(
      "This branch tracks .zeros/settings.toml. Private workspace overrides use .zeros/settings.local.toml until that legacy tracked file is removed.",
    );
  }
  if (Array.isArray(repoLocal?.doc.settings_migration_notes))
    resolved.warnings.push(
      ...repoLocal.doc.settings_migration_notes.filter(
        (note): note is string => typeof note === "string",
      ),
    );
  // A malformed layer is skipped, not fatal — surface it so the UI can say so.
  for (const [name, r] of [
    ["user", user],
    ["managed", managed],
    ["repo-local", repoLocal],
    ["workspace-local", workspaceLocal],
  ] as const) {
    if (r?.error)
      resolved.warnings.push(
        `${name}: file is malformed and was ignored (${r.error})`,
      );
  }
  return resolved;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** True when any leaf of `value` is the redaction sentinel — a remote client
 *  echoing a masked read back as a write. */
function containsRedactedSentinel(value: unknown): boolean {
  if (value === REDACTED_SENTINEL) return true;
  if (Array.isArray(value)) return value.some(containsRedactedSentinel);
  if (isPlainObject(value))
    return Object.values(value).some(containsRedactedSentinel);
  return false;
}

/** Mask env values whose NAME is secret-shaped before a doc leaves for a
 *  relay client. Names stay visible (the UI shows which vars exist). */
function redactEnvTable(env: unknown): unknown {
  if (!isPlainObject(env)) return env;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(env)) {
    // Mask whenever the NAME is secret-shaped, regardless of value type — a
    // secret stored as a TOML integer/array must not slip through.
    out[name] = isSecretEnvName(name) ? REDACTED_SENTINEL : value;
  }
  return out;
}

/** Mask EVERY value in an MCP server's `env`/`headers` before a doc leaves for a
 *  relay client. Unlike the top-level `[env]` table (name-based masking), every
 *  MCP header/env value is masked unconditionally: any of them can be a real
 *  credential (e.g. an `auth="none"` server's `Authorization: Bearer …`), and a
 *  paired-but-untrusted device must never read it. Names stay visible. The
 *  gateway-brokered (`auth="oauth"|"header"`) secrets already live engine-only,
 *  so masking the residual plain values here is purely additive safety. */
function redactMcpTable(mcp: unknown): unknown {
  if (
    !isPlainObject(mcp) ||
    !Array.isArray((mcp as { servers?: unknown }).servers)
  )
    return mcp;
  const servers = (mcp as { servers: unknown[] }).servers.map((s) => {
    if (!isPlainObject(s)) return s;
    const out: Record<string, unknown> = { ...s };
    for (const field of ["env", "headers"] as const) {
      const tbl = (s as Record<string, unknown>)[field];
      if (isPlainObject(tbl)) {
        out[field] = Object.fromEntries(
          Object.keys(tbl).map((k) => [k, REDACTED_SENTINEL]),
        );
      }
    }
    return out;
  });
  return { ...(mcp as Record<string, unknown>), servers };
}

export function redactDocForRemote(doc: RawSettingsDoc): RawSettingsDoc {
  let out: RawSettingsDoc = doc;
  if (doc.preferences !== undefined || doc.preferences_version !== undefined) {
    out = { ...out };
    delete out.preferences;
    delete out.preferences_version;
  }
  if (isPlainObject(doc.env))
    out = { ...out, env: redactEnvTable(doc.env) as RawSettingsDoc };
  if (doc.mcp !== undefined)
    out = { ...out, mcp: redactMcpTable(doc.mcp) } as RawSettingsDoc;
  return out;
}

/** Secret-shaped env NAMES present in a write patch's `env` table — the
 *  symmetric half of read masking, for the REMOTE write gate. Reads already
 *  mask these and the spawn path strips them, but refusing the write keeps the
 *  on-disk file clean and tells the client why, instead of persisting a value
 *  that would be silently dropped at spawn. Empty for a local (desktop) write. */
export function secretEnvNamesInPatch(patch: unknown): string[] {
  if (!isPlainObject(patch) || !isPlainObject(patch.env)) return [];
  return Object.keys(patch.env).filter(isSecretEnvName);
}

export function redactResolvedForRemote(
  resolved: ResolvedSettings,
): ResolvedSettings {
  return {
    ...resolved,
    effective: redactDocForRemote(resolved.effective),
    sources: Object.fromEntries(
      Object.entries(resolved.sources).filter(
        ([key]) =>
          key !== "preferences_version" &&
          key !== "preferences" &&
          !key.startsWith("preferences."),
      ),
    ),
  };
}

export interface SettingsWriteOpResult {
  layer: WritableLayer;
  path: string;
  doc: RawSettingsDoc;
  /** Advisory schema warnings about the document AFTER the patch (the write
   *  itself is never rejected for unknown/invalid keys — forward compat). */
  warnings: string[];
}

export interface SettingsWritePreview extends SettingsWriteOpResult {
  /** Canonical file that would be replaced. Used only to project the resulting
   * effective settings before a privileged pointer transition is committed. */
  path: string;
}

function prepareSettingsWrite(
  layer: WritableLayer,
  patch: RawSettingsDoc,
  repoRoot?: string,
): SettingsWritePreview {
  if (!isPlainObject(patch)) {
    throw new SettingsOpError(
      "SETTINGS_BAD_PATCH",
      "settings.write requires a patch object",
    );
  }
  if (containsRedactedSentinel(patch)) {
    throw new SettingsOpError(
      "SETTINGS_REDACTED_VALUE",
      `a patch may not contain the literal ${REDACTED_SENTINEL} mask — set a real value instead`,
    );
  }
  const filePath = layerPath(layer, repoRoot);
  const current =
    repoRoot && layer !== "user"
      ? readLocalLayer(layer, repoRoot, false)
      : readSettingsFile(filePath);
  if (current.error) {
    throw new Error(
      `refusing to overwrite malformed settings file ${filePath}: ${current.error}`,
    );
  }
  const doc = applySettingsPatch(current.doc, patch);
  const { warnings } = sanitizeLayer(
    doc,
    layer === "repo" ? "repo-local" : layer,
  );
  return { layer, path: filePath, doc, warnings };
}

/** Side-effect-free projection of settings.write. Privileged settings that
 * select an engine-owned filesystem territory use this to validate every
 * resulting effective pointer before touching the settings file. */
export function opSettingsPreviewWrite(
  layer: WritableLayer,
  patch: RawSettingsDoc,
  repoRoot?: string,
): SettingsWritePreview {
  return prepareSettingsWrite(layer, patch, repoRoot);
}

/** Resolve a checkout exactly as opSettingsResolve would, replacing one layer
 * by a preview document when that layer's physical file matches `override`.
 * Worktrees resolve to the main checkout's personal file, just as real reads
 * and writes do. Previewing never persists a migration. */
export function opSettingsResolveWithOverride(
  repoRoot: string | undefined,
  mainRepoRoot: string | undefined,
  override: Pick<SettingsWritePreview, "path" | "doc">,
): ResolvedSettings {
  const overridePath = path.resolve(override.path);
  const read = (filePath: string): ReadSettingsResult =>
    path.resolve(filePath) === overridePath
      ? { doc: override.doc, exists: true }
      : readSettingsFile(filePath);
  const user = read(userSettingsPath());
  const managed = read(managedSettingsPath());
  const repoLocalRoot = mainRepoRoot ?? repoRoot;
  const repoLocal = repoLocalRoot
    ? path.resolve(repoLocalSettingsPath(personalRepoRoot(repoLocalRoot))) ===
      overridePath
      ? { doc: override.doc, exists: true }
      : readPersonalRepoSettings(repoLocalRoot, false)
    : undefined;
  const workspaceLocal =
    repoRoot &&
    repoLocalRoot &&
    personalWorkspaceRoot(repoRoot) !== personalRepoRoot(repoLocalRoot)
      ? path.resolve(workspaceSettingsPath(repoRoot)) === overridePath
        ? { doc: override.doc, exists: true }
        : readPersonalWorkspaceSettings(repoRoot, false)
      : undefined;
  const resolved = resolveSettings({
    user: user.error ? null : user.doc,
    team: getTeamDoc(),
    managed: managed.error ? null : managed.doc,
    repoLocal: repoLocal?.error ? null : repoLocal?.doc,
    workspaceLocal: workspaceLocal?.error ? null : workspaceLocal?.doc,
  });
  for (const [name, result] of [
    ["user", user],
    ["managed", managed],
    ["repo-local", repoLocal],
    ["workspace-local", workspaceLocal],
  ] as const) {
    if (result?.error) {
      resolved.warnings.push(
        `${name}: file is malformed and was ignored (${result.error})`,
      );
    }
  }
  return resolved;
}

export function opSettingsWrite(
  layer: WritableLayer,
  patch: RawSettingsDoc,
  repoRoot?: string,
): SettingsWriteOpResult {
  const prepared = prepareSettingsWrite(layer, patch, repoRoot);
  const filePath = prepared.path;
  const schemaUrl =
    layer === "user"
      ? SCHEMA_URL_USER
      : layer === "workspace-local" &&
          repoRoot &&
          personalWorkspaceRoot(repoRoot) !== personalRepoRoot(repoRoot)
        ? SCHEMA_URL_WORKSPACE
        : SCHEMA_URL_REPO;
  if (repoRoot && layer !== "user") {
    ensureLocalSettingsIgnored(
      path.dirname(path.dirname(filePath)),
      `.zeros/${path.basename(filePath)}` as
        | ".zeros/settings.local.toml"
        | ".zeros/settings.toml",
    );
    const migrated = readLocalLayer(layer, repoRoot);
    if (migrated.error) throw new Error(migrated.error);
    patch = { ...patch, settings_version: PERSONAL_SETTINGS_VERSION };
  }
  // Re-run the format-preserving read/patch/write at the commit point. The
  // preview above is validation only; updateSettingsFile remains the atomic
  // source of truth and refuses a concurrently malformed file.
  const doc = updateSettingsFile(filePath, patch, { schemaUrl });
  const { warnings } = sanitizeLayer(
    doc,
    layer === "repo" ? "repo-local" : layer,
  );
  return { layer, path: filePath, doc, warnings };
}

/** Write a RAW TOML document for the "Edit settings.toml" editor: the verbatim
 *  text (comments + layout kept intact), AFTER validating it parses. Rejects
 *  garbage — writing unparseable TOML would make the file malformed and block
 *  every future patch (updateSettingsFile refuses a malformed file). */
export function opSettingsWriteRaw(
  layer: WritableLayer,
  text: string,
  repoRoot?: string,
): SettingsWriteOpResult {
  if (typeof text !== "string") {
    throw new SettingsOpError(
      "SETTINGS_BAD_PATCH",
      "settings.writeRaw requires a text string",
    );
  }
  let doc: RawSettingsDoc;
  try {
    doc = parseToml(text) as RawSettingsDoc;
  } catch (err) {
    throw new SettingsOpError(
      "SETTINGS_BAD_TOML",
      `invalid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const filePath = layerPath(layer, repoRoot);
  if (repoRoot && layer !== "user") {
    ensureLocalSettingsIgnored(
      path.dirname(path.dirname(filePath)),
      `.zeros/${path.basename(filePath)}` as
        | ".zeros/settings.local.toml"
        | ".zeros/settings.toml",
    );
    const migrated = readLocalLayer(layer, repoRoot);
    if (migrated.error) throw new Error(migrated.error);
    if (doc.settings_version !== PERSONAL_SETTINGS_VERSION) {
      if (doc.settings_version !== undefined)
        throw new Error("Unsupported settings_version in repository settings.");
      text = `settings_version = ${PERSONAL_SETTINGS_VERSION}\n${text}`;
      doc.settings_version = PERSONAL_SETTINGS_VERSION;
    }
  }
  writeSettingsFileRaw(filePath, text);
  const { warnings } = sanitizeLayer(
    doc,
    layer === "repo" ? "repo-local" : layer,
  );
  return { layer, path: filePath, doc, warnings };
}

// ── one-time legacy migration (localStorage → TOML) ────────

interface LegacyRepoScript {
  name?: string;
  command?: string;
  runOnCreate?: boolean;
}
interface LegacyRepoSettings {
  workspacesPath?: string;
  remoteOrigin?: string;
  baseBranch?: string;
  scripts?: LegacyRepoScript[];
}
interface LegacyProviderPrefs {
  authMethod?: string;
  binaryPath?: string;
  gatewayBaseUrl?: string;
}

export interface MigrateLegacyInput {
  repos?: Array<{ repoRoot?: string; settings?: LegacyRepoSettings }>;
  providers?: Record<string, LegacyProviderPrefs>;
}

export interface MigrateLegacyResult {
  migratedRepos: string[];
  migratedProviders: string[];
  warnings: string[];
}

/** Import the renderer's legacy localStorage blobs into TOML — once.
 *  Merge-under semantics: a key already present in the target file wins
 *  (re-running can never clobber what a user has since hand-edited).
 *  runOnCreate scripts join into `scripts.setup` with `&&`; the
 *  first non-runOnCreate script becomes `scripts.run`; leftovers are
 *  reported, not silently dropped. LOCAL-ONLY op. */
export function opSettingsMigrateLegacy(
  input: MigrateLegacyInput,
): MigrateLegacyResult {
  const warnings: string[] = [];
  const migratedRepos: string[] = [];
  const migratedProviders: string[] = [];

  for (const entry of input.repos ?? []) {
    const repoRoot = entry?.repoRoot;
    const legacy = entry?.settings;
    if (!repoRoot || !isPlainObject(legacy)) continue;
    if (!existsSync(repoRoot)) {
      warnings.push(`${repoRoot}: repo folder missing — skipped`);
      continue;
    }

    // Personal repository settings: branching + scripts.
    const shared: RawSettingsDoc = {};
    const git: Record<string, string> = {};
    if (typeof legacy.remoteOrigin === "string" && legacy.remoteOrigin.trim())
      git.remote = legacy.remoteOrigin.trim();
    if (typeof legacy.baseBranch === "string" && legacy.baseBranch.trim())
      git.base_branch = legacy.baseBranch.trim();
    if (Object.keys(git).length > 0) shared.git = git;

    const scripts: Record<string, unknown> = {};
    const legacyScripts = Array.isArray(legacy.scripts) ? legacy.scripts : [];
    const setupCmds = legacyScripts
      .filter(
        (s) =>
          s?.runOnCreate && typeof s.command === "string" && s.command.trim(),
      )
      .map((s) => (s.command as string).trim());
    if (setupCmds.length > 0) scripts.setup = setupCmds.join(" && ");
    const runCandidates = legacyScripts.filter(
      (s) =>
        !s?.runOnCreate && typeof s?.command === "string" && s.command.trim(),
    );
    if (runCandidates.length > 0)
      scripts.run = (runCandidates[0].command as string).trim();
    if (runCandidates.length) {
      const actions = runCandidates.map((candidate, index) => ({
        id: `legacy-run-${index + 1}`,
        name:
          typeof candidate.name === "string" && candidate.name.trim()
            ? candidate.name.trim()
            : `Run ${index + 1}`,
        command: (candidate.command as string).trim(),
      }));
      const current = opSettingsRead("repo-local", repoRoot);
      if (current.error) throw new Error(current.error);
      const previous = isPlainObject(current.doc.scripts)
        ? current.doc.scripts.run
        : undefined;
      if (
        typeof previous === "string" &&
        previous.trim() &&
        !actions.some((action) => action.command === previous.trim())
      )
        actions.unshift({ id: "run", name: "Run", command: previous.trim() });
      scripts.run_actions = actions;
    }
    if (Object.keys(scripts).length > 0) shared.scripts = scripts;

    if (Object.keys(shared).length > 0) {
      writeMergeUnder("repo-local", shared, repoRoot);
      migratedRepos.push(repoRoot);
    }

    // Personal (gitignored) layer: machine-specific worktrees path.
    if (
      typeof legacy.workspacesPath === "string" &&
      legacy.workspacesPath.trim()
    ) {
      writeMergeUnder(
        "repo-local",
        { workspaces: { path: legacy.workspacesPath.trim() } },
        repoRoot,
      );
      if (!migratedRepos.includes(repoRoot)) migratedRepos.push(repoRoot);
    }
  }

  const providerPatch: Record<string, Record<string, string>> = {};
  for (const [agentId, prefs] of Object.entries(input.providers ?? {})) {
    if (!isPlainObject(prefs)) continue;
    const p: Record<string, string> = {};
    if (prefs.authMethod === "cli") p.auth = "cli";
    if (prefs.authMethod === "apiKey" || prefs.authMethod === "api-key")
      p.auth = "api-key";
    if (typeof prefs.binaryPath === "string" && prefs.binaryPath.trim())
      p.executable_path = prefs.binaryPath.trim();
    if (typeof prefs.gatewayBaseUrl === "string" && prefs.gatewayBaseUrl.trim())
      p.base_url = prefs.gatewayBaseUrl.trim();
    if (Object.keys(p).length > 0) {
      providerPatch[agentId] = p;
      migratedProviders.push(agentId);
    }
  }
  if (Object.keys(providerPatch).length > 0) {
    writeMergeUnder("user", { providers: providerPatch });
  }

  return { migratedRepos, migratedProviders, warnings };
}

/** Patch a layer file keeping EXISTING values: any key already set in the
 *  file is dropped from the patch before writing. */
function writeMergeUnder(
  layer: WritableLayer,
  patch: RawSettingsDoc,
  repoRoot?: string,
): void {
  const current = opSettingsRead(layer, repoRoot);
  if (current.error) throw new Error(current.error); // retry; never mark a failed migration complete
  const pruned = dropExisting(patch, current.doc);
  if (Object.keys(pruned).length === 0) return;
  opSettingsWrite(layer, pruned, repoRoot);
}

function dropExisting(
  patch: RawSettingsDoc,
  existing: RawSettingsDoc,
): RawSettingsDoc {
  const out: RawSettingsDoc = {};
  for (const [key, value] of Object.entries(patch)) {
    const cur = existing[key];
    if (cur === undefined) {
      out[key] = value;
      continue;
    }
    if (isPlainObject(value) && isPlainObject(cur)) {
      const nested = dropExisting(value, cur);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
    // existing scalar/array → keep the file's value, drop the patch key
  }
  return out;
}
