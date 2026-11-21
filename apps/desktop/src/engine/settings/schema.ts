
import { z } from "zod";
import { foldRetiredAgentControl } from "./retired-agent-control";
import { personalPreferencesSchema } from "@zeros/protocol/personal-preferences";
import { GITHUB_AUTH_METHODS } from "@zeros/protocol/github-auth";
import { SIMULATOR_IDLE_SHUTDOWN_CHOICES } from "@zeros/protocol/simulators";
import {
  DESIGN_DIRECTORY_ID_PATTERN,
  sanitizeDesignDirectoryName,
} from "../design/directory-path";
import {
  designBuildInputPathError,
  designBuildOutputPathError,
} from "../design/style-source-path";

export const RUN_MODES = ["concurrent", "nonconcurrent"] as const;
export const PROVIDER_AUTH_METHODS = [
  "cli",
  "api-key",
  "subscription",
] as const;
/** Keep the persisted zeros option for existing settings even though github is now the default. */
export const BRANCH_PREFIX_TYPES = [
  "zeros",
  "github",
  "custom",
  "none",
] as const;
export type BranchPrefixType = (typeof BRANCH_PREFIX_TYPES)[number];
/** Unset means the connected GitHub login; without a usable login, new branches still use zeros/. */
export const DEFAULT_BRANCH_PREFIX_TYPE: BranchPrefixType = "github";
/** Keep in sync with the renderer's ChatEffort union. */
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
export const SCHEMA_URL_WORKSPACE =
  "https://zeros.build/schemas/settings.workspace.schema.json";

export const RUN_ACTION_PLATFORMS = ["mac", "linux", "win"] as const;

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
    archive_required: z.boolean().describe(
      "Require successful archive cleanup before removing the workspace. The command must be idempotent: interrupted or failed cleanup is retried.",
    ),
    archive_timeout_seconds: z.number().int().min(1).max(3600).describe(
      "Archive script deadline in seconds (1–3600). Defaults to 30.",
    ),
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
      .enum(BRANCH_PREFIX_TYPES)
      .describe(
        'Which namespace a new workspace branch goes under: "github" = the ' +
          'connected GitHub login (the default), "custom" = the ' +
          '`branch_prefix` string, "none" = no prefix (the bare workspace ' +
          'name), "zeros" = the fixed `zeros/` namespace. The namespace is ' +
          "joined to the name with a single `/`.",
      ),
    branch_prefix: z
      .string()
      .describe(
        'The namespace used when branch_prefix_type = "custom". Joined to the ' +
          "workspace name with a single `/`, so `acme` gives `acme/Cream`. A " +
          "leading or trailing slash is optional and ignored.",
      ),
    delete_branch_on_archive: z
      .boolean()
      .describe("Delete the branch when archiving."),
    archive_on_merge: z
      .boolean()
      .describe("Archive a workspace automatically when its PR merges."),
    fetch_submodules: z
      .boolean()
      .describe(
        "Fetch the repository's github.com submodules after a Local workspace is created. Off by default.",
      ),
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


function isLoopbackHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.hash;
  } catch {
    return false; // zod still runs refinements after .url() fails
  }
}
// The runtime parses URLs; the published pattern advertises only common loopback spellings.
const LOOPBACK_HTTP_URL_PATTERN = String.raw`^http://(?:127\.0\.0\.1|localhost|\[::1\])(?::(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|\d{1,4}))?(?:[/?][^#]*)?$`;

