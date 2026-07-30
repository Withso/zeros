// ──────────────────────────────────────────────────────────
// Settings foundation — zod schemas (single source of truth)
// ──────────────────────────────────────────────────────────
//
// One zod definition per layer shape; the published JSON-schema artifacts
// (zeros.build/schemas/*.json, built by scripts/build-settings-schemas.ts)
// and the engine's runtime validation both derive from here.
//
// Layer files (see docs/settings-toml-architecture-audit-2026-06-20.md):
//   ~/.zeros/settings.toml              user    (dev: ~/.zeros-dev)
//   ~/.zeros/settings.managed.toml      managed (admin policy; resolver stub in v1)
//   <repo>/.zeros/settings.toml         repo    (shared — committed)
//   <repo>/.zeros/settings.local.toml   repo-local (personal — gitignored)
//
// Validation is per-leaf, not per-file: a bad value drops that one key with a
// warning, never the whole document. Unknown keys are ALWAYS preserved so an
// older Zeros never strips keys written by a newer one.
// ──────────────────────────────────────────────────────────

import { z } from "zod";
import { GITHUB_AUTH_METHODS } from "@zeros/core/github-auth";

export const RUN_MODES = ["concurrent", "nonconcurrent"] as const;
export const PROVIDER_AUTH_METHODS = ["cli", "api-key"] as const;
/** Reasoning-effort levels — mirror of the renderer's ChatEffort union. */
export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultracode",
] as const;

export const SCHEMA_URL_USER =
  "https://zeros.build/schemas/settings.schema.json";
export const SCHEMA_URL_REPO =
  "https://zeros.build/schemas/settings.repo.schema.json";

export const RUN_ACTION_PLATFORMS = ["mac", "linux", "win"] as const;

/** One named run action (`[[scripts.run_actions]]`). Multiple actions may run
 *  concurrently, each in its own Run sub-tab. The normalized/migrated view both
 *  sides consume is @zeros/core/run-actions parseRunActions(). */
const runActionSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Stable id — the session-id suffix + status key."),
  name: z.string().min(1).describe("Label shown on the tab / menu / button."),
  command: z.string().min(1).describe("Shell command, e.g. `pnpm dev`."),
  icon: z
    .string()
    .optional()
    .describe("Lucide icon name (curated set; unknown falls back to play)."),
  platforms: z
    .array(z.enum(RUN_ACTION_PLATFORMS))
    .optional()
    .describe("OSes this action shows on. Absent/empty = all."),
  one_shot: z
    .boolean()
    .optional()
    .describe(
      "true → run to completion for a pass/fail verdict; false → long-lived (dev server). Absent = heuristic by command.",
    ),
  run_on_create: z
    .boolean()
    .optional()
    .describe("Start automatically when a workspace is created."),
  default: z
    .boolean()
    .optional()
    .describe("The header split-button face + primary shortcut."),
});

const scriptsSchema = z
  .object({
    setup: z.string().describe("Runs when a workspace is created."),
    run: z
      .string()
      .describe(
        "LEGACY single run command — superseded by run_actions (it migrates to one default action at read time when run_actions is absent; an explicit run_actions list, even empty, wins).",
      ),
    run_actions: z
      .array(runActionSchema)
      .describe(
        "Named run actions — multiple concurrent run commands, each with an icon. Supersedes the single `run` string (which migrates to one default action at read time).",
      ),
    archive: z.string().describe("Runs before a workspace is archived."),
    run_mode: z
      .enum(RUN_MODES)
      .describe("Whether run scripts of multiple workspaces may run at once."),
    auto_run_after_setup: z
      .boolean()
      .describe("Start the run script automatically after setup."),
  })
  .partial();

const gitSchema = z
  .object({
    remote: z.string().describe("Git remote new workspaces branch from."),
    base_branch: z.string().describe("Branch new workspaces fork from."),
    branch_prefix_type: z
      .string()
      .describe("How workspace branch names are generated."),
    delete_branch_on_archive: z
      .boolean()
      .describe("Delete the branch when archiving."),
    archive_on_merge: z
      .boolean()
      .describe("Archive a workspace automatically when its PR merges."),
  })
  .partial();

