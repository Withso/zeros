// GitHub at two levels (control plane with ready copies on). A control plane
// without them answers 404, which callers treat as "not available".
import { z } from "zod";
import { cloudAccountRequest } from "./cloud-workspaces";

const uuid = z.string().uuid();
const key = () => crypto.randomUUID();
export const CloudGithubLevelConnectionSchema = z.object({
  id: uuid, installationId: z.number().int().positive().nullable(), accountLogin: z.string().max(100),
  level: z.enum(["organization", "personal"]), state: z.enum(["active", "suspended", "uninstalled"]).catch("active"), mine: z.boolean(),
}).passthrough();
export type CloudGithubLevelConnection = z.infer<typeof CloudGithubLevelConnectionSchema>;
const ConnectionsSchema = z.object({ organization: z.array(CloudGithubLevelConnectionSchema).max(200), personal: z.array(CloudGithubLevelConnectionSchema).max(200),
  solo: z.boolean().catch(false) }).passthrough();
export type CloudGithubLevelConnections = z.infer<typeof ConnectionsSchema>;
export const CloudRepositoryEntrySchema = z.object({
  id: uuid, repository: z.string().max(201), repositoryId: z.string().max(20), level: z.enum(["shared", "private"]),
  connectionId: uuid.nullable(), createdAt: z.string(),
}).passthrough();
export type CloudRepositoryEntry = z.infer<typeof CloudRepositoryEntrySchema>;
const RepositoriesSchema = z.object({ shared: z.array(CloudRepositoryEntrySchema).max(1000), private: z.array(CloudRepositoryEntrySchema).max(100),
  personalAllowed: z.boolean() }).passthrough();
export type CloudRepositoryLevels = z.infer<typeof RepositoriesSchema>;
const DrawerSchema = z.object({
  connection: CloudGithubLevelConnectionSchema,
  repositories: z.array(z.object({ id: z.string().max(20), repository: z.string().max(201), defaultBranch: z.string().max(512), private: z.boolean(),
    added: z.enum(["shared", "private"]).nullable() }).passthrough()).max(100),
  nextPage: z.number().int().nullable(),
}).passthrough();
export type CloudGithubConnectionRepositories = z.infer<typeof DrawerSchema>;
const InstallationsSchema = z.object({ installations: z.array(z.object({ installationId: z.number().int().positive(), accountLogin: z.string().max(100),
  suspended: z.boolean() }).passthrough()).max(1000) }).passthrough();
export type CloudGithubVisibleInstallation = z.infer<typeof InstallationsSchema>["installations"][number];

const base = (organizationId: string) => `/v1/cloud-v2/organizations/${uuid.parse(organizationId)}`;

export const getCloudGithubLevelConnections = (organizationId: string) =>
  cloudAccountRequest(`${base(organizationId)}/github/connections`, ConnectionsSchema);
export const getCloudGithubVisibleInstallations = async (organizationId: string) =>
  (await cloudAccountRequest(`${base(organizationId)}/github/installations`, InstallationsSchema)).installations;
export const connectCloudGithubInstallation = (organizationId: string, installationId: number, level: "organization" | "personal") =>
  cloudAccountRequest(`${base(organizationId)}/github/connections`, z.object({ connection: CloudGithubLevelConnectionSchema }).passthrough(),
    { body: { installationId, level }, idempotencyKey: key() });
export const disconnectCloudGithubConnection = (organizationId: string, connectionId: string) =>
  cloudAccountRequest(`${base(organizationId)}/github/connections/${uuid.parse(connectionId)}`, z.unknown(), { body: {}, idempotencyKey: key(), method: "DELETE" });
export const getCloudGithubConnectionRepositories = (organizationId: string, connectionId: string, page = 1) =>
  cloudAccountRequest(`${base(organizationId)}/github/connections/${uuid.parse(connectionId)}/repositories?page=${page}`, DrawerSchema);
export const getCloudRepositoryLevels = (organizationId: string) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-repositories`, RepositoriesSchema);
export const addCloudRepository = (organizationId: string, repository: string, level: "shared" | "private", connectionId?: string) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-repositories`, z.object({ repository: CloudRepositoryEntrySchema }).passthrough(),
    { body: { repository, level, ...(connectionId ? { connectionId } : {}) }, idempotencyKey: key() });
export const shareCloudRepository = (organizationId: string, entryId: string) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-repositories/${uuid.parse(entryId)}/share`, z.object({ repository: CloudRepositoryEntrySchema }).passthrough(),
    { body: {}, idempotencyKey: key() });
export const setCloudPersonalRepositoriesAllowed = (organizationId: string, personalAllowed: boolean) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-repositories/settings`, z.object({ personalAllowed: z.boolean() }),
    { body: { personalAllowed }, idempotencyKey: key(), method: "PUT" });

const ReadyCopySchema = z.object({
  status: z.object({ state: z.enum(["none", "getting_ready", "ready", "updating", "update_failed", "failed"]).catch("none"),
    updatedAt: z.string().nullable(), nextUpdateAt: z.string().nullable(),
    failure: z.object({ reason: z.string().max(64), detail: z.string().max(1100).nullable(), failures: z.number().int(), nextRetryAt: z.string().nullable() }).passthrough().optional(),
  }).passthrough(),
  history: z.array(z.object({ generation: z.number().int(), state: z.enum(["building", "ready", "failed", "retired"]), startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(), commit: z.string().nullable(), branch: z.string().nullable(), trigger: z.string().nullable(), startedBy: z.string().nullable(),
    failure: z.object({ reason: z.string(), detail: z.string().nullable() }).nullable(), output: z.boolean() }).passthrough()).max(50).optional(),
  canBuild: z.boolean().optional(),
}).passthrough();
export type CloudReadyCopy = z.infer<typeof ReadyCopySchema>;
const copyQuery = (repository: string) => `repository=${encodeURIComponent(repository)}`;
export const getCloudReadyCopy = (organizationId: string, repository: string) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-repositories/ready-copy?${copyQuery(repository)}`, ReadyCopySchema);
export const getCloudReadyCopyOutput = async (organizationId: string, repository: string, generation: number) =>
  (await cloudAccountRequest(`${base(organizationId)}/cloud-repositories/ready-copy/output?${copyQuery(repository)}&generation=${generation}`,
    z.object({ output: z.string().max(20_000) }))).output;
export const buildCloudReadyCopy = (organizationId: string, repository: string) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-repositories/ready-copy/build`, z.unknown(), { body: { repository }, idempotencyKey: key() });