const mcpStdioServerSchema = z.object({
  credential_id: z.uuid().optional(),
  name: z.string().min(1).describe("Unique server name (the tool namespace)."),
  transport: z.literal("stdio"),
  command: z
    .string()
    .min(1)
    .describe("Executable to spawn for the stdio server."),
  cwd: z.string().trim().min(1).max(4096).refine((v) => !v.includes("\0"), "Invalid working directory").optional()
    .describe("Folder for this local MCP process. Relative paths resolve against the chat workspace; ~/ uses the engine user's home. Omit to preserve the provider default."),
  listen_url: z.string().url().max(4096).refine(isLoopbackHttpUrl, "Use an HTTP loopback endpoint").meta({
    description: "Loopback HTTP endpoint (127.0.0.1, localhost or [::1]) where this command serves MCP. Zeros starts the command when it is first needed. No credentials or fragment.",
    pattern: LOOPBACK_HTTP_URL_PATTERN,
  }).optional(),
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
  credential_id: z.uuid().optional(),
  name: z.string().min(1).describe("Unique server name (the tool namespace)."),
  transport: z.literal("http"),
  url: z.string().min(1).describe("Streamable-HTTP endpoint URL."),
  env: z.record(z.string(), z.string()).optional().describe("Secure variables available to configured header references."),
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
  header_names: z.array(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/)).max(128).optional(),
  oauth_client_mode: z.enum(["auto", "metadata", "dynamic", "custom"]).optional(),
  oauth_client_id: z
    .string()
    .optional()
    .describe(
      'For auth="oauth": a pre-registered OAuth client_id for servers that don\'t support Dynamic Client Registration (Auth0/Okta/Cognito/enterprise). Non-secret. Omit to auto-register (DCR).',
    ),
  oauth_scopes: z.array(z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).max(64).optional()
    .describe("OAuth permission scopes to request. Credentials are stored separately in the encrypted vault."),
  disabled_tools: z
    .array(z.string())
    .optional()
    .describe(
      "For a gateway-fronted server (auth oauth/header): tool NAMES to hide from agents. Empty/absent = all tools exposed.",
    ),
  enabled: z
    .boolean()
    .optional()
    .describe("Set false to keep the entry but skip loading it."),
});
export const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
  mcpHttpServerSchema.extend({
    transport: z.literal("sse"),
    url: z.string().min(1).describe("SSE endpoint URL."),
  }),
]);
const mcpSchema = z
  .object({
    servers: z
      .array(mcpServerSchema)
      .describe("MCP servers shared across every agent."),
  })
  .partial();

export type McpSettingsServer = z.infer<typeof mcpServerSchema>;

const designStyleBuildSchema = z.object({
  output: z
    .string()
    .refine(
      (value) => designBuildOutputPathError(value) === null,
      "Expected a repository-relative .css file outside .git and .zeros, or one in .zeros/design-styles/",
    )
    .describe(
      "The CSS file the command writes, matching a build style source's path. " +
        "Prefer .zeros/design-styles/<name>.css, which Zeros keeps out of Git.",
    ),
  command: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe("Shell command Zeros runs in the checkout to build `output`."),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe("Build deadline in seconds (1–600). Defaults to 120."),
  watch: z
    .boolean()
    .optional()
    .describe(
      "The command keeps running and rebuilds by itself (for example sass --watch). " +
        "Zeros runs it while the Design tab is open and stops it 5 minutes after you leave.",
    ),
  inputs: z
    .array(
      z
        .string()
        .refine(
          (value) => designBuildInputPathError(value) === null,
          "Expected a repository-relative file or folder outside .git and .zeros",
        ),
    )
    .max(32)
    .optional()
    .describe(
      "Files or folders whose changes re-run a one-shot command while the Design tab is open.",
    ),
});

const designSchema = z
  .object({
    directory: z
      .string()
      .refine(
        (value) => sanitizeDesignDirectoryName(value) !== null,
        "Expected a safe repo-relative Design directory",
      )
      .describe(
        "Repo-relative folder the design surface reads and writes " +
          '(default "Zeros Design"). The folder is committed content; this ' +
          "key just selects which design folder is active.",
      ),
    directory_id: z
      .string()
      .regex(DESIGN_DIRECTORY_ID_PATTERN)
      .describe(
        "Stable ID from a Design folder's design.toml in this checkout.",
      ),
    repository_style_builds: z
      .boolean()
      .describe(
        "Run the style builds a Design directory declares in meta/canvas.json " +
          "while the Design tab is open (default true). Your own style_builds " +
          "entries still run when this is false.",
      ),
    style_builds: z
      .array(designStyleBuildSchema)
      .max(16)
      .describe(
        "Build commands you approve for Design style sources. Zeros runs a " +
          "build source's command only from your own settings, never from " +
          "the repository's files.",
      ),
  })
  .partial();

export const repoSettingsSchema = z.object({
  $schema: z
    .string()
    .optional()
    .describe("JSON Schema URL for editor autocomplete."),
  scripts: scriptsSchema.optional(),
  git: gitSchema.optional(),
  prompts: promptsSchema.optional(),
  design: designSchema.optional(),
});