const providerSchema = z
  .object({
    auth: z
      .enum(PROVIDER_AUTH_METHODS)
      .describe("How this agent authenticates."),
    executable_path: z.string().describe("Override the agent executable path."),
    base_url: z.string().describe("Gateway/base-URL override (non-secret)."),
  })
  .partial();

const githubSchema = z
  .object({
    auth_method: z
      .enum(GITHUB_AUTH_METHODS)
      .describe("The GitHub credential method Zeros actively uses."),
    disconnected_at: z
      .string()
      .describe(
        "ISO timestamp of the last explicit disconnect; prevents implicit credential adoption.",
      ),
  })
  .partial();

const promptsSchema = z
  .object({
    general: z.string().describe("Appended to every agent session."),
    code_review: z.string(),
    create_pr: z.string(),
    fix_errors: z.string(),
    rename_branch: z.string(),
    resolve_merge_conflicts: z.string(),
  })
  .partial();

// ── MCP servers (unified registry; "configure once → all agents") ──
//
// A user/repo settings.toml may declare MCP servers as an array of tables:
//
//   [[mcp.servers]]
//   name = "context7"
//   transport = "stdio"
//   command = "npx"
//   args = ["-y", "@upstash/context7-mcp"]
//
//   [[mcp.servers]]
//   name = "tracker"
//   transport = "http"
//   url = "https://mcp.tracker.example/mcp"
//
// The engine boot-loads these into the AgentGateway registry, which fans them
// out to all three adapters in each one's native shape. `enabled = false`
// keeps an entry in the file but drops it from the registry (Customize → MCP
// per-server toggle). Secrets: prefer non-secret coordinates + env-var refs
// here; raw tokens in a *committed* repo file would leak (same caution as the
// repo `[env]` table) — keychain-backed secret refs land with the panel UI.
const mcpStdioServerSchema = z.object({
  name: z.string().min(1).describe("Unique server name (the tool namespace)."),
  transport: z.literal("stdio"),
  command: z
    .string()
    .min(1)
    .describe("Executable to spawn for the stdio server."),
  args: z
    .array(z.string())
    .optional()
    .describe("Arguments passed to the command."),
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Environment variables for the server process (non-secret / refs).",
    ),
  enabled: z
    .boolean()
    .optional()
    .describe("Set false to keep the entry but skip loading it."),
});
const mcpHttpServerSchema = z.object({
  name: z.string().min(1).describe("Unique server name (the tool namespace)."),
  transport: z.literal("http"),
  url: z.string().min(1).describe("Streamable-HTTP endpoint URL."),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'HTTP headers sent on every request (e.g. Authorization; non-secret / refs). Applies to auth="none" (injected directly) and auth="header" (sent alongside the brokered secret); IGNORED for auth="oauth" (the gateway manages the connection).',
    ),
  auth: z
    .enum(["none", "oauth", "header"])
    .optional()
    .describe(
      'Routes this server through the Zeros MCP gateway: "oauth" brokers OAuth 2.1 once and holds the token; "header" holds a static auth header (its VALUE lives in the engine vault, never here) and adds it when proxying. Default "none" = injected directly with the headers above.',
    ),
  header_name: z
    .string()
    .optional()
    .describe(
      'For auth="header": the header NAME the gateway sets (e.g. Authorization). The value is stored in the engine secret vault, not this file.',
    ),
  oauth_client_id: z
    .string()
    .optional()
    .describe(
      'For auth="oauth": a pre-registered OAuth client_id for servers that don\'t support Dynamic Client Registration (Auth0/Okta/Cognito/enterprise). Non-secret. Omit to auto-register (DCR).',
    ),
  disabled_tools: z
    .array(z.string())
    .optional()
    .describe(
      "For a gateway-fronted server (auth oauth/header): tool NAMES to hide from agents — e.g. to stay under Cursor's ~40-tool cap. Empty/absent = all tools exposed.",
    ),
  enabled: z
    .boolean()
    .optional()
    .describe("Set false to keep the entry but skip loading it."),
});
export const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
]);
const mcpSchema = z
  .object({
    servers: z
      .array(mcpServerSchema)
      .describe("MCP servers shared across every agent."),
  })
  .partial();

