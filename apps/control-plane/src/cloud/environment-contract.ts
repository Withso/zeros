// Standalone deployment mirror of protocol/cloud-workspace-environment; acceptance is tested.
import { z } from "zod";
import { isCredentialRedirectEnvName, isDangerousEnvName } from "./environment-names.js";

export const CLOUD_ENVIRONMENT_LIMITS = { variables: 128, nameBytes: 128, valueBytes: 16 * 1024,
  files: 16, fileBytes: 64 * 1024, totalBytes: 256 * 1024, pathBytes: 512, heads: 128 } as const;
export const CLOUD_ENVIRONMENT_ERRORS = ["cloud_environment_invalid", "cloud_environment_reserved", "cloud_environment_variable_limit",
  "cloud_environment_value_limit", "cloud_environment_file_limit", "cloud_environment_total_limit", "cloud_environment_path_invalid"] as const;
export type CloudEnvironmentValidationCode = typeof CLOUD_ENVIRONMENT_ERRORS[number];
export interface CloudEnvironmentMaterial { variables: Record<string, string>; files: Array<{ path: string; content: string }> }
export interface CloudEnvironmentPatch {
  expectedRevision: number; clear?: boolean; variables?: Record<string, string | null>; files?: Array<{ path: string; content: string | null }>;
}
export interface CloudWorkspaceEnvironment extends CloudEnvironmentMaterial { versionId: string; repositoryId: string }

const bytes = (value: string) => new TextEncoder().encode(value).length;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const matches = (pattern: RegExp, value: string) => pattern.exec(value)?.[0] === value;
const runtime = new Set(["PATH", "HOME", "SHELL", "USER", "LOGNAME", "PWD", "OLDPWD", "TERM", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TZ",
  "NODE_ENV", "NODE_TLS_REJECT_UNAUTHORIZED", "NO_PROXY", "BROWSER", "SSH_AUTH_SOCK", "PROMPT_COMMAND", "PS1", "PS2"]);

/** App values cannot select the worker's startup, credential or routing authority. */
export function isCloudReservedEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return isDangerousEnvName(upper) || isCredentialRedirectEnvName(name) || isCredentialRedirectEnvName(upper) || runtime.has(upper) ||
    /^(?:GH_|GITHUB_|GIT_|CLOUD_V2_|ZEROS_|COORDINATE_|ANTHROPIC_|CLAUDE_|CODEX_|CURSOR_|OPENAI_|LC_|XDG_)/.test(upper) ||
    ["__proto__", "prototype", "constructor"].includes(name);
}

export function isCloudEnvironmentPath(value: string): boolean {
  return bytes(value) <= CLOUD_ENVIRONMENT_LIMITS.pathBytes &&
    matches(/^(?:[A-Za-z0-9_.-]+\/)*\.env(?:\.[A-Za-z0-9_.-]+)?$/, value) &&
    value.split("/").length <= 16 && !value.split("/").some(part => [".", "..", ".git", ".zeros", ".context", ".context-graph", ".local", "node_modules"].includes(part));
}

function valuesIssue(value: unknown, nullable: boolean): CloudEnvironmentValidationCode | undefined {
  if (!record(value)) return "cloud_environment_invalid";
  if (Object.keys(value).length > CLOUD_ENVIRONMENT_LIMITS.variables) return "cloud_environment_variable_limit";
  for (const [name, content] of Object.entries(value)) {
    if (!matches(/^[A-Za-z_][A-Za-z0-9_]*$/, name) || bytes(name) > CLOUD_ENVIRONMENT_LIMITS.nameBytes) return "cloud_environment_invalid";
    if (isCloudReservedEnvironmentName(name)) return "cloud_environment_reserved";
    if (nullable && content === null) continue;
    if (typeof content !== "string" || content.includes("\0")) return "cloud_environment_invalid";
    if (bytes(content) > CLOUD_ENVIRONMENT_LIMITS.valueBytes) return "cloud_environment_value_limit";
  }
}