const claudeModelsSchema = z
  .object({
    default_effort_level: z
      .enum(EFFORT_LEVELS)
      .describe(
        "Legacy Claude-family effort (migration input for the selected model).",
      ),
    fallback_model: z
      .string()
      .min(1)
      .describe(
        'Deprecated compatibility key. Ignored; Claude owns native fallback routing.',
      ),
    budget_cap_usd: z
      .number()
      .positive()
      .describe("Deprecated compatibility key. Ignored; Zeros no longer applies a spend cap."),
    idle_timeout_minutes: z
      .union([z.literal(30), z.literal(60), z.literal(120), z.literal(300)])
      .describe(
        "How long an idle Claude session stays warm (30 minutes to 5 hours).",
      ),
    auto_memory_enabled: z
      .boolean()
      .describe("Allow Claude Code to maintain its native repository memory."),
    idle_compaction_enabled: z
      .boolean()
      .describe("Allow Claude Code to compact long conversations while idle (off by default)."),
  })
  .partial();
const codexModelsSchema = z
  .object({
    default_thinking_level: z
      .enum(EFFORT_LEVELS)
      .describe(
        "Legacy Codex-family effort (migration input for the selected model).",
      ),
  })
  .partial();

const modelPreferenceEffortSchema = z
  .enum(EFFORT_LEVELS)
  .describe("Last reasoning effort selected for this exact model.");
const modelPreferenceFastSchema = z
  .boolean()
  .describe("Last Fast-mode selection for this exact model.");
const modelPreferenceBaseSchema = z.object({
  agent: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Canonical agent family, or extension agent id, that owns this model.",
    ),
  model: z.string().trim().min(1).describe("Exact provider model identifier."),
  effort: modelPreferenceEffortSchema.optional(),
  fast: modelPreferenceFastSchema.optional(),
});
const modelPreferenceSchema = z.union([
  modelPreferenceBaseSchema.extend({ effort: modelPreferenceEffortSchema }),
  modelPreferenceBaseSchema.extend({ fast: modelPreferenceFastSchema }),
]);

const permissionPreferenceSchema = z.object({
  agent: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Canonical agent family, or extension agent id, that owns this permission choice.",
    ),
  mode: z
    .string()
    .trim()
    .min(1)
    .describe("Exact native permission-mode identifier."),
});

const modelsSchema = z
  .object({
    default: z.string().describe("Default model for new chats."),
    default_agent: z
      .string()
      .describe(
        "Agent the default model belongs to. Disambiguates a model id that's shared across agents or whose value embeds another family's name.",
      ),
    review: z.string().describe("Model used for code reviews."),
    default_fast_mode: z
      .boolean()
      .describe(
        "Legacy global Fast default (migration input for the selected model).",
      ),
    default_plan_mode: z.boolean().describe("Start new chats in plan mode."),
    favorites: z
      .record(z.string(), z.string())
      .describe("Legacy favorite model id per agent family (migration input)."),
    model_preferences: z
      .array(modelPreferenceSchema)
      .max(128)
      .describe(
        "Bounded per-model reasoning and Fast-mode memory. Entries are isolated by agent family and exact model id.",
      ),
    permission_preferences: z
      .array(permissionPreferenceSchema)
      .max(32)
      .describe(
        "Bounded per-agent permission-mode memory. Exact native ids preserve modes that share the same coarse posture.",
      ),
    // Keep reading this retired key until model preference writes clear it.
    chat_title_model: z
      .string()
      .describe("Model used to generate chat titles."),
    claude_code: claudeModelsSchema.describe("Claude-specific model defaults."),
    codex: codexModelsSchema.describe("Codex-specific model defaults."),
  })
  .partial();

const workspacesSchema = z
  .object({
    path: z.string().describe("Root folder where new worktrees are created."),
  })
  .partial();

const browserSchema = z
  .object({
    enabled: z
      .boolean()
      .describe(
        "Let agents use a browser: the in-app Zeros browser, or Chrome for Claude when chosen.",
      ),
    claude_enabled: z
      .boolean()
      .describe(
        "Use Claude Code with Chrome: Claude uses your Chrome and its extension instead of the in-app browser.",
      ),
    auto_open: z
      .boolean()
      .describe(
        "Reveal the Browser workbench tab when an active agent opens a page.",
      ),
  })
  .partial();

