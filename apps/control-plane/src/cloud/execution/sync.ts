import { randomUUID } from "node:crypto";
import type { AuthedUser } from "../../auth.js";
import type { Tx } from "../../db.js";
import type { LocalDeviceBinding } from "../local-commands/contract.js";
import type { ExecutionAdmission } from "./authority.js";
import { executionContextAuthority } from "./signatures.js";
import type { CloudExecutionContexts, ExecutionContext } from "./store.js";
import { assertExecutionLifetime } from "./lifetime.js";

export class CloudExecutionSync {
  constructor(readonly contexts: CloudExecutionContexts) {}

  async grant(tx: Tx, proof: ExecutionAdmission, user: AuthedUser, binding: LocalDeviceBinding, connectedAt: string, iat: number) {
    const person = proof.person, ceiling = (iat + 600 - 30) * 1000;
    const previous = (await tx.query<ExecutionContext & { same_binding: boolean }>(`SELECT *,
      (provider_session_id=$4 AND sync_registration_id=$5 AND sync_instance_id=$6 AND sync_connected_at=$7::timestamptz
        AND worker_boot_id=$8 AND access_epoch=$9 AND stop_generation=$10 AND expires_at>clock_timestamp()
        AND client_token_expires_at>clock_timestamp()) AS same_binding
      FROM cloud_v2_execution_contexts WHERE workspace_id=$1 AND user_id=$2 AND sync_device_id=$3 AND state='active' FOR UPDATE`,
    [person.workspaceId, user.id, binding.deviceId, user.authentication.sessionId, binding.registrationId, binding.instanceId,
      connectedAt, person.bootId, person.accessEpoch, person.stopGeneration])).rows[0];
    if (previous?.same_binding) {
      await this.contexts.assertContext(tx, previous, proof);
      await tx.query("UPDATE cloud_v2_execution_contexts SET client_token_expires_at=greatest(client_token_expires_at,$2) WHERE id=$1",
        [previous.id, new Date(ceiling)]);
      return this.contexts.issueLease(tx, previous, proof);
    }
    if (previous) {
      await this.contexts.revoke(tx, previous.id, "access_revoked");
      await this.contexts.clients.retireHandles(tx, person.workspaceId, [previous.id]);
    }
    const id = randomUUID(), until = Math.min(proof.until, ceiling);
    assertExecutionLifetime(until);
    const row = (await tx.query<ExecutionContext>(`INSERT INTO cloud_v2_execution_contexts
      (id,workspace_id,org_id,user_id,kind,client_id,provider_session_id,client_token_expires_at,
        sync_device_id,sync_registration_id,sync_instance_id,sync_connected_at,
        access_epoch,stop_generation,worker_boot_id,worker_token_hash,authority,source_fingerprint,expires_at)
      VALUES($1,$2,$3,$4,'client',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,decode($15,'hex'),$16,$17,$18) RETURNING *`,
    [id, person.workspaceId, person.organizationId, user.id, id, user.authentication.sessionId, new Date(ceiling),
      binding.deviceId, binding.registrationId, binding.instanceId, connectedAt,
      person.accessEpoch, person.stopGeneration, person.bootId, person.workerTokenHash, executionContextAuthority(person),
      proof.source.fingerprint, new Date(until)])).rows[0]!;
    await this.contexts.assertContext(tx, row, proof);
    assertExecutionLifetime(until);
    return row;
  }
}