/** A single validated MCP server entry as written in settings.toml. */
export type McpSettingsServer = z.infer<typeof mcpServerSchema>;

/** Keys a repo may configure — safe for a committed, team-shared file.
 *
 *  SLIMMED 2026-07-17 (founder direction): repo-scoped settings files carry
 *  scripts config first and foremost — setup / archive / run actions — plus
 *  the two tables live repo-page tabs still edit (`git` for the Git tab,
 *  `prompts` for the Actions tab). Everything else left the repo files:
 *  `env` / `env_files` (env vars are Keychain-only now — env-vault.ts),
 *  `mcp` (user-level only until the settings consolidation), and
 *  `file_include_globs` (use a repo-root `.worktreeinclude` file instead).
 *  Those keys remain valid at the USER layer only; in a repo-scoped file
 *  they are ignored with a warning (see REPO_FILE_UNSUPPORTED_KEYS).
 *
 *  NOTE: `providers` is intentionally USER-ONLY (see userSettingsSchema +
 *  USER_ONLY_KEYS) — NOT a repo key. Per-repo provider overrides
 *  (executable_path / base_url) were removed: a committed/clone-borne repo
 *  file must not be able to redirect the spawned agent binary or its
 *  credential-bearing gateway. */
export const repoSettingsSchema = z.object({
  $schema: z
    .string()
    .optional()
    .describe("JSON Schema URL for editor autocomplete."),
  scripts: scriptsSchema.optional(),
  git: gitSchema.optional(),
  prompts: promptsSchema.optional(),
});

// Per-agent model knobs, one table per agent: [models.claude_code] /
// [models.codex]. The key names follow each agent's own vocabulary — Claude
// calls it "effort", Codex calls it "thinking" — so the TOML reads the way the
// agent's own docs do. Unknown sub-keys (e.g. a future review_effort_level)
// are preserved in the file by the in-place writer; only validated keys surface
// in the resolved view.
const claudeModelsSchema = z
  .object({
    default_effort_level: z
      .enum(EFFORT_LEVELS)
      .describe("Default reasoning effort for Claude models in new chats."),
  })
  .partial();
const codexModelsSchema = z
  .object({
    default_thinking_level: z
      .enum(EFFORT_LEVELS)
      .describe(
        "Default reasoning effort for Codex (GPT) models in new chats.",
      ),
  })
  .partial();

const modelsSchema = z
  .object({
    default: z.string().describe("Default model for new chats."),
    default_agent: z
      .string()
      .describe(
        "Agent the default model belongs to (claude/codex/cursor). Disambiguates a model id that's shared across agents or whose value embeds another family's name.",
      ),
    review: z.string().describe("Model used for code reviews."),
    default_fast_mode: z.boolean().describe("Start new chats in fast mode."),
    default_plan_mode: z.boolean().describe("Start new chats in plan mode."),
    claude_code: claudeModelsSchema.describe("Claude-specific model defaults."),
    codex: codexModelsSchema.describe("Codex-specific model defaults."),
  })
  .partial();

const workspacesSchema = z
  .object({
    path: z.string().describe("Root folder where new worktrees are created."),
  })
  .partial();

/** User layer = repo keys + user-only keys. A repo must never set models,
 *  approvals, machine paths, or providers: those are per-user or per-machine,
 *  and a committed repo file would silently reconfigure every teammate.
 *  `providers` (agent auth + executable_path + gateway base_url)
 *  lives here ONLY: it's per-user/per-machine, never per-repo. `env` /
 *  `env_files` / `mcp` / `file_include_globs` also live here only since the
 *  2026-07-17 repo-file slimming (they used to be repo keys too). */
