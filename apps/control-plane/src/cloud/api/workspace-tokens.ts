import type pg from "pg";
import { withSystemTx } from "../../db.js";
import { HttpError } from "../../authz.js";
import type { CloudAgentCredentialKeys } from "../../agent-credentials/agent-credential-envelope.js";
import { CLOUD_V2_LIVE_ACCESS } from "../workspace-access.js";
import { hashCloudV2Token, isCloudV2Token, newCloudV2Token, sameHash } from "../tokens.js";
import { openPortToken, sealPortToken } from "../worker-port-token.js";

type RunToken = { api_access: boolean; stop_generation: string; token_hash: Buffer | null; api_envelope: unknown };

export class CloudWorkspaceApiTokens {
  constructor(private readonly pool: pg.Pool, private readonly keys: CloudAgentCredentialKeys) {}

  private redeliver(workspaceId: string, existing: RunToken): string | undefined {
    try {
      const token = openPortToken(existing.api_envelope, workspaceId, this.keys);
      if (isCloudV2Token(token, "api") && existing.token_hash && sameHash(hashCloudV2Token(token), existing.token_hash)) return token;
    } catch { /* Unknown material must not silently rotate a live VM run's authority. */ }
    console.warn("[cloud-api] api_token_unavailable");
    return undefined;
  }

  token(workspaceId: string): Promise<string | undefined> {
    return withSystemTx(this.pool, async tx => {
      const live = `WHERE w.id=$1 AND w.execution_mode<>'active'
          AND w.state IN ('creating','starting','running') AND w.archived_at IS NULL AND ${CLOUD_V2_LIVE_ACCESS}`;
      const read = async () => {
        const { rows } = await tx.query<RunToken>(`SELECT w.api_access,w.stop_generation::text,t.token_hash,t.api_envelope
          FROM cloud_v2_workspaces w LEFT JOIN cloud_v2_tokens t ON t.workspace_id=w.id
            AND t.kind='api' AND t.api_stop_generation=w.stop_generation ${live}`, [workspaceId]);
        if (!rows[0]) throw new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
        return rows[0];
      };
      let current = await read();
      if (!current.api_access) return undefined;
      if (current.token_hash) return this.redeliver(workspaceId, current);

      const locked = await tx.query(`SELECT id FROM cloud_v2_workspaces w ${live} FOR UPDATE OF w`, [workspaceId]);
      if (!locked.rowCount) throw new HttpError(401, "worker_unauthorized", "Worker authorization is no longer current");
      // A concurrent mint or revocation may have committed while we waited.
      current = await read();
      if (!current.api_access) return undefined;
      if (current.token_hash) return this.redeliver(workspaceId, current);
      const issued = newCloudV2Token("api");
      const envelope = sealPortToken(issued.token, workspaceId, this.keys);
      await tx.query(`INSERT INTO cloud_v2_tokens(token_hash,workspace_id,kind,expires_at,api_stop_generation,api_envelope)
        VALUES($1,$2,'api','infinity',$3,$4)`, [issued.hash, workspaceId, current.stop_generation, envelope]);
      return issued.token;
    });
  }
}
