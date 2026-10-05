// Read-only Alpha acceptance companion. Never writes provider/workspace state
// and never prints credentials, response bodies, participant identities or URLs.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseAgentEnv } from "../agent-env-check.mjs";

const ALPHA_ORIGIN = "https://api-alpha.zeros.build";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const Uuid = z.string().uuid();
const Role = z.enum(["owner", "manager", "developer", "prompter", "viewer"]);
const Scope = z.enum(["private", "organization"]);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Cases = z.array(z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  tokenEnv: z.string().max(128).regex(/^ZEROS_E5_ALPHA_[A-Z_]+_ACCESS_TOKEN$/),
  actorUserId: Uuid, workspaceId: Uuid, organizationId: Uuid,
  expectedStatus: z.union([z.literal(200), z.literal(404)]),
  actorRole: Role.nullable().optional(), sharingMode: Scope.optional(),
  organizationRole: z.enum(["owner", "admin", "member"]).optional(),
}).strict().refine(value => value.expectedStatus !== 200 || value.actorRole !== undefined)).min(1).max(24);
const Document = z.object({
  id: Uuid, organizationId: Uuid, actorRole: Role.nullable(), sharingMode: Scope, accessRevision: Revision,
  capabilities: z.object({ canWrite: z.boolean(), canEdit: z.boolean(), canManage: z.boolean() }),
});
const Writers = z.object({ limit: z.number().int().positive(), used: z.number().int().nonnegative(), available: z.number().int().nonnegative() });
const Page = z.object({
  workspaceId: Uuid, organizationId: Uuid, accessRevision: Revision, writers: Writers.nullable(),
  members: z.array(z.object({ userId: Uuid })).max(100),
  guests: z.array(z.object({ id: Uuid })).max(100), invitations: z.array(z.object({ id: Uuid })).max(100),
  memberCursor: Uuid.nullable(), guestCursor: Uuid.nullable(), invitationCursor: Uuid.nullable(),
});
class CheckFailure extends Error {}
const requireCheck = (condition, check) => { if (!condition) throw new CheckFailure(check); };

async function readJson(response) {
  const reader = response.body?.getReader();
  requireCheck(reader, "response_unavailable");
  let size = 0, text = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new CheckFailure("response_size"); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

export async function verifySharingCases(input, credentials, { fetch = globalThis.fetch } = {}) {
  const cases = Cases.safeParse(input);
  if (!cases.success) return { pass: false, check: "case_configuration", createdResources: 0, cases: [] };
  const results = [];
  for (const item of cases.data) {
    try {
      const token = credentials.get(item.tokenEnv);
      requireCheck(typeof token === "string" && token.length > 0, "credential_missing");
      const get = async route => fetch(`${ALPHA_ORIGIN}${route}`, {
        method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000),
        headers: { authorization: `Bearer ${token}` },
      });
      const meResponse = await get("/v1/me");
      requireCheck(meResponse.status === 200, "account_http_status");
      const me = await readJson(meResponse);
      requireCheck(me?.user?.id === item.actorUserId && ["developer", "platform_owner"].includes(me.user.staffRole), "staff_account_identity");
      if (item.organizationRole) requireCheck((me.organizations ?? me.teams)?.some(
        organization => organization.id === item.organizationId && organization.role === item.organizationRole), "organization_role");
      const base = `/v1/cloud-workspaces/${item.workspaceId}`;
      const response = await get(base);
      requireCheck(response.status === item.expectedStatus, "workspace_http_status");
      if (item.expectedStatus === 404) {
        requireCheck((await get(`${base}/collaborators?pageSize=50`)).status === 404, "private_or_revoked_collaborators");
        results.push({ name: item.name, pass: true, expectedStatus: 404 });
        continue;
      }
      const parsed = Document.safeParse((await readJson(response))?.workspace);
      requireCheck(parsed.success, "workspace_projection");
      const document = parsed.data;
      requireCheck(document.id === item.workspaceId && document.organizationId === item.organizationId, "workspace_identity");
      requireCheck(document.actorRole === item.actorRole, "actor_role");
      const role = document.actorRole;
      requireCheck(document.capabilities.canWrite === ["owner", "manager", "developer", "prompter"].includes(role) &&
        document.capabilities.canEdit === ["owner", "manager", "developer"].includes(role) &&
        document.capabilities.canManage === ["owner", "manager"].includes(role), "role_capabilities");
      if (item.sharingMode) requireCheck(document.sharingMode === item.sharingMode, "sharing_scope");
      const collaborators = await get(`${base}/collaborators?pageSize=50`);
      if (!document.capabilities.canManage) {
        requireCheck(collaborators.status === (role === null ? 404 : 403), "collaborator_management_denied");
        results.push({ name: item.name, pass: true, actorRole: role, canEdit: document.capabilities.canEdit });
        continue;
      }
      const readPage = async response => {
        requireCheck(response.status === 200, "collaborator_http_status");
        const parsed = Page.safeParse(await readJson(response));
        requireCheck(parsed.success, "collaborator_projection");
        const page = parsed.data;
        requireCheck(page.workspaceId === item.workspaceId && page.organizationId === item.organizationId &&
          page.accessRevision === document.accessRevision, "collaborator_identity_or_revision");
        return page;
      };
      const first = await readPage(collaborators);
      const counts = {};
      let pages = 1;
      for (const [collection, cursorKey, idKey] of [["members", "memberCursor", "userId"], ["guests", "guestCursor", "id"], ["invitations", "invitationCursor", "id"]]) {
        const ids = new Set(first[collection].map(row => row[idKey]));
        const cursors = new Set();
        let cursor = first[cursorKey];
        while (cursor) {
          requireCheck(!cursors.has(cursor) && pages < 120, "pagination_bound");
          cursors.add(cursor);
          const page = await readPage(await get(`${base}/collaborators?pageSize=50&${cursorKey}=${cursor}`));
          for (const row of page[collection]) { requireCheck(!ids.has(row[idKey]), "pagination_duplicate"); ids.add(row[idKey]); }
          requireCheck(ids.size <= 2_000, "pagination_bound");
          cursor = page[cursorKey]; pages++;
        }
        counts[collection] = ids.size;
      }
      requireCheck(Object.values(counts).reduce((total, count) => total + count, 0) <= 2_000, "pagination_bound");
      results.push({ name: item.name, pass: true, actorRole: role, canEdit: document.capabilities.canEdit,
        accessRevision: document.accessRevision, writers: first.writers, pages, counts });
    } catch (error) {
      results.push({ name: item.name, pass: false, check: error instanceof CheckFailure ? error.message : "request_failed" });
    }
  }
  return { pass: results.every(result => result.pass), createdResources: 0, cases: results };
}

async function main() {
  try {
    const parsed = parseAgentEnv(await readFile(path.join(ROOT, ".env.agent"), "utf8"));
    requireCheck(parsed.malformedLines.length === 0 && parsed.duplicateKeys.length === 0, "credential_file_format");
    const cases = JSON.parse(await readFile(path.resolve(process.argv[2] ?? ".context/e5-sharing-cases.json"), "utf8"));
    const result = await verifySharingCases(cases, parsed.values);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.pass ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({ pass: false, check: error instanceof CheckFailure ? error.message : "configuration_unavailable", createdResources: 0 }));
    process.exitCode = 1;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
