import { z } from "zod";
import {
  CloudComputerV2BuildErrorSchema,
  CloudComputerV2BuildStageSchema,
  CloudComputerV2BuildStateSchema,
} from "./cloud-computer-v2";

// Mirrored by the independently deployed control plane's Zod 3 contract.
export const CLOUD_COMPUTER_TOOLS_VERSION = 1;
export const CLOUD_COMPUTER_TOOLS_SERVER = "cloud-computer";
export const CLOUD_COMPUTER_TOOL_MAX_RESPONSE_BYTES = 8_388_608;
const uuid = z.string().uuid();
const revision = z.number().int().nonnegative().safe();
const version = z.number().int().positive().safe();
const timeout = z.number().int().min(1).max(900);
const script = z.string().max(16_384).refine(value =>
  !value.includes("\0") && new TextEncoder().encode(value).byteLength <= 16_384);
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/);

export const ListComputersArgumentsSchema = z.object({}).strict();
export const GetComputerConfigurationArgumentsSchema = z.object({ computerId: uuid }).strict();
export const CreateComputerConfigurationArgumentsSchema = z.object({
  installScript: script,
  timeoutSeconds: timeout.optional(),
  expectedRevision: revision,
  previousBuildId: uuid.nullable(),
}).strict();
export const GetComputerBuildStatusArgumentsSchema = z.object({
  buildId: uuid,
  after: revision.optional(),
}).strict();
export const UpdateRepositorySetupScriptArgumentsSchema = z.object({
  repositoryId: uuid,
  expectedSettingsVersion: revision,
  script,
  timeoutSeconds: timeout,
}).strict();
export const CloudComputerToolArgumentsSchemas = {
  ListComputers: ListComputersArgumentsSchema,
  GetComputerConfiguration: GetComputerConfigurationArgumentsSchema,
  CreateComputerConfiguration: CreateComputerConfigurationArgumentsSchema,
  GetComputerBuildStatus: GetComputerBuildStatusArgumentsSchema,
  UpdateRepositorySetupScript: UpdateRepositorySetupScriptArgumentsSchema,
};
export const CloudComputerToolRequestSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("ListComputers"), arguments: ListComputersArgumentsSchema }).strict(),
  z.object({ name: z.literal("GetComputerConfiguration"), arguments: GetComputerConfigurationArgumentsSchema }).strict(),
  z.object({ name: z.literal("CreateComputerConfiguration"), arguments: CreateComputerConfigurationArgumentsSchema }).strict(),
  z.object({ name: z.literal("GetComputerBuildStatus"), arguments: GetComputerBuildStatusArgumentsSchema }).strict(),
  z.object({ name: z.literal("UpdateRepositorySetupScript"), arguments: UpdateRepositorySetupScriptArgumentsSchema }).strict(),
]);
export type CloudComputerToolRequest = z.infer<typeof CloudComputerToolRequestSchema>;
export const CloudComputerToolExecutionRequestSchema = z.object({
  kind: z.literal("computer-tool"),
  leaseId: uuid,
  // Native MCP session/request identity supplied by the engine, outside arguments.
  toolCallId: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/),
  tool: CloudComputerToolRequestSchema,
}).strict();
export type CloudComputerToolExecutionRequest = z.infer<typeof CloudComputerToolExecutionRequestSchema>;

export const CloudComputerToolConflictSchema = z.object({
  conflict: z.literal(true),
  revision,
  latestBuildId: uuid.nullable(),
}).strict();
export type CloudComputerToolConflict = z.infer<typeof CloudComputerToolConflictSchema>;
export const ListComputersResultSchema = z.object({
  computers: z.array(z.object({
    computerId: uuid,
    state: z.enum(["not_built", "building", "active", "failed"]),
    activeBuildId: uuid.nullable(),
    draftConfigId: uuid.nullable(),
    latestBuildId: uuid.nullable(),
    capabilities: z.object({
      computerToolsVersion: z.literal(1),
      configure: z.boolean(),
      updateRepositorySetupScript: z.boolean(),
    }).strict(),
  }).strict()).max(1),
}).strict();
export const ComputerRepositorySetupSchema = z.object({
  repositoryId: uuid.nullable(),
  owner: repositoryName,
  name: repositoryName,
  requestedRef: z.string().min(1).max(512).nullable(),
  settingsVersion: revision,
  setupCommands: z.array(z.object({ command: script, timeoutSeconds: timeout }).strict()).max(32),
}).strict();
export const GetComputerConfigurationResultSchema = z.object({
  computerId: uuid,
  configId: uuid.nullable(),
  revision,
  latestBuildId: uuid.nullable(),
  installScript: script,
  timeoutSeconds: timeout,
  repositories: z.array(ComputerRepositorySetupSchema).max(20),
  environment: z.array(z.object({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/), set: z.boolean(),
  }).strict()).max(128),
}).strict();
export const CreateComputerConfigurationResultSchema = z.object({
  revision, buildId: uuid, version,
}).strict();
export const GetComputerBuildStatusResultSchema = z.object({
  buildId: uuid,
  version,
  state: CloudComputerV2BuildStateSchema,
  stage: CloudComputerV2BuildStageSchema,
  errorCode: CloudComputerV2BuildErrorSchema.nullable(),
  activated: z.boolean(),
  lines: z.array(z.object({
    seq: version,
    line: revision,
    stream: z.enum(["stdout", "stderr", "system"]),
    stage: CloudComputerV2BuildStageSchema,
    text: z.string().max(8192),
  }).strict()).max(200),
  cursor: revision,
  truncated: z.boolean(),
  complete: z.boolean(),
}).strict();
export const UpdateRepositorySetupScriptResultSchema = z.object({ version }).strict();
export const CloudComputerToolResultSchemas = {
  ListComputers: ListComputersResultSchema,
  GetComputerConfiguration: GetComputerConfigurationResultSchema,
  CreateComputerConfiguration: CreateComputerConfigurationResultSchema,
  GetComputerBuildStatus: GetComputerBuildStatusResultSchema,
  UpdateRepositorySetupScript: UpdateRepositorySetupScriptResultSchema,
};
export type CloudComputerToolResult = z.infer<(typeof CloudComputerToolResultSchemas)[keyof typeof CloudComputerToolResultSchemas]>;