const computerUseSchema = z
  .object({
    enabled: z
      .boolean()
      .describe("Let agents use apps on this Mac, except blocked apps."),
    show_agent_cursor: z
      .boolean()
      .describe(
        "Show each agent's cursor while it uses an app or the in-app browser.",
      ),
    blocked_apps: z
      .array(z.string().max(255))
      .max(256)
      .describe(
        "Bundle IDs of apps agents may never see or control. Zeros itself is always blocked.",
      ),
  })
  .partial();

const simulatorsSchema = z
  .object({
    enabled: z
      .boolean()
      .describe("Let agents use the iOS and Android simulators in Zeros."),
    idle_shutdown: z
      .enum(SIMULATOR_IDLE_SHUTDOWN_CHOICES)
      .describe(
        "Shut down simulators Zeros booted after this long without use. Simulators booted outside Zeros are never shut down.",
      ),
    show_agent_touches: z
      .boolean()
      .describe("Show where the agent touches while it uses a simulator."),
  })
  .partial();

export const userSettingsSchema = repoSettingsSchema.extend({
  preferences: personalPreferencesSchema.optional(),
  preferences_version: z.literal(1).optional(),
  agent_preferences_version: z.literal(1).optional(),
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
      'Gitignored files matching these patterns are seeded into each new worktree (e.g. ".env*"). Gitignore syntax, including "!" to exclude. Set here for every project, or in a repo\'s .zeros/settings.local.toml for one project; a repo-root .worktreeinclude file, if present, takes precedence over both.',
    ),
  mcp: mcpSchema.optional(),
  models: modelsSchema.optional(),
  workspaces: workspacesSchema.optional(),
  browser: browserSchema.optional(),
  computer_use: computerUseSchema.optional(),
  simulators: simulatorsSchema.optional(),
  tool_approvals_enabled: z.boolean().optional(),
  github: githubSchema.optional(),
  providers: z.record(z.string(), providerSchema).optional(),
});

export const repoLocalSettingsSchema = userSettingsSchema
  .omit({
    preferences: true,
    preferences_version: true,
    agent_preferences_version: true,
    env: true,
    env_files: true,
    models: true,
    browser: true,
    computer_use: true,
    simulators: true,
    tool_approvals_enabled: true,
    providers: true,
    github: true,
  })
  .extend({
    settings_version: z.literal(2).optional(),
    settings_migration_notes: z.array(z.string()).optional(),
  })
  .strict();

/** A single checkout's override cannot change provisioning for other workspaces. */
export const workspaceLocalSettingsSchema = repoLocalSettingsSchema.omit({
  file_include_globs: true,
  workspaces: true,
});

export const managedSettingsSchema = userSettingsSchema;

export type RepoSettingsDoc = z.infer<typeof repoSettingsSchema>;
export type UserSettingsDoc = z.infer<typeof userSettingsSchema>;

export type RawSettingsDoc = Record<string, unknown>;

export type SettingsLayerName =
  | "default"
  | "user"
  | "team"
  | "repo"
  | "repo-local"
  | "workspace-local"
  | "managed";

/** Team and shared repository layers cannot set these personal keys, including agent credentials, executables and gateways; repo-local may still set `workspaces.path`. */
export const USER_ONLY_KEYS = [
  "preferences",
  "preferences_version",
  "agent_preferences_version",
  "models",
  "workspaces",
  "browser",
  "computer_use",
  "simulators",
  "tool_approvals_enabled",
  "github",
  "providers",
] as const;
const USER_ONLY_BY_LAYER: Record<string, readonly string[]> = {
  team: USER_ONLY_KEYS,
  repo: USER_ONLY_KEYS,
  "repo-local": [
    "preferences",
    "preferences_version",
    "agent_preferences_version",
    "models",
    "browser",
    "computer_use",
    "simulators",
    "tool_approvals_enabled",
    "providers",
    "github",
  ],
  "workspace-local": [
    "preferences",
    "preferences_version",
    "agent_preferences_version",
    "models",
    "browser",
    "computer_use",
    "simulators",
    "tool_approvals_enabled",
    "providers",
    "workspaces",
    "github",
  ],
};

/** Legacy migration must not activate dormant MCP commands, environment overrides or copy rules. */
export const REPO_FILE_UNSUPPORTED_KEYS = [
  "env",
  "env_files",
  "mcp",
  "file_include_globs",
] as const;

/** Repo-local files can own MCP and copy rules, workspace files only MCP; environment settings stay out of repository layers. */
const REPO_UNSUPPORTED_BY_LAYER: Record<string, readonly string[]> = {
  repo: REPO_FILE_UNSUPPORTED_KEYS,
  "repo-local": ["env", "env_files"],
  "workspace-local": ["env", "env_files", "file_include_globs"],
};

