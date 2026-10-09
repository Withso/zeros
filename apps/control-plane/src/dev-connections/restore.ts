import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withSystemTx, type Tx } from "../db.js";
import { denied, type ConnectionReference } from "./types.js";
import { ReferenceSchema, type RestoreMapping, type RestorePort } from "./client.js";
import {serializeCloudAgentCredentialSourceMutation,assertLegacyCloudAgentCredentialMutationAllowed} from "../cloud-workspaces/agent-credential-mutations.js";

/** Same consent fingerprint as the released credential service. Member and
 * identity locks fence a network restore against local authorization changes. */
export async function currentMapping(tx: Tx, mapping: RestoreMapping) {
  const row = (await tx.query<{fingerprint:string}>(`SELECT encode(digest(jsonb_build_array(
    o.id,o.authorization_revision,u.id,u.auth_revision,m.authorization_revision,m.role,m.created_at)::text,'sha256'),'hex') AS fingerprint
    FROM users u JOIN user_identities i ON i.user_id=u.id JOIN organization_members m ON m.user_id=u.id
    JOIN organizations o ON o.id=m.org_id JOIN workos_organization_links l ON l.organization_id=o.id
    WHERE u.id=$1 AND o.id=$2 AND i.provider='workos' AND i.provider_sub=$3 AND i.status='active' AND i.email_verified_at IS NOT NULL
      AND u.auth_status='active' AND u.deleted_at IS NULL AND o.deleted_at IS NULL AND o.lifecycle_status='active' AND NOT o.is_personal
      AND l.state='active' AND l.workos_organization_id=$4 FOR SHARE OF u,i,m,o,l`,
  [mapping.localUserId,mapping.localOrganizationId,mapping.subject,mapping.workosOrganizationId])).rows[0];
  if (!row || (mapping.fingerprint && mapping.fingerprint !== row.fingerprint)) denied();
  return row.fingerprint;
}
export async function invalidateReferences(tx:Tx,generation:string,bindings:string[]|null) {
  const rows=(await tx.query<{binding_id:string}>(`UPDATE dev_connection_references SET invalidated_at=clock_timestamp()
    WHERE generation_id=$1 AND ($2::uuid[] IS NULL OR binding_id=ANY($2)) RETURNING binding_id`,[generation,bindings])).rows;
  const ids=rows.map(r=>r.binding_id);
  await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE credential_id=ANY($1::uuid[])",[ids]);
  // Engines already validate these short leases and terminate on denial.
  await tx.query("UPDATE cloud_agent_execution_leases SET released_at=coalesce(released_at,now()) WHERE credential_id=ANY($1::uuid[])",[ids]);
  return ids;
}
export class DatabaseDevConnectionRestore implements RestorePort {
  constructor(private readonly pool:pg.Pool) {}
  async mapping(user:string,issuer:string,subject:string,organization:string):Promise<RestoreMapping|null> {
    return withSystemTx(this.pool,async tx=>{
      const row=(await tx.query<{organization_id:string}>(`SELECT l.organization_id FROM workos_organization_links l
        JOIN organization_members m ON m.org_id=l.organization_id WHERE l.workos_organization_id=$1 AND l.state='active' AND m.user_id=$2`,[organization,user])).rows[0];
      if(!row)return null;
      const mapping={issuer,subject,workosOrganizationId:organization,localUserId:user,localOrganizationId:row.organization_id};
      return {...mapping,fingerprint:await currentMapping(tx,mapping)};
    });
  }
  async replace(mapping:RestoreMapping,generation:string,references:ConnectionReference[]) {
    return this.apply(mapping,generation,references);
  }
  /** Only an explicit member action may lift a local removal. The broker must
   * still return this exact binding; automatic sign-in never calls this path. */
  async reattach(mapping:RestoreMapping,generation:string,id:string,references:ConnectionReference[]) {
    if(!references.some(ref=>ref.bindingId===id))denied();
    return this.apply(mapping,generation,references,id);
  }
  private async apply(mapping:RestoreMapping,generation:string,references:ConnectionReference[],reattachId?:string) {
    const refs=references.map(r=>ReferenceSchema.parse(r));
    if(refs.some(r=>r.generationId!==generation||r.organization!==mapping.workosOrganizationId||Date.parse(r.expiresAt)<=Date.now())||new Set(refs.map(r=>r.bindingId)).size!==refs.length)denied();
    await withSystemTx(this.pool,async tx=>{
      await serializeCloudAgentCredentialSourceMutation(tx,mapping.localUserId);
      const fingerprint=await currentMapping(tx,mapping);
      const missing=(await tx.query<{binding_id:string}>(`SELECT binding_id FROM dev_connection_references
        WHERE owner_user_id=$1 AND org_id=$2 AND generation_id=$3 AND NOT(binding_id=ANY($4::uuid[])) FOR UPDATE`,
      [mapping.localUserId,mapping.localOrganizationId,generation,refs.map(r=>r.bindingId)])).rows.map(r=>r.binding_id);
      await invalidateReferences(tx,generation,missing);
      await tx.query("UPDATE cloud_agent_credentials SET revoked_at=coalesce(revoked_at,now()) WHERE id=ANY($1::uuid[])",[missing]);
      for(const ref of refs) {
        const previous=(await tx.query<{owner_user_id:string;org_id:string;generation_id:string;reference:ConnectionReference;removed_at:Date|null;invalidated_at:Date|null;fingerprint:string}>("SELECT * FROM dev_connection_references WHERE binding_id=$1 FOR UPDATE",[ref.bindingId])).rows[0];
        if(previous&&(previous.owner_user_id!==mapping.localUserId||previous.org_id!==mapping.localOrganizationId||previous.generation_id!==generation))denied();
        if(previous?.removed_at && ref.bindingId!==reattachId)continue;
        if(previous && (previous.removed_at || previous.invalidated_at || previous.fingerprint!==fingerprint ||
          previous.reference.revision!==ref.revision || previous.reference.consentRevision!==ref.consentRevision))
          await assertLegacyCloudAgentCredentialMutationAllowed(tx,mapping.localUserId,{credentialId:ref.bindingId,organizationId:mapping.localOrganizationId});
        if(previous?.removed_at)await tx.query("UPDATE dev_connection_references SET removed_at=NULL WHERE binding_id=$1",[ref.bindingId]);
        const existing=(await tx.query<{owner_user_id:string;kind:string;material_mode:string|null}>(`SELECT c.owner_user_id,c.kind,v.material_mode
          FROM cloud_agent_credentials c LEFT JOIN cloud_agent_credential_versions v ON v.credential_id=c.id AND v.version=c.current_version
          WHERE c.id=$1 FOR UPDATE OF c`,[ref.bindingId])).rows[0];
        if(existing&&(!previous||existing.owner_user_id!==mapping.localUserId||existing.kind!==ref.kind||existing.material_mode!=='dev-reference'))denied();
        await tx.query(`INSERT INTO dev_connection_references(binding_id,owner_user_id,org_id,issuer,subject,workos_org_id,generation_id,reference,fingerprint)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(binding_id) DO UPDATE SET reference=EXCLUDED.reference,fingerprint=EXCLUDED.fingerprint,invalidated_at=NULL,updated_at=now()`,
        [ref.bindingId,mapping.localUserId,mapping.localOrganizationId,mapping.issuer,mapping.subject,mapping.workosOrganizationId,generation,ref,fingerprint]);
        if(ref.kind==='github-app')continue;
        const changed=previous&&(previous.reference.revision!==ref.revision||previous.reference.consentRevision!==ref.consentRevision);
        const hash=createHash('sha256').update(JSON.stringify(ref)).digest();
        const credential=(await tx.query<{revision:string}>(`INSERT INTO cloud_agent_credentials(id,owner_user_id,kind,display_name,last_operation_id,last_request_sha256,connection_method)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET revision=cloud_agent_credentials.revision+CASE WHEN $8 THEN 1 ELSE 0 END,
          revoked_at=NULL,last_request_sha256=EXCLUDED.last_request_sha256,updated_at=now() RETURNING revision`,
        [ref.bindingId,mapping.localUserId,ref.kind,`Dev ${ref.kind}`,randomUUID(),hash,ref.connectionMethod,!!changed])).rows[0]!;
        if(changed)await tx.query("UPDATE cloud_agent_credential_delegations SET revoked_at=coalesce(revoked_at,now()) WHERE credential_id=$1",[ref.bindingId]);
        await tx.query(`INSERT INTO cloud_agent_credential_versions(credential_id,version,material_mode,dev_reference,material_expires_at)
          VALUES($1,1,'dev-reference',$2,$3) ON CONFLICT(credential_id,version) DO UPDATE SET dev_reference=EXCLUDED.dev_reference,material_expires_at=EXCLUDED.material_expires_at
          WHERE cloud_agent_credential_versions.material_mode='dev-reference'`,[ref.bindingId,ref,ref.expiresAt]);
        await tx.query("INSERT INTO cloud_agent_credential_organizations(credential_id,owner_user_id,org_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[ref.bindingId,mapping.localUserId,mapping.localOrganizationId]);
        if(!ref.consent.scopes.includes('agent')||!ref.consent.models.length)continue;
        const provider=ref.kind.split('-')[0]!;
        const consentHash=createHash('sha256').update(JSON.stringify([ref.bindingId,Number(credential.revision),ref.consent.models,fingerprint,...(ref.consent.allModels?["all-models"]:[])])).digest();
        await tx.query(`INSERT INTO cloud_agent_organization_connections(org_id,owner_user_id,provider,revision,credential_id,credential_revision,models,consent_fingerprint,request_sha256,all_models)
          VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9) ON CONFLICT(org_id,owner_user_id,provider) DO UPDATE SET
          revision=cloud_agent_organization_connections.revision+1,credential_id=EXCLUDED.credential_id,credential_revision=EXCLUDED.credential_revision,
          models=EXCLUDED.models,all_models=EXCLUDED.all_models,consent_fingerprint=EXCLUDED.consent_fingerprint,request_sha256=EXCLUDED.request_sha256,updated_at=now()
          WHERE cloud_agent_organization_connections.request_sha256 IS DISTINCT FROM EXCLUDED.request_sha256`,
        [mapping.localOrganizationId,mapping.localUserId,provider,ref.bindingId,credential.revision,ref.consent.models,fingerprint,consentHash,ref.consent.allModels===true]);
      }
    });
  }
}
