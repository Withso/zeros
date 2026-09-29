import { z } from "zod";
import type pg from "pg";
import { HttpError } from "../authz.js";
import { withSystemTx } from "../db.js";
import type { CloudAgentCredentialKeys } from "./agent-credential-envelope.js";
import { assertCloudActorSession, type CloudActorEngineScope } from "./actor-sessions.js";
import { assertCurrentCloudEngineAuthority } from "./engine-authority.js";
import { DatabaseCloudCustomizationService } from "./customization-store.js";
import { CloudCustomizationDocumentSchema } from "./mcp-contract.js";

export const CloudCustomizationOperationSchema = z.enum(["extensions.list", "skills.listZeros", "skills.saveZeros", "skills.removeZeros"]);
export async function cloudWorkspaceCustomization(pool: pg.Pool, keys: CloudAgentCredentialKeys, workosEnabled: boolean,
  engine: Omit<CloudActorEngineScope, "actorSessionId">, actorSessionId: string, operation: z.infer<typeof CloudCustomizationOperationSchema>, params: unknown) {
  const write = operation === "skills.saveZeros" || operation === "skills.removeZeros";
  const actor = await withSystemTx(pool, async tx => {
    await assertCurrentCloudEngineAuthority(tx, { ...engine, workosEnabled });
    return assertCloudActorSession(tx, engine, actorSessionId, write ? "edit" : "read");
  });
  const parsed = z.object({ scope: z.enum(["organization", "member"]).default("organization"), category: z.enum(["mcp", "skills", "apps", "plugins"]).optional(),
    provider: z.enum(["zeros", "claude", "codex", "cursor"]).optional(), name: z.string().optional(), description: z.string().max(1000).optional(), body: z.string().max(32768).optional(),
    expectedRevision: z.string().regex(/^[0-9]+$/).nullable().optional() }).strict().safeParse(params);
  if (!parsed.success) throw new HttpError(422, "invalid_customization", "Invalid organization customization request.");
  const service = new DatabaseCloudCustomizationService(pool, keys), settings = await service.read(engine.organizationId, actor.actorUserId), view = settings[parsed.data.scope];
  const entries = () => view.skills.map(skill => ({ id: `cloud-skill:${parsed.data.scope}:${skill.name}`, name: skill.name,
    description: skill.description || "Organization skill", sourcePath: "", sourceId: parsed.data.scope, status: "configured" as const, body: skill.content, revision: String(view.revision) }));
  if (operation === "skills.listZeros") return entries();
  if (operation === "extensions.list") {
    const category = parsed.data.category;
    const supported = category === "skills" || category === "mcp";
    return { entries: category === "skills" ? entries() : category === "mcp" ? view.servers.map(server => ({ id: server.id, name: server.name,
      description: server.transport, sourcePath: "", sourceId: parsed.data.scope, status: "configured" as const,
      statusDetail: "Available to newly admitted cloud executions." })) : [],
      partial: !supported, sources: [{ id: parsed.data.scope, kind: "account", state: supported ? "complete" : "unsupported" }],
      warnings: supported ? [] : ["Provider account extensions and Cursor team settings are not imported into organization cloud workspaces."] };
  }
  const expected = parsed.data.expectedRevision;
  if (expected === undefined || (expected !== null && Number(expected) !== view.revision) ||
      (expected === null && view.skills.some(skill => skill.name === parsed.data.name))) throw new HttpError(409, "customization_changed", "Skill changed. Reload before saving.");
  const document = CloudCustomizationDocumentSchema.parse({ cursorTeamSettings: "disabled", skills: view.skills,
    servers: view.servers.map(({ secretRef: _ref, envKeys: _env, headerKeys: _headers, ...server }) => server) });
  document.skills = document.skills.filter(skill => skill.name !== parsed.data.name);
  if (operation === "skills.saveZeros") document.skills.push({ name: parsed.data.name!, content: parsed.data.body!, description: parsed.data.description });
  const next = await service.save(engine.organizationId, actor.actorUserId, parsed.data.scope, { expectedRevision: view.revision, document });
  return operation === "skills.removeZeros" ? { ok: true } : { id: `cloud-skill:${parsed.data.scope}:${parsed.data.name}`, name: parsed.data.name!, description: parsed.data.description ?? "Organization skill",
    sourcePath: "", sourceId: parsed.data.scope, status: "configured", body: parsed.data.body!, revision: String(next.revision) };
}