const REPO_SCOPED_LAYERS: ReadonlySet<SettingsLayerName> = new Set([
  "repo",
  "repo-local",
  "workspace-local",
]);

/** Reject prototype-polluting keys when projecting untrusted parsed TOML. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}


export interface SanitizeResult {
  doc: RawSettingsDoc;
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? issue.message : "invalid value";
}

/** Validate fields separately so a bad value cannot discard its valid siblings. */
function sanitizeTable(
  shape: Record<string, z.ZodType>,
  value: unknown,
  basePath: string,
  warnings: string[],
  preserveUnknown = true,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    warnings.push(`${basePath}: expected a table — ignored`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    // Never treat inherited properties as schema entries.
    const field = hasOwn(shape, k) ? shape[k] : undefined;
    if (!field) {
      if (preserveUnknown) out[k] = v;
      else warnings.push(`${basePath}.${k}: unsupported key — ignored`);
      continue;
    }
    const r = field.safeParse(v);
    if (r.success) out[k] = r.data;
    else warnings.push(`${basePath}.${k}: ${firstIssue(r.error)} — ignored`);
  }
  return out;
}

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

function sanitizeModels(
  value: unknown,
  warnings: string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    warnings.push("models: expected a table — ignored");
    return undefined;
  }
  const modelShape: Record<string, z.ZodType> = modelsSchema.shape;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    if (key === "claude_code") {
      const table = sanitizeTable(
        claudeModelsSchema.shape,
        entry,
        "models.claude_code",
        warnings,
        false,
      );
      if (table) out[key] = table;
      continue;
    }
    if (key === "codex") {
      const table = sanitizeTable(
        codexModelsSchema.shape,
        entry,
        "models.codex",
        warnings,
        false,
      );
      if (table) out[key] = table;
      continue;
    }
    if (key === "favorites") {
      const favorites = sanitizeRecord(
        z.string(),
        entry,
        "models.favorites",
        warnings,
      );
      if (favorites) out[key] = favorites;
      continue;
    }
    if (key === "model_preferences") {
      if (!Array.isArray(entry)) {
        warnings.push("models.model_preferences: expected an array — ignored");
        continue;
      }
      const newestFirst: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      let excessValid = 0;
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        const candidate = entry[index];
        const parsed = modelPreferenceSchema.safeParse(candidate);
        if (!parsed.success) {
          warnings.push(
            `models.model_preferences.${index}: ${firstIssue(parsed.error)} — ignored`,
          );
          continue;
        }
        const identity = `${parsed.data.agent}\u0000${parsed.data.model}`;
        // The last valid row for an agent and exact model is authoritative.
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (newestFirst.length < 128) newestFirst.push(parsed.data);
        else excessValid += 1;
      }
      if (excessValid > 0) {
        warnings.push(
          `models.model_preferences: limited to the most recent 128 valid entries — ${excessValid} older entries ignored`,
        );
      }
      out[key] = newestFirst.reverse();
      continue;
    }
    if (key === "permission_preferences") {
      if (!Array.isArray(entry)) {
        warnings.push(
          "models.permission_preferences: expected an array — ignored",
        );
        continue;
      }
      const newestFirst: Array<Record<string, unknown>> = [];
      const seen = new Set<string>();
      let excessValid = 0;
      for (let index = entry.length - 1; index >= 0; index -= 1) {
        const parsed = permissionPreferenceSchema.safeParse(entry[index]);
        if (!parsed.success) {
          warnings.push(
            `models.permission_preferences.${index}: ${firstIssue(parsed.error)} — ignored`,
          );
          continue;
        }
        if (seen.has(parsed.data.agent)) continue;
        seen.add(parsed.data.agent);
        if (newestFirst.length < 32) newestFirst.push(parsed.data);
        else excessValid += 1;
      }
      if (excessValid > 0) {
        warnings.push(
          `models.permission_preferences: limited to the most recent 32 valid entries — ${excessValid} older entries ignored`,
        );
      }
      out[key] = newestFirst.reverse();
      continue;
    }
    const field = hasOwn(modelShape, key) ? modelShape[key] : undefined;
    if (!field) {
      out[key] = entry;
      continue;
    }
    const parsed = field.safeParse(entry);
    if (parsed.success) out[key] = parsed.data;
    else warnings.push(`models.${key}: ${firstIssue(parsed.error)} — ignored`);
  }
  return out;
}