export const userSettingsSchema = repoSettingsSchema.extend({
  env: z
    .record(z.string(), z.string())
    .optional()
    .describe("Non-secret environment variables passed to agents."),
  env_files: z
    .array(z.string())
    .optional()
    .describe("Env files parsed at spawn time; values never enter TOML."),
  file_include_globs: z
    .array(z.string())
    .optional()
    .describe(
      'Gitignored files matching these globs are seeded into each new worktree (e.g. ".env*"). A repo-root .worktreeinclude file, if present, takes precedence.',
    ),
  mcp: mcpSchema.optional(),
  models: modelsSchema.optional(),
  workspaces: workspacesSchema.optional(),
  tool_approvals_enabled: z.boolean().optional(),
  github: githubSchema.optional(),
  providers: z.record(z.string(), providerSchema).optional(),
});

/** Managed (admin policy) layer can set anything a user can. Stub in v1. */
export const managedSettingsSchema = userSettingsSchema;

export type RepoSettingsDoc = z.infer<typeof repoSettingsSchema>;
export type UserSettingsDoc = z.infer<typeof userSettingsSchema>;

/** A parsed-but-untrusted settings document (raw TOML parse output). */
export type RawSettingsDoc = Record<string, unknown>;

export type SettingsLayerName =
  | "default"
  | "user"
  | "team"
  | "repo"
  | "repo-local"
  | "workspace-local"
  | "managed";

/** Keys ignored (with a warning) when they appear in a repo-scoped layer.
 *  The committed repo file may set none of these; the personal (gitignored)
 *  repo-local file MAY set `workspaces` — a machine-specific worktrees-path
 *  override is exactly what that file exists for. (The published repo JSON
 *  schema stays the strict committed shape; repo-local accepting `workspaces`
 *  is a deliberate engine-side superset.) `providers` is user-only across ALL
 *  repo-scoped layers (repo / repo-local / workspace-local) — agent auth and
 *  binary/gateway overrides are per-user, never per-repo or per-worktree. */
export const USER_ONLY_KEYS = [
  "models",
  "workspaces",
  "tool_approvals_enabled",
  "github",
  "providers",
] as const;
const USER_ONLY_BY_LAYER: Record<string, readonly string[]> = {
  team: USER_ONLY_KEYS,
  repo: USER_ONLY_KEYS,
  "repo-local": ["models", "tool_approvals_enabled", "providers"],
  // workspace-local is the worktree's own gitignored file — same trust + key
  // rules as repo-local (per-machine personal config, just per-worktree).
  "workspace-local": ["models", "tool_approvals_enabled", "providers"],
};

/** Keys NO repo-scoped settings file reads anymore (2026-07-17 slimming):
 *  repo files carry scripts (+ the git / prompts tables the repo-page tabs
 *  edit, and repo-local's `workspaces.path`) — nothing else. `env` and
 *  `env_files` moved to the Keychain env vault; `file_include_globs` is
 *  superseded by a repo-root `.worktreeinclude`.
 *  Ignored with a warning, never stripped from the file (no migration —
 *  stale keys stay inert on disk and survive read-modify-write).
 *
 *  2026-07-22: `mcp` returned to the REPO-LOCAL layer only (see
 *  REPO_UNSUPPORTED_BY_LAYER) — the Customize tab's repo scope writes per-repo
 *  MCP servers into the personal, gitignored `.zeros/settings.local.toml`.
 *  The COMMITTED repo file and workspace-local still refuse `mcp`: a
 *  clone-borne file must not be able to register an MCP server (the stdio-RCE
 *  gate the 2026-07-17 slimming introduced stays for shared files). */
export const REPO_FILE_UNSUPPORTED_KEYS = [
  "env",
  "env_files",
  "mcp",
  "file_include_globs",
] as const;

