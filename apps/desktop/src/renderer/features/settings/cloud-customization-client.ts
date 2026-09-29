import { z } from "zod";
import { CloudSkillSchema, type CloudMcpServer } from "@zeros/protocol/cloud-customization";
import { cloudAccountRequest } from "../../platform/cloud-workspaces";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { getOrganizationStoreGeneration } from "../team/team-store";

const server = z.object({ id: z.string().uuid(), name: z.string(), transport: z.enum(["stdio", "http", "sse"]), command: z.string().optional(),
  args: z.array(z.string()).optional(), cwd: z.string().optional(), url: z.string().optional(), secretRef: z.string().uuid().nullable(),
  envKeys: z.array(z.string()), headerKeys: z.array(z.string()) }).strict();
export const CloudCustomizationViewSchema = z.object({ revision: z.number().int().nonnegative(), servers: z.array(server).max(32),
  skills: z.array(CloudSkillSchema).max(32), cursorTeamSettings: z.literal("disabled") }).strict();
export const CloudCustomizationSettingsSchema = z.object({ organization: CloudCustomizationViewSchema, member: CloudCustomizationViewSchema,
  canManage: z.boolean(), oauth: z.literal("unsupported"), cursorTeamSettings: z.literal("unsupported") }).strict();
export type CloudCustomizationView = z.infer<typeof CloudCustomizationViewSchema>;
export type CloudCustomizationSettings = z.infer<typeof CloudCustomizationSettingsSchema>;
export type CloudCustomizationDocument = { servers: (CloudMcpServer & { id: string })[]; skills: z.infer<typeof CloudSkillSchema>[]; cursorTeamSettings: "disabled" };
function reconcileRows<T>(previous: T[], next: T[], key: (row: T) => string): T[] {
  const byKey = new Map(previous.map(row => [key(row), row]));
  const rows = next.map(row => {
    const prior = byKey.get(key(row));
    return prior && JSON.stringify(prior) === JSON.stringify(row) ? prior : row;
  });
  return rows.length === previous.length && rows.every((row, i) => row === previous[i]) ? previous : rows;
}
function reconcileScope(previous: CloudCustomizationView, next: CloudCustomizationView): CloudCustomizationView {
  const servers = reconcileRows(previous.servers, next.servers, row => row.id);
  const skills = reconcileRows(previous.skills, next.skills, row => row.name);
  if (servers === previous.servers && skills === previous.skills && next.revision === previous.revision && next.cursorTeamSettings === previous.cursorTeamSettings) return previous;
  return servers === next.servers && skills === next.skills ? next : { ...next, servers, skills };
}
export const cloudCustomizationCache = new KeyedAsyncCache<CloudCustomizationSettings>({ maxEntries: 32, maxWeight: 4 * 1024 * 1024,
  weightOf: value => JSON.stringify(value).length,
  reconcile: (previous, next) => {
    if (!previous) return next;
    const organization = reconcileScope(previous.organization, next.organization), member = reconcileScope(previous.member, next.member);
    if (organization === previous.organization && member === previous.member && next.canManage === previous.canManage && next.oauth === previous.oauth && next.cursorTeamSettings === previous.cursorTeamSettings) return previous;
    return organization === next.organization && member === next.member ? next : { ...next, organization, member };
  },
});
export const cloudCustomizationKey = (user: string, org: string) => JSON.stringify([user, org, getOrganizationStoreGeneration()]);
const root = (org: string) => `/v1/organizations/${z.string().uuid().parse(org)}/customization`;
export const readCloudCustomization = (org: string) => cloudAccountRequest(root(org), CloudCustomizationSettingsSchema);
export function prefetchCloudCustomization(user: string, org: string) {
  void cloudCustomizationCache.load(cloudCustomizationKey(user, org), () => readCloudCustomization(org), { maxAgeMs: 30000 }).catch(() => undefined);
}
export function customizationDocument(view: CloudCustomizationView): CloudCustomizationDocument {
  return { skills: view.skills, cursorTeamSettings: "disabled", servers: view.servers.map(({ secretRef: _secretRef, envKeys: _envKeys, headerKeys: _headerKeys, ...server }) => server as CloudMcpServer & { id: string }) };
}
export async function saveCloudCustomization(org: string, scope: "organization" | "member", expectedRevision: number, document: CloudCustomizationDocument) {
  return cloudAccountRequest(`${root(org)}/${scope}`, CloudCustomizationViewSchema, { method: "PUT", body: { expectedRevision, document }, idempotencyKey: crypto.randomUUID() });
}