function materialIssue(value: unknown, patch: boolean): CloudEnvironmentValidationCode | undefined {
  if (!record(value)) return "cloud_environment_invalid";
  const allowed = patch ? ["expectedRevision", "variables", "files", "clear"] : ["variables", "files"];
  if (Object.keys(value).some(key => !allowed.includes(key))) return "cloud_environment_invalid";
  if (patch && (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0 ||
    (value.clear !== undefined && typeof value.clear !== "boolean") || (value.clear === true && (value.variables !== undefined || value.files !== undefined)))) return "cloud_environment_invalid";
  const variables = patch && value.variables === undefined ? {} : value.variables;
  const issue = valuesIssue(variables, patch);
  if (issue) return issue;
  const files = patch && value.files === undefined ? [] : value.files;
  if (!Array.isArray(files)) return "cloud_environment_invalid";
  if (files.length > CLOUD_ENVIRONMENT_LIMITS.files) return "cloud_environment_file_limit";
  const seen = new Set<string>();
  let total = Object.entries(variables as Record<string, string | null>).reduce((sum, [name, content]) => sum + bytes(name) + bytes(content ?? ""), 0);
  for (const file of files) {
    if (!record(file) || Object.keys(file).some(key => key !== "path" && key !== "content") || typeof file.path !== "string" ||
      !isCloudEnvironmentPath(file.path) || seen.has(file.path)) return "cloud_environment_path_invalid";
    seen.add(file.path);
    if (!(patch && file.content === null)) {
      if (typeof file.content !== "string" || file.content.includes("\0")) return "cloud_environment_invalid";
      if (bytes(file.content) > CLOUD_ENVIRONMENT_LIMITS.fileBytes) return "cloud_environment_file_limit";
    }
    total += bytes(file.path) + bytes((file.content as string | null) ?? "");
  }
  if (total > CLOUD_ENVIRONMENT_LIMITS.totalBytes) return "cloud_environment_total_limit";
}

export const CloudEnvironmentMaterialSchema = z.unknown().superRefine((value, ctx) => {
  const issue = materialIssue(value, false);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
}).transform(value => value as CloudEnvironmentMaterial);
export const CloudEnvironmentPatchSchema = z.unknown().superRefine((value, ctx) => {
  const issue = materialIssue(value, true);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
}).transform(value => value as CloudEnvironmentPatch);

export const CloudEnvironmentRepositoryIdSchema = z.string().max(16).refine(value => matches(/^[1-9][0-9]*$/, value) && Number.isSafeInteger(Number(value)));
const versionId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/).refine(value => value.length === 36);
export const CloudWorkspaceEnvironmentSchema = z.object({
  versionId, repositoryId: CloudEnvironmentRepositoryIdSchema, variables: z.unknown(), files: z.unknown(),
}).strict().superRefine((value, ctx) => {
  const issue = materialIssue({ variables: value.variables, files: value.files }, false);
  if (issue) ctx.addIssue({ code: "custom", message: issue });
}).transform(value => value as CloudWorkspaceEnvironment);

export const CLOUD_ENVIRONMENT_SEED_ERRORS = ["cloud_environment_path_conflict", "cloud_environment_path_untracked_required",
  "cloud_environment_path_ignored_required", "cloud_environment_seed_uncertain", "cloud_environment_pin_changed", "cloud_environment_runtime_required"] as const;
export type CloudEnvironmentSeedError = typeof CLOUD_ENVIRONMENT_SEED_ERRORS[number];
export const CloudEnvironmentReportSchema = z.object({ versionId, sequence: z.number().int().positive().safe(),
  state: z.enum(["ready", "failed"]), errorCode: z.enum(CLOUD_ENVIRONMENT_SEED_ERRORS).optional(),
}).strict().refine(value => value.state === "failed" ? value.errorCode !== undefined : value.errorCode === undefined);
export type CloudEnvironmentReport = z.infer<typeof CloudEnvironmentReportSchema>;

export const CloudEnvironmentMetadataSchema = z.object({ repositoryId: CloudEnvironmentRepositoryIdSchema,
  revision: z.number().int().nonnegative().safe(), versionId: versionId.nullable(), updatedAt: z.string().nullable(),
  variables: z.array(z.object({ name: z.string(), bytes: z.number().int().nonnegative() }).strict()).max(CLOUD_ENVIRONMENT_LIMITS.variables),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative() }).strict()).max(CLOUD_ENVIRONMENT_LIMITS.files),
}).strict();
export type CloudEnvironmentMetadata = z.infer<typeof CloudEnvironmentMetadataSchema>;

export function cloudEnvironmentMetadata(repositoryId: string, revision: number, version: string | null, updatedAt: string | null,
  material: CloudEnvironmentMaterial): CloudEnvironmentMetadata {
  return { repositoryId, revision, versionId: version, updatedAt,
    variables: Object.entries(material.variables).map(([name, value]) => ({ name, bytes: bytes(value) })).sort((a, b) => a.name.localeCompare(b.name)),
    files: material.files.map(file => ({ path: file.path, bytes: bytes(file.content) })).sort((a, b) => a.path.localeCompare(b.path)) };
}
