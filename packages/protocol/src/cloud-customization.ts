import { z } from "zod";

const text = z.string().max(4096).refine(value => !value.includes("\0") && !/\$\{|\$[A-Za-z_]/.test(value));
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).refine(value =>
  !["design-draft", "cloud-computer", "zeros_workspace", "codex_apps", "__proto__", "constructor", "prototype"].includes(value));
const values = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/), text)
  .refine(value => Object.keys(value).length <= 32);
const url = z.string().max(2048).url().refine(value => {
  const parsed = new URL(value);
  return ["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
});
export const CloudMcpServerSchema = z.discriminatedUnion("transport", [
  z.object({ name, transport: z.literal("stdio"), command: text.min(1), args: z.array(text).max(64).optional(), env: values.optional(),
    cwd: z.string().max(2048).refine(value => value === "/srv/zeros/workspace" || (value.startsWith("/srv/zeros/workspace/") && !value.split("/").includes(".."))).optional() }).strict(),
  z.object({ name, transport: z.literal("http"), url, headers: values.optional() }).strict(),
  z.object({ name, transport: z.literal("sse"), url, headers: values.optional() }).strict(),
]);
export type CloudMcpServer = z.infer<typeof CloudMcpServerSchema>;
export const CloudSkillSchema = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  description: z.string().max(1000).refine(value => !value.includes("\0")).optional(),
  content: z.string().min(1).max(32768).refine(value => !value.includes("\0")) }).strict();
export const CloudRepositoryMcpSchema = z.array(CloudMcpServerSchema).max(32).refine(servers => new Set(servers.map(server => server.name)).size === servers.length);
/** Engine-only history encryption authority; never materialized in provider HOME. */
export const CloudCustomizationHistoryAuthoritySchema = z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/),
  currentKeyVersion: z.number().int().positive(), keys: z.record(z.string().regex(/^\d+$/), z.string().regex(/^[A-Za-z0-9_-]{43}$/)) }).strict();
export type CloudCustomizationHistoryAuthority = z.infer<typeof CloudCustomizationHistoryAuthoritySchema>;
export const CloudCustomizationSnapshotSchema = z.object({ version: z.literal(1), digest: z.string().regex(/^[a-f0-9]{64}$/),
  repositoryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  history: CloudCustomizationHistoryAuthoritySchema.optional(),
  servers: z.array(z.object({ server: CloudMcpServerSchema, scope: z.enum(["organization", "member", "repository"]),
    secretRef: z.string().uuid().nullable(), revision: z.number().int().nonnegative().safe() }).strict()).max(64),
  skills: z.array(CloudSkillSchema).max(64), cursorTeamSettings: z.literal("disabled") }).strict();
export type CloudCustomizationSnapshot = z.infer<typeof CloudCustomizationSnapshotSchema>;
export const CloudCustomizationOperationSchema = z.enum(["extensions.list", "skills.listZeros", "skills.saveZeros", "skills.removeZeros"]);
export type CloudCustomizationOperation = z.infer<typeof CloudCustomizationOperationSchema>;
const entry = z.object({ id: z.string().max(256), name: z.string().max(64), description: z.string().max(1000), sourcePath: z.literal(""),
  sourceId: z.enum(["organization", "member"]), status: z.literal("configured"), body: z.string().max(32768).optional(), revision: z.string().max(32).optional(), statusDetail: z.string().max(1000).optional() }).strict();
export const CloudCustomizationResultSchema = z.union([z.array(entry).max(32), entry, z.object({ ok: z.literal(true) }).strict(),
  z.object({ entries: z.array(entry).max(32), partial: z.boolean(), sources: z.array(z.object({ id: z.enum(["organization", "member"]), kind: z.literal("account"), state: z.enum(["complete", "unsupported"]) }).strict()).max(1), warnings: z.array(z.string().max(1000)).max(4) }).strict()]);