/** Drop malformed entries without changing the registry order of valid servers. */
function sanitizeMcp(
  value: unknown,
  warnings: string[],
  preserveUnknown = true,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    warnings.push(`mcp: expected a table — ignored`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    if (k !== "servers") {
      if (preserveUnknown) out[k] = v;
      else warnings.push(`mcp.${k}: unsupported key — ignored`);
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
  workspaces: workspacesSchema.shape,
  browser: browserSchema.shape,
  computer_use: computerUseSchema.shape,
  simulators: simulatorsSchema.shape,
  github: githubSchema.shape,
  design: designSchema.shape,
};

/** Privileged control policy: unknown switches stay out of effective
 * settings until they have an explicit schema and review. */
const CLOSED_TABLES = new Set(["browser", "computer_use", "simulators"]);

const PERSONAL_DESIGN_BUILD_LAYERS: ReadonlySet<SettingsLayerName> = new Set([
  "user",
  "repo-local",
  "workspace-local",
]);

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
  const repositoryScoped = REPO_SCOPED_LAYERS.has(layer);
  const doc: RawSettingsDoc = {};
  let source: Record<string, unknown> = raw;
  if (!userOnly.includes("browser")) {
    const folded = foldRetiredAgentControl(raw, layer);
    source = folded.doc as Record<string, unknown>;
    warnings.push(...folded.warnings);
  }

  for (const [key, value] of Object.entries(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
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
    if (key === "settings_version" || key === "settings_migration_notes")
      continue;
    if (key === "preferences_version" || key === "agent_preferences_version") {
      if (value === 1) doc[key] = 1;
      continue;
    }
    if (key === "preferences") {
      const parsed = personalPreferencesSchema.safeParse(value);
      if (parsed.success) doc.preferences = parsed.data;
      else warnings.push("preferences: invalid app preferences — ignored");
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
    if (key === "file_include_globs") {
      // Report malformed copy patterns so seeding cannot silently fall back to defaults.
      if (!Array.isArray(value)) {
        warnings.push(
          `file_include_globs: expected an array of patterns — ignored`,
        );
        continue;
      }
      doc.file_include_globs = value.filter((g) => {
        if (typeof g === "string") return true;
        warnings.push(`file_include_globs: non-string entry — ignored`);
        return false;
      });
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
      const mcp = sanitizeMcp(value, warnings, !repositoryScoped);
      if (mcp) doc.mcp = mcp;
      continue;
    }
    if (key === "tool_approvals_enabled") {
      if (typeof value === "boolean") doc[key] = value;
      else
        warnings.push(`tool_approvals_enabled: expected a boolean — ignored`);
      continue;
    }
    if (key === "models") {
      const models = sanitizeModels(value, warnings);
      if (models) doc.models = models;
      continue;
    }
    if (key === "design") {
      let candidate = value;
      if (isPlainObject(value) && hasOwn(value, "isolation")) {
        warnings.push(
          "design.isolation: unsupported retired setting — ignored",
        );
        candidate = Object.fromEntries(
          Object.entries(value).filter(([nested]) => nested !== "isolation"),
        );
      }
      const table = sanitizeTable(
        designSchema.shape,
        candidate,
        key,
        warnings,
        !repositoryScoped,
      );
      // A tracked legacy file or policy layer cannot approve a build for the person.
      if (table && hasOwn(table, "style_builds") && !PERSONAL_DESIGN_BUILD_LAYERS.has(layer)) {
        delete table.style_builds;
        warnings.push(
          `design.style_builds: build commands are read only from your own settings — ignored in ${layer} settings`,
        );
      }
      if (table && Object.keys(table).length > 0) doc[key] = table;
      continue;
    }
    const shape = hasOwn(TABLE_SHAPES, key) ? TABLE_SHAPES[key] : undefined;
    if (shape) {
      const table = sanitizeTable(
        shape,
        value,
        key,
        warnings,
        !repositoryScoped && !CLOSED_TABLES.has(key),
      );
      if (table) doc[key] = table;
      continue;
    }
    if (repositoryScoped)
      warnings.push(`${key}: unsupported key — ignored in ${layer} settings`);
    else doc[key] = value;
  }

  return { doc, warnings };
}
