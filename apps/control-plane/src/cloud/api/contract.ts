import { z } from "zod";
import { HttpError } from "../../authz.js";
import { CLOUD_V2_MAX_PROMPT_BYTES, CloudV2PromptIdSchema, CloudV2SessionNameSchema } from "../prompt-contract.js";
import { CloudWorkspaceCreateSchema } from "../workspace-create.js";
import { CloudEnvironmentMaterialSchema } from "../environment-contract.js";

export const ApiPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
});
const includeArchived = z.union([z.boolean(), z.enum(["true", "false"])]).default(false).transform(value => value === true || value === "true");
export const ApiWorkspaceListSchema = ApiPageSchema.extend({
  state: z.enum(["creating", "starting", "running", "stopping", "stopped", "failed", "deleting", "deleted"]).optional(),
  repository: CloudWorkspaceCreateSchema.shape.repository.optional(),
  name: z.string().max(200).optional(), includeArchived,
}).strict();
export const ApiSessionListSchema = ApiPageSchema.extend({ includeArchived }).strict();
export const ApiMessageListSchema = ApiPageSchema.extend({ after: CloudV2PromptIdSchema.optional() }).strict();
const selection = { agent: z.enum(["codex", "claude", "cursor"]), model: z.string().min(1).max(256).optional(),
  effort: z.string().min(1).max(64).optional() };
const message = z.string().min(1).max(CLOUD_V2_MAX_PROMPT_BYTES);
const name = z.string().trim().min(1).max(120);
const sessionName = CloudV2SessionNameSchema.transform(value => value.trim());
const environmentLimits = { entries: 50, valueBytes: 8 * 1024, totalBytes: 64 * 1024 };
// Validate the raw map: Zod records discard __proto__ before key validation.
const environment = z.unknown().superRefine((value, ctx) => {
  const parsed = CloudEnvironmentMaterialSchema.safeParse({ variables: value, files: [] });
  if (!parsed.success) { ctx.addIssue({ code: "custom", message: "Invalid workspace environment" }); return; }
  const values = Object.values(parsed.data.variables).map(value => Buffer.byteLength(value));
  if (values.length > environmentLimits.entries || values.some(bytes => bytes > environmentLimits.valueBytes) ||
    values.reduce((total, bytes) => total + bytes, 0) > environmentLimits.totalBytes)
    ctx.addIssue({ code: "custom", message: "Workspace environment exceeds its limits" });
}).transform(value => Object.fromEntries(Object.entries(value as Record<string, string>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
  .meta({ type: "object", maxProperties: environmentLimits.entries, additionalProperties: { type: "string", maxLength: environmentLimits.valueBytes } });
export const ApiWorkspaceCreateSchema = CloudWorkspaceCreateSchema.omit({ organizationId: true }).extend({
  ...selection, agent: selection.agent.optional(), message: message.optional(), messageId: CloudV2PromptIdSchema.optional(),
  sessionName: sessionName.optional(), env: environment.optional(),
}).strict().refine(value => value.message === undefined || value.agent !== undefined)
  .refine(value => value.message !== undefined || value.messageId === undefined && value.sessionName === undefined);
export const ApiSessionCreateSchema = z.object({ workspaceId: z.string().uuid(), ...selection, message,
  name: sessionName.optional(), sessionId: CloudV2PromptIdSchema.optional(), messageId: CloudV2PromptIdSchema.optional() }).strict();
export const ApiMessageSendSchema = z.object({ message, messageId: CloudV2PromptIdSchema.optional() }).strict();
export const ApiRenameSchema = z.object({ name }).strict();
export const ApiSessionRenameSchema = z.object({ name: sessionName }).strict();
export type ApiPage = z.infer<typeof ApiPageSchema>;
export type ApiWorkspaceList = z.infer<typeof ApiWorkspaceListSchema>;
export type ApiMessageList = z.infer<typeof ApiMessageListSchema>;
export type ApiWorkspaceCreate = z.infer<typeof ApiWorkspaceCreateSchema>;
export type ApiSessionCreate = z.infer<typeof ApiSessionCreateSchema>;
export type ApiMessageSend = z.infer<typeof ApiMessageSendSchema>;
export type ApiSessionList = z.infer<typeof ApiSessionListSchema>;

export function apiInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new HttpError(400, "invalid_request", "Invalid API request");
  return parsed.data;
}
export function apiPage<T>(rows: T[], page: ApiPage): { data: T[]; offset: number; hasMore: boolean } {
  return { data: rows.slice(0, page.limit), offset: page.offset, hasMore: rows.length > page.limit };
}
