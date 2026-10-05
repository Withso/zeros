import { z } from "zod";

// Mirrored by the independently deployed control plane's Zod 3 contract.
export const CLOUD_COMPUTER_V2_MAX_SCRIPT_BYTES = 16_384;
export const CLOUD_COMPUTER_V2_MAX_LOG_ROW_BYTES = 8_192;
export const CLOUD_COMPUTER_V2_MAX_LOG_BYTES = 1_048_576;
export const CLOUD_COMPUTER_V2_MAX_REQUEST_BYTES = 262_144;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const revision = z.number().int().nonnegative().safe();
const name = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);
const environmentName = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
  .refine(
    (value) =>
      !["ZEROS_", "CONDUCTOR_", "LD_", "DYLD_", "GIT_"].some((prefix) =>
        value.startsWith(prefix),
      ) &&
      ![
        "BASHOPTS",
        "SHELLOPTS",
        "PROMPT_COMMAND",
        "PS4",
        "NODE_REPL_EXTERNAL_MODULE",
        "SSH_ASKPASS",
        "PAGER",
        "EDITOR",
        "VISUAL",
        "NODE_TLS_REJECT_UNAUTHORIZED",
        "NODE_USE_ENV_PROXY",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_API_URL",
        "ANTHROPIC_BEDROCK_BASE_URL",
        "ANTHROPIC_VERTEX_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "GOOGLE_GEMINI_BASE_URL",
        "GOOGLE_VERTEX_BASE_URL",
        "BASH_ENV",
        "ENV",
        "HOME",
        "PATH",
        "NODE_OPTIONS",
        "NODE_PATH",
        "PYTHONSTARTUP",
        "RUBYOPT",
        "PERL5OPT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NODE_EXTRA_CA_CERTS",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
      ].includes(value),
  );
const ref = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) &&
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.includes("..") &&
      !value.includes("//") &&
      !value.includes("@{") &&
      !value
        .split("/")
        .some((part) => part.startsWith(".") || part.endsWith(".lock")),
  );

export const CloudComputerV2RepositorySchema = z
  .object({
    /** GitHub's canonical numeric repository ID, validated with the actor's source proof. */
    id: z.string().regex(/^[1-9][0-9]{0,39}$/),
    owner: name,
    name,
    installationId: z.string().uuid(),
    requestedRef: ref.nullable().default(null),
  })
  .strict();
export type CloudComputerV2Repository = z.infer<
  typeof CloudComputerV2RepositorySchema
>;
/** Repositories available in the immutable active template, in configured order. */
export const CloudComputerV2ActiveRepositorySchema = CloudComputerV2RepositorySchema.omit({ requestedRef: true });
export type CloudComputerV2ActiveRepository = z.infer<typeof CloudComputerV2ActiveRepositorySchema>;
export const CloudComputerV2EnvironmentOperationSchema = z.discriminatedUnion(
  "op",
  [
    z
      .object({
        op: z.literal("set"),
        name: environmentName,
        value: z
          .string()
          .min(1)
          .max(65_536)
          .refine((value) => !value.includes("\0") && bytes(value) <= 65_536),
      })
      .strict(),
    z.object({ op: z.literal("remove"), name: environmentName }).strict(),
    z.object({ op: z.literal("preserve"), name: environmentName }).strict(),
  ],
);
export type CloudComputerV2EnvironmentOperation = z.infer<
  typeof CloudComputerV2EnvironmentOperationSchema
>;
export const CloudComputerV2DraftInputSchema = z
  .object({
    repositories: z
      .array(CloudComputerV2RepositorySchema)
      .max(20)
      .refine(
        (rows) =>
          new Set(rows.map((row) => row.id)).size === rows.length &&
          new Set(
            rows.map(
              (row) => `${row.owner.toLowerCase()}/${row.name.toLowerCase()}`,
            ),
          ).size === rows.length,
      ),
    installScript: z
      .string()
      .max(CLOUD_COMPUTER_V2_MAX_SCRIPT_BYTES)
      .refine(
        (value) =>
          !value.includes("\0") &&
          bytes(value) <= CLOUD_COMPUTER_V2_MAX_SCRIPT_BYTES,
      ),
    timeoutSeconds: z.number().int().min(1).max(900),
    /** Omission preserves all exact binding versions. Remove never revokes a binding. */
    environment: z
      .array(CloudComputerV2EnvironmentOperationSchema)
      .max(128)
      .refine(
        (rows) => new Set(rows.map((row) => row.name)).size === rows.length,
      )
      .optional(),
  })
  .strict();
export type CloudComputerV2DraftInput = z.infer<
  typeof CloudComputerV2DraftInputSchema
>;
export const CloudComputerV2SaveDraftSchema =
  CloudComputerV2DraftInputSchema.extend({ expectedRevision: revision });
export const CloudComputerV2RevisionSchema = z
  .object({ expectedRevision: revision })
  .strict();
export const CloudComputerV2BuildRequestSchema = z
  .object({
    expectedRevision: revision,
    operationId: z.string().uuid(),
    draft: CloudComputerV2DraftInputSchema.optional(),
  })
  .strict();
export const CloudComputerV2VersionRequestSchema = z
  .object({ expectedRevision: revision, operationId: z.string().uuid() })
  .strict();
