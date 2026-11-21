// Cloud projects and GitHub at two levels (control plane with ready copies on).
// A control plane without them answers 404, which callers treat as "not
// available". There is no step that adds a repository to the cloud: a
// connection lists what it can read, and a project picks from that.
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
const ProjectRepositorySchema = z.object({ repository: z.string().max(201), repositoryId: z.string().max(20), connectionId: uuid.nullable(),
  defaultBranch: z.string().max(255).nullable(), setup: z.string().max(8_000).nullable(), setupScript: z.string().max(512).nullable(),
  position: z.number().int() }).passthrough();
export const CloudProjectSchema = z.object({
  id: uuid, name: z.string().max(100), level: z.enum(["organization", "personal"]), ownerUserId: uuid.nullable(), canEdit: z.boolean(),
  repositories: z.array(ProjectRepositorySchema).max(10), readyCopy: z.enum(["ready", "building"]).nullable().optional().catch(null),
}).passthrough();
export type CloudProject = z.infer<typeof CloudProjectSchema>;
const ProjectsSchema = z.object({ projects: z.array(CloudProjectSchema).max(5000), personalAllowed: z.boolean(), canCreateOrganization: z.boolean(),
  limits: z.object({ personal: z.number().int(), repositories: z.number().int() }).passthrough() }).passthrough();
export type CloudProjects = z.infer<typeof ProjectsSchema>;
/** The one-repository project a repository's cloud settings belong to: the organization's first, then the caller's own. */
export const projectForRepository = (projects: CloudProjects | null | undefined, repository: string | null | undefined): CloudProject | null => {
  const name = repository?.toLowerCase();
  const matches = (projects?.projects ?? []).filter(project => project.repositories.length === 1 && project.repositories[0]!.repository === name);
  return matches.find(project => project.level === "organization") ?? matches[0] ?? null;
};
const DrawerSchema = z.object({
  connection: CloudGithubLevelConnectionSchema,
  repositories: z.array(z.object({ id: z.string().max(20), repository: z.string().max(201), defaultBranch: z.string().max(512), private: z.boolean(),
    /** The caller's projects that use it: the organization's and their own. */
    projects: z.array(z.object({ id: uuid, name: z.string().max(100) }).passthrough()).max(5000).catch([]) }).passthrough()).max(100),
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
export const getCloudProjects = (organizationId: string) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-projects`, ProjectsSchema);
/** "Share with the organization": an admin's own personal project becomes the organization's. */
export const shareCloudProject = (organizationId: string, projectId: string) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-projects/${uuid.parse(projectId)}/share`, z.object({ project: CloudProjectSchema }).passthrough(),
    { body: {}, idempotencyKey: key() });
export const setCloudPersonalProjectsAllowed = (organizationId: string, personalAllowed: boolean) =>
  cloudAccountRequest(`${base(organizationId)}/cloud-projects/settings`, z.object({ personalAllowed: z.boolean() }),
    { body: { personalAllowed }, idempotencyKey: key(), method: "PUT" });

const ReadyCopySchema = z.object({
  status: z.object({ state: z.enum(["none", "getting_ready", "ready", "updating", "update_failed", "failed"]).catch("none"),
    updatedAt: z.string().nullable(), nextUpdateAt: z.string().nullable(),
    failure: z.object({ reason: z.string().max(64), repository: z.string().max(201).nullable().catch(null), step: z.string().max(32).nullable().catch(null),
      detail: z.string().max(1100).nullable(), failures: z.number().int(), nextRetryAt: z.string().nullable() }).passthrough().optional(),
  }).passthrough(),
  history: z.array(z.object({ generation: z.number().int(), state: z.enum(["building", "ready", "failed", "retired"]), startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(), trigger: z.string().nullable(), startedBy: z.string().nullable(),
    /** What each repository was cloned at; null until the generation is ready. */
    repositories: z.array(z.object({ repository: z.string().max(201), branch: z.string().max(255).nullable(), commit: z.string().max(40).nullable() }).passthrough())
      .max(10).nullable().catch(null),
    failure: z.object({ reason: z.string(), repository: z.string().max(201).nullable().catch(null), step: z.string().max(32).nullable().catch(null),
      detail: z.string().nullable() }).nullable(), output: z.boolean() }).passthrough()).max(50).optional(),
  canBuild: z.boolean().optional(),
}).passthrough();
export type CloudReadyCopy = z.infer<typeof ReadyCopySchema>;
const projectPath = (organizationId: string, projectId: string) => `${base(organizationId)}/cloud-projects/${uuid.parse(projectId)}`;
export const getCloudReadyCopy = (organizationId: string, projectId: string) =>
  cloudAccountRequest(`${projectPath(organizationId, projectId)}/ready-copy`, ReadyCopySchema);
export const getCloudReadyCopyOutput = async (organizationId: string, projectId: string, generation: number) =>
  (await cloudAccountRequest(`${projectPath(organizationId, projectId)}/ready-copy/output?generation=${generation}`,
    z.object({ output: z.string().max(20_000) }))).output;
export const buildCloudReadyCopy = (organizationId: string, projectId: string) =>
  cloudAccountRequest(`${projectPath(organizationId, projectId)}/ready-copy/build`, z.unknown(), { body: {}, idempotencyKey: key() });
/** Retry now from a failure line: a new generation whatever the backoff. */
export const retryCloudReadyCopy = (organizationId: string, projectId: string) =>
  cloudAccountRequest(`${projectPath(organizationId, projectId)}/ready-copy/retry`, z.unknown(), { body: {}, idempotencyKey: key() });
const BuildSecretNamesSchema = z.object({ names: z.array(z.string().max(128)).max(64) });
/** A project's build secret names; values never come back. */
export const getCloudBuildSecretNames = async (organizationId: string, projectId: string) =>
  (await cloudAccountRequest(`${projectPath(organizationId, projectId)}/build-secrets`, BuildSecretNamesSchema)).names;
export const updateCloudBuildSecrets = async (organizationId: string, projectId: string, change: { set?: Record<string, string>; remove?: string[] }) =>
  (await cloudAccountRequest(`${projectPath(organizationId, projectId)}/build-secrets`, BuildSecretNamesSchema,
    { body: change, idempotencyKey: key(), method: "PATCH" })).names;