/** The subset of REPO_FILE_UNSUPPORTED_KEYS each repo-scoped layer ignores.
 *  repo-local reads `mcp` (per-repo MCP servers, personal file); the committed
 *  repo file and workspace-local ignore the full set. */
const REPO_UNSUPPORTED_BY_LAYER: Record<string, readonly string[]> = {
  repo: REPO_FILE_UNSUPPORTED_KEYS,
  "repo-local": ["env", "env_files", "file_include_globs"],
  "workspace-local": REPO_FILE_UNSUPPORTED_KEYS,
};

/** The layers backed by in-repo files (`.zeros/settings*.toml`). */
const REPO_SCOPED_LAYERS: ReadonlySet<SettingsLayerName> = new Set([
  "repo",
  "repo-local",
  "workspace-local",
]);

/** Keys that can poison Object.prototype via the parsed (null-proto) TOML doc.
 *  Dropped from every layer before merge/write. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Own-property check that works pre-ES2022 (no `Object.hasOwn`). */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ── per-leaf sanitization ──────────────────────────────────

export interface SanitizeResult {
  /** Valid known keys + unknown keys preserved verbatim. */
  doc: RawSettingsDoc;
  /** Human-readable notes for every dropped key. */
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? issue.message : "invalid value";
}

/** Validate each field of a table independently against `shape`; keep valid
 *  fields, preserve unknown fields, drop invalid ones with a warning. */
function sanitizeTable(
  shape: Record<string, z.ZodType>,
  value: unknown,
  basePath: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    warnings.push(`${basePath}: expected a table — ignored`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) continue; // prototype-pollution guard
    // own-key check (NOT `shape[k]`): a key named `constructor`/`toString`/etc.
    // resolves up the prototype chain to a function, which would bypass the
    // unknown-key branch and throw `field.safeParse is not a function`.
    const field = hasOwn(shape, k) ? shape[k] : undefined;
    if (!field) {
      out[k] = v; // unknown key → preserve verbatim
      continue;
    }
    const r = field.safeParse(v);
    if (r.success) out[k] = r.data;
    else warnings.push(`${basePath}.${k}: ${firstIssue(r.error)} — ignored`);
  }
  return out;
}

/** Validate a record per-entry so one bad entry doesn't drop its siblings. */
function sanitizeRecord(
  entrySchema: z.ZodType,
  value: unknown,
  basePath: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    warnings.push(`${basePath}: expected a table — ignored`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const r = entrySchema.safeParse(v);
    if (r.success) out[k] = r.data;
    else warnings.push(`${basePath}.${k}: ${firstIssue(r.error)} — ignored`);
  }
  return out;
}

/** Validate the `[mcp]` table: `servers` is an array-of-tables, each a
 *  stdio|http discriminated union. One bad server entry is dropped with a
 *  warning, never the whole list; order is preserved (= registry precedence).
 *  Unknown keys under `[mcp]` are preserved verbatim (forward-compat). */
function sanitizeMcp(
  value: unknown,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    warnings.push(`mcp: expected a table — ignored`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (k !== "servers") {
      out[k] = v; // unknown key under [mcp] → preserve verbatim
      continue;
    }
    if (!Array.isArray(v)) {
      warnings.push(`mcp.servers: expected an array of tables — ignored`);
      continue;
    }
    const servers: unknown[] = [];
    v.forEach((entry, i) => {
      const r = mcpServerSchema.safeParse(entry);
      if (r.success) servers.push(r.data);
      else warnings.push(`mcp.servers[${i}]: ${firstIssue(r.error)} — ignored`);
    });
    out.servers = servers;
  }
  return out;
}

const TABLE_SHAPES: Record<string, Record<string, z.ZodType>> = {
  scripts: scriptsSchema.shape,
  git: gitSchema.shape,
  prompts: promptsSchema.shape,
  models: modelsSchema.shape,
  workspaces: workspacesSchema.shape,
  github: githubSchema.shape,
};

