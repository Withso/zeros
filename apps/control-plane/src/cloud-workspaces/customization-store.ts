import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { HttpError } from "../authz.js";
import { withSystemTx, type Tx } from "../db.js";
import type { CloudAgentCredentialKeys } from "./agent-credential-envelope.js";
import { CloudCustomizationDocumentSchema, emptyCustomization, openCustomization, publicCustomization, sealCustomization, type CloudCustomizationDocument } from "./mcp-contract.js";

export type CustomizationRow = { id: string; org_id: string; owner_user_id: string | null; revision: string; key_version: number; nonce: Buffer; ciphertext: Buffer; auth_tag: Buffer };
export const customizationBinding = (row: CustomizationRow) => ({ id: row.id, organizationId: row.org_id, ownerUserId: row.owner_user_id, revision: Number(row.revision), keyVersion: row.key_version });
export function readCustomizationDocument(row: CustomizationRow | undefined, keys: CloudAgentCredentialKeys): CloudCustomizationDocument {
  return row ? CloudCustomizationDocumentSchema.parse(openCustomization({ nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag }, customizationBinding(row), keys)) : emptyCustomization();
}
export async function lockCustomization(tx: Tx, org: string) {
  // Admission and updates share this lock, including absent scope rows. A
  // first save cannot race a lease that observed an empty organization.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,71511))", [org]);
}
export async function readCustomizationRows(tx: Tx, org: string, actor: string) {
  return (await tx.query<CustomizationRow>("SELECT * FROM cloud_customization WHERE org_id=$1 AND (owner_user_id IS NULL OR owner_user_id=$2) ORDER BY owner_user_id NULLS FIRST", [org, actor])).rows;
}
async function authority(tx: Tx, org: string, actor: string, admin = false) {
  if (!z.string().uuid().safeParse(org).success) throw new HttpError(422, "invalid_input", "Invalid organization.");
  const row = (await tx.query<{ role: string }>(`SELECT member.role FROM organization_members member JOIN organizations org ON org.id=member.org_id
    WHERE member.org_id=$1 AND member.user_id=$2 AND NOT org.is_personal AND org.deleted_at IS NULL FOR SHARE OF org,member`, [org, actor])).rows[0];
  if (!row) throw new HttpError(404, "not_found", "Customization requires an organization membership.");
  // Authorize the locked version, holding membership and organization locks
  // through publication. A prior unlocked role check races administrator removal.
  if (admin && !["owner", "admin"].includes(row.role)) throw new HttpError(403, "forbidden", "Organization administrator access required.");
  return row;
}
const saveSchema = z.object({ expectedRevision: z.number().int().nonnegative().safe(), document: CloudCustomizationDocumentSchema }).strict();
export class DatabaseCloudCustomizationService {
  constructor(private readonly pool: pg.Pool, private readonly keys: CloudAgentCredentialKeys) {}
  async read(org: string, actor: string) {
    return withSystemTx(this.pool, async tx => {
      const member = await authority(tx, org, actor);
      const rows = await readCustomizationRows(tx, org, actor);
      const view = (owner: string | null) => { const row = rows.find(row => row.owner_user_id === owner);
        return publicCustomization(readCustomizationDocument(row, this.keys), { revision: Number(row?.revision ?? 0) }); };
      return { organization: view(null), member: view(actor), canManage: ["owner", "admin"].includes(member.role),
        oauth: "unsupported" as const, cursorTeamSettings: "unsupported" as const };
    });
  }
  async save(org: string, actor: string, scope: string, value: unknown) {
    if (scope !== "organization" && scope !== "member") throw new HttpError(422, "invalid_input", "Invalid customization scope.");
    const parsed = saveSchema.safeParse(value);
    if (!parsed.success) throw new HttpError(422, "invalid_customization", "Invalid customization. OAuth and implicit environment imports are unsupported.");
    return withSystemTx(this.pool, async tx => {
      await authority(tx, org, actor, scope === "organization"); await lockCustomization(tx, org);
      const owner = scope === "organization" ? null : actor;
      const row = (await readCustomizationRows(tx, org, actor)).find(row => row.owner_user_id === owner);
      if (Number(row?.revision ?? 0) !== parsed.data.expectedRevision) throw new HttpError(409, "customization_changed", "Customization changed. Reload before saving.");
      const previous = readCustomizationDocument(row, this.keys), document = parsed.data.document;
      // An omitted secret map preserves that same server's encrypted map.
      // An explicit empty map rotates it to no secrets. Changing the endpoint,
      // name or transport requires supplying new values, preventing accidental
      // delivery of a retained secret to a replacement server.
      for (const server of document.servers) {
        const prior = previous.servers.find(value => value.id === server.id);
        if (!prior) continue;
        const same = prior.name === server.name && prior.transport === server.transport &&
          (prior.transport === "stdio" && server.transport === "stdio" ? prior.command === server.command && JSON.stringify(prior.args ?? []) === JSON.stringify(server.args ?? []) && prior.cwd === server.cwd :
            prior.transport !== "stdio" && server.transport !== "stdio" && prior.url === server.url);
        if (same && server.transport === "stdio" && prior.transport === "stdio" && server.env === undefined && prior.env) server.env = prior.env;
        if (same && server.transport !== "stdio" && prior.transport !== "stdio" && server.headers === undefined && prior.headers) server.headers = prior.headers;
      }
      if (!CloudCustomizationDocumentSchema.safeParse(document).success)
        throw new HttpError(422, "invalid_customization", "Customization exceeds its storage bound.");
      const binding = { id: row?.id ?? randomUUID(), organizationId: org, ownerUserId: owner, revision: parsed.data.expectedRevision + 1, keyVersion: this.keys.currentKeyVersion };
      const envelope = sealCustomization(document, binding, this.keys);
      await tx.query(`INSERT INTO cloud_customization(id,org_id,owner_user_id,revision,key_version,nonce,ciphertext,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,key_version=excluded.key_version,nonce=excluded.nonce,ciphertext=excluded.ciphertext,auth_tag=excluded.auth_tag,updated_at=now()`,
      [binding.id, org, owner, binding.revision, binding.keyVersion, envelope.nonce, envelope.ciphertext, envelope.authTag]);
      // Active grants cannot acquire a different snapshot. Rotation/removal
      // invalidates their next renewal; the engine's monotonic deadline bounds
      // retirement even if it loses contact with this service.
      await tx.query(`UPDATE cloud_agent_execution_leases lease SET released_at=coalesce(released_at,clock_timestamp())
        FROM cloud_customization_execution_snapshots snapshot WHERE snapshot.lease_id=lease.id AND snapshot.org_id=$1
        AND ($2::uuid IS NULL OR snapshot.actor_user_id=$2) AND lease.released_at IS NULL`, [org, owner]);
      return publicCustomization(document, binding);
    });
  }
}