export const CloudComputerV2RepositorySetupSchema = z.object({
  expectedSettingsVersion: revision,
  operationId: z.string().uuid(),
  script: z.string().max(CLOUD_COMPUTER_V2_MAX_SCRIPT_BYTES).refine(
    value => !value.includes("\0") && bytes(value) <= CLOUD_COMPUTER_V2_MAX_SCRIPT_BYTES,
  ),
  timeoutSeconds: z.number().int().min(1).max(900),
}).strict();
export type CloudComputerV2RepositorySetupRequest = z.infer<typeof CloudComputerV2RepositorySetupSchema>;
export type CloudComputerV2RepositorySetupResult = { repositoryId: string; version: number };
export const CloudComputerV2AdminWorkspaceRequestSchema = z
  .object({ expectedActiveVersion: z.number().int().positive().safe(), operationId: z.string().uuid() })
  .strict();
export type CloudComputerV2AdminWorkspaceRequest = z.infer<typeof CloudComputerV2AdminWorkspaceRequestSchema>;
/** Server-owned metadata; clients cannot opt a workspace into admin authority. */
export const CloudComputerAdminWorkspaceSchema = z.object({ creatorUserId: z.string().uuid() }).strict();
export const CloudComputerV2BuildStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "superseded",
]);
export type CloudComputerV2BuildState = z.infer<
  typeof CloudComputerV2BuildStateSchema
>;
export const CloudComputerV2BuildStageSchema = z.enum([
  "queued",
  "allocating",
  "runtime",
  "repositories",
  "install",
  "integrity",
  "sanitation",
  "stopping",
  "capture_confirmed",
  "done",
]);
export type CloudComputerV2BuildStage = z.infer<
  typeof CloudComputerV2BuildStageSchema
>;
export const CloudComputerV2BuildErrorSchema = z.enum([
  "allocation_failed",
  "runtime_unavailable",
  "runtime_install_failed",
  "repository_access_denied",
  "repository_clone_failed",
  "install_failed",
  "integrity_failed",
  "tcb_modified",
  "sanitation_failed",
  "template_stop_failed",
  "template_capture_failed",
  "build_timeout",
  "build_failed",
]);
export type CloudComputerV2BuildError = z.infer<
  typeof CloudComputerV2BuildErrorSchema
>;
export const CloudComputerV2TemplateStateSchema = z.enum([
  "pending",
  "ready",
  "retiring",
  "retired",
  "quarantined",
]);
export type CloudComputerV2TemplateState = z.infer<
  typeof CloudComputerV2TemplateStateSchema
>;
export const CloudComputerV2RepositoryManifestSchema = z
  .array(
    z
      .object({
        id: z.string().regex(/^[1-9][0-9]{0,39}$/),
        owner: name,
        name,
        sha: z.string().regex(/^[a-f0-9]{40}$/),
      })
      .strict(),
  )
  .max(20)
  .refine((rows) => new Set(rows.map((row) => row.id)).size === rows.length);
export type CloudComputerV2RepositoryManifest = z.infer<
  typeof CloudComputerV2RepositoryManifestSchema
>;

export type CloudComputerV2BuildSummary = {
  id: string;
  version: number;
  configId: string;
  acceptedRevision: number;
  state: CloudComputerV2BuildState;
  stage: CloudComputerV2BuildStage;
  errorCode: CloudComputerV2BuildError | null;
  rebuiltFromBuildId: string | null;
  templateState: CloudComputerV2TemplateState | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelRequestedAt: string | null;
};
export type CloudComputerV2Draft = {
  configId: string | null;
  repositories: CloudComputerV2Repository[];
  installScript: string;
  timeoutSeconds: number;
  environment: Array<{ name: string; set: boolean }>;
};
export type CloudComputerV2State = {
  state: "not_built" | "building" | "active" | "failed";
  revision: number;
  draft: CloudComputerV2Draft;
  active: CloudComputerV2BuildSummary | null;
  activeRepositories: CloudComputerV2ActiveRepository[];
  previous: CloudComputerV2BuildSummary | null;
  latestBuild: CloudComputerV2BuildSummary | null;
  unbuiltChanges: boolean;
  history: { builds: CloudComputerV2BuildSummary[]; nextCursor: string | null };
  canManage: boolean;
};
export type CloudComputerV2DraftResult = {
  revision: number;
  configId: string;
  unbuiltChanges: boolean;
};
export type CloudComputerV2BuildResult = {
  revision: number;
  build: CloudComputerV2BuildSummary;
  replayed: boolean;
};
export type CloudComputerV2ActivateResult = {
  revision: number;
  activeBuildId: string;
  activated: true;
  replayed: boolean;
};
export type CloudComputerV2CancelResult = {
  revision: number;
  build: CloudComputerV2BuildSummary;
  cancelled: boolean;
  cancelRequested: boolean;
  alreadyCompleted: boolean;
};
export type CloudComputerV2BuildLogs = {
  entries: Array<{
    seq: number;
    stream: "stdout" | "stderr" | "system";
    stage: CloudComputerV2BuildStage;
    text: string;
    createdAt: string;
  }>;
  firstSeq: number | null;
  lastSeq: number | null;
  nextAfter: number;
  truncated: boolean;
  complete: boolean;
};