/** Per-leaf sanitize of one raw layer document. Layer-aware: user-only keys
 *  found in repo-scoped layers are dropped with a warning. */
export function sanitizeLayer(
  raw: unknown,
  layer: SettingsLayerName,
): SanitizeResult {
  const warnings: string[] = [];
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null)
      warnings.push(`${layer}: document is not a table — ignored`);
    return { doc: {}, warnings };
  }
  const userOnly = USER_ONLY_BY_LAYER[layer] ?? [];
  const doc: RawSettingsDoc = {};

  for (const [key, value] of Object.entries(raw)) {
    if (DANGEROUS_KEYS.has(key)) continue; // prototype-pollution guard
    if (userOnly.includes(key)) {
      warnings.push(`${key}: user-only key — ignored in ${layer} settings`);
      continue;
    }
    if (
      REPO_SCOPED_LAYERS.has(layer) &&
      (REPO_UNSUPPORTED_BY_LAYER[layer] ?? []).includes(key)
    ) {
      warnings.push(
        `${key}: not read from repo settings files anymore (repo files carry scripts config; env lives in the Keychain, MCP at user level or the personal repo-local file) — ignored in ${layer} settings`,
      );
      continue;
    }
    // Scripts (setup / archive / run actions) are REPO settings — they live in
    // the COMMITTED `.zeros/settings.toml`, deliberately shared by every Zeros
    // install that opens the repo (like `.vscode/`). The personal gitignored
    // files carry user-only keys (workspaces path, git/prompt overrides) and
    // are not read for scripts: a stale `[scripts]` in settings.local.toml
    // would otherwise SHADOW the committed file (repo-local outranks repo in
    // the resolver), so an edit in the UI would silently not apply.
    if (
      key === "scripts" &&
      (layer === "repo-local" || layer === "workspace-local")
    ) {
      warnings.push(
        `scripts: script settings live in the committed .zeros/settings.toml — ignored in ${layer} settings`,
      );
      continue;
    }
    if (key === "$schema") {
      if (typeof value === "string") doc[key] = value;
      else warnings.push(`$schema: expected a string — ignored`);
      continue;
    }
    if (key === "env") {
      const env = sanitizeRecord(z.string(), value, "env", warnings);
      if (env) doc.env = env;
      continue;
    }
    if (key === "env_files") {
      if (!Array.isArray(value)) {
        warnings.push(`env_files: expected an array of strings — ignored`);
        continue;
      }
      const files = value.filter((f) => {
        if (typeof f === "string") return true;
        warnings.push(`env_files: non-string entry — ignored`);
        return false;
      });
      doc.env_files = files;
      continue;
    }
    if (key === "providers") {
      const providers = isPlainObject(value)
        ? (() => {
            const out: Record<string, unknown> = {};
            for (const [agent, cfg] of Object.entries(value)) {
              if (DANGEROUS_KEYS.has(agent)) continue;
              const table = sanitizeTable(
                providerSchema.shape,
                cfg,
                `providers.${agent}`,
                warnings,
              );
              if (table) out[agent] = table;
            }
            return out;
          })()
        : (warnings.push(`providers: expected a table — ignored`), undefined);
      if (providers) doc.providers = providers;
      continue;
    }
    if (key === "mcp") {
      const mcp = sanitizeMcp(value, warnings);
      if (mcp) doc.mcp = mcp;
      continue;
    }
    if (key === "tool_approvals_enabled") {
      if (typeof value === "boolean") doc[key] = value;
      else
        warnings.push(`tool_approvals_enabled: expected a boolean — ignored`);
      continue;
    }
    const shape = hasOwn(TABLE_SHAPES, key) ? TABLE_SHAPES[key] : undefined;
    if (shape) {
      const table = sanitizeTable(shape, value, key, warnings);
      if (table) doc[key] = table;
      continue;
    }
    doc[key] = value; // unknown top-level key → preserve verbatim
  }

  return { doc, warnings };
}
