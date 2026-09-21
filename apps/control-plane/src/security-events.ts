import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type pg from "pg";

import type { AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { DATABASE_CONNECTION_LIFETIME_SECONDS, withSystemTx, type Tx } from "./db.js";
import {publishCloudWorkspaceDirectoryChanges} from "./cloud-workspaces/directory-events.js";

const EVENT_PAGE_SIZE = 100;
const HEARTBEAT_MS = 25_000;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;
const activePublications=new WeakMap<pg.Pool,Promise<number>>();

/** Commit order belongs to publication, not to identity allocation. Publishers
 * only lock committed outbox rows and this short publication mutex, never users
 * or organizations. Requests may repeat after an ambiguous commit safely. */
export function publishPendingSecurityEvents(pool:pg.Pool):Promise<number> {
  const active=activePublications.get(pool);if(active)return active;
  const publication=publishSecurityEvents(pool).finally(()=>activePublications.delete(pool));
  activePublications.set(pool,publication);return publication;
}

async function publishSecurityEvents(pool: pg.Pool): Promise<number> {
  await publishCloudWorkspaceDirectoryChanges(pool);
  return withSystemTx(pool, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1936024437, 1702258030)");
    await tx.query(`WITH expired AS (
      SELECT sequence FROM security_events WHERE expires_at <= now()
      ORDER BY expires_at, sequence LIMIT 1000 FOR UPDATE SKIP LOCKED
    ) DELETE FROM security_events e USING expired WHERE e.sequence = expired.sequence`);
    const result = await tx.query(`WITH pending AS MATERIALIZED (
        SELECT sequence FROM security_events
        WHERE delivery_sequence IS NULL AND expires_at > now()
        ORDER BY expires_at, sequence LIMIT 1000 FOR UPDATE SKIP LOCKED
      ), assigned AS MATERIALIZED (
        SELECT sequence, nextval('security_event_delivery_sequence') AS cursor
        FROM pending ORDER BY sequence
      )
      UPDATE security_events e SET delivery_sequence = assigned.cursor
      FROM assigned WHERE e.sequence = assigned.sequence`);
    return result.rowCount ?? 0;
  });
}

/** Publication and erasure cleanup progress even with no connected clients.
 * One in-flight batch per process/pool; DB locks fence multiple API replicas. */
export function startSecurityEventPublisher(pool:pg.Pool,logger:Pick<Console,"error">=console):()=>Promise<void> {
  let stopped=false,active:Promise<void>|null=null,timer:NodeJS.Timeout|undefined;
  const tick=()=>{
    if(stopped)return;
    active=publishPendingSecurityEvents(pool).then(()=>{}).catch(()=>logger.error("[security-events] publication failed"))
      .finally(()=>{active=null;if(!stopped){timer=setTimeout(tick,1000);timer.unref();}});
  };
  tick();return async()=>{stopped=true;clearTimeout(timer);await active;};
}

export type SecurityEventWire = {
  sequence: number;
  kind:
    | "account.revoked"
    | "account.authorization_changed"
    | "session.revoked"
    | "organization.access_revoked"
    | "organization.authorization_changed"
    | "organization.data_changed"
    | "workspace.authorization_changed";
  organizationId: string | null;
  workspaceId: string | null;
  accountRevision: number | null;
  authorizationRevision: number | null;
  dataRevision: number | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type SecuritySnapshot = {
  account: {
    id: string;
    status: "active";
    revision: number;
  };
  session: {
    id: string | null;
    status: "active" | "legacy";
  };
  organizations: Array<{
    id: string;
    role: "owner" | "admin" | "member";
    authorizationRevision: number;
    membershipRevision: number;
    dataRevision: number;
  }>;
  workspaces: Array<{id:string;organizationId:string;role:string;accessRevision:number;dataRevision:number}>;
  /** Re-fetch paginated discovery on reconnect when the repair snapshot is bounded. */
  workspacesTruncated: boolean;
  cursor: number;
  generatedAt: string;
};

function cursor(value: string | null | undefined): number {
  if (!value || !/^\d{1,16}$/.test(value)) return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_CURSOR) {
    throw new HttpError(422, "invalid_cursor", "Event cursor is invalid");
  }
  return parsed;
}

/** Streams outlive their HTTP authentication. Recheck the exact identity and
 * session in the same snapshot as each replay batch, including token expiry. */
async function securityStreamAuthority(tx:Tx,user:AuthedUser):Promise<boolean> {
  const result=await tx.query<{live:boolean}>(`SELECT EXISTS (
    SELECT 1 FROM users account JOIN user_identities identity ON identity.user_id=account.id
    WHERE account.id=$1 AND account.auth_status='active' AND account.deleted_at IS NULL
      AND account.auth_revision=$4 AND identity.provider=$2 AND identity.provider_sub=$3 AND identity.status='active'
      AND ($6::bigint IS NULL OR clock_timestamp()<to_timestamp($6::bigint))
      AND ($5::text IS NULL OR EXISTS (SELECT 1 FROM auth_sessions session
        WHERE session.provider='workos' AND session.provider_session_id=$5 AND session.user_id=account.id
          AND session.provider_sub=identity.provider_sub AND session.status='active' AND session.revoked_at IS NULL
          AND (session.provider_session_expires_at IS NULL OR session.provider_session_expires_at>now())))
    ) AS live`,[user.id,user.identity.provider,user.identity.subject,user.accountRevision,
    user.authentication.sessionId,user.authentication.tokenExpiresAt]);
  return result.rows[0]?.live===true;
}

export async function getSecuritySnapshot(
  pool: pg.Pool,
  user: AuthedUser,
): Promise<SecuritySnapshot> {
  await publishPendingSecurityEvents(pool);
  return withSystemTx(pool, async (tx) => {
    if (!await securityStreamAuthority(tx,user)) throw new HttpError(401,"session_revoked","Authentication is no longer current");
    const account = await tx.query<{
      auth_status: string;
      auth_revision: string | number;
    }>(`SELECT auth_status, auth_revision FROM users WHERE id = $1`, [user.id]);
    if (account.rows[0]?.auth_status !== "active") {
      throw new HttpError(401, "account_deleted", "Account is not active");
    }

    let sessionStatus: "active" | "legacy" = "legacy";
    if (user.authentication.sessionId) {
      const session = await tx.query<{ status: string }>(
        `SELECT status FROM auth_sessions
         WHERE provider = 'workos' AND provider_session_id = $1
           AND user_id = $2`,
        [user.authentication.sessionId, user.id],
      );
      if (session.rows[0]?.status !== "active") {
        throw new HttpError(401, "session_revoked", "Session was revoked");
      }
      sessionStatus = "active";
    }

    const organizations = await tx.query<{
      id: string;
      role: "owner" | "admin" | "member";
      authorization_revision: string | number;
      membership_revision: string | number;
      data_revision: string | number;
    }>(
      `SELECT o.id, om.role, o.authorization_revision,
              om.authorization_revision AS membership_revision,
              o.data_revision
       FROM organization_members om
       JOIN organizations o ON o.id = om.org_id AND o.deleted_at IS NULL
       WHERE om.user_id = $1
       ORDER BY o.is_personal DESC, o.created_at, o.id`,
      [user.id],
    );
    const workspaces = await tx.query<{id:string;org_id:string;role:string;access_revision:string;version:string}>(`SELECT workspace.id,workspace.org_id,workspace.version,
      cloud_workspace_read_role(workspace.id,$1) AS role,workspace.access_revision
      FROM cloud_workspaces workspace WHERE workspace.deleted_at IS NULL
        AND (workspace.owner_user_id=$1 OR workspace.org_id IN (SELECT org_id FROM organization_members WHERE user_id=$1)
          OR workspace.id IN (SELECT workspace_id FROM cloud_workspace_guest_grants WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()))
        AND cloud_workspace_read_role(workspace.id,$1) IS NOT NULL
      ORDER BY workspace.id LIMIT 1001`,[user.id]);
    const maximum = await tx.query<{ cursor: string | number }>(
      `SELECT COALESCE(max(delivery_sequence), 0) AS cursor FROM security_events`,
    );

    return {
      account: {
        id: user.id,
        status: "active" as const,
        revision: Number(account.rows[0].auth_revision),
      },
      session: {
        id: user.authentication.sessionId,
        status: sessionStatus,
      },
      organizations: organizations.rows.map((row) => ({
        id: row.id,
        role: row.role,
        authorizationRevision: Number(row.authorization_revision),
        membershipRevision: Number(row.membership_revision),
        dataRevision: Number(row.data_revision),
      })),
      workspaces: workspaces.rows.slice(0,1000).map(row=>({id:row.id,organizationId:row.org_id,role:row.role,accessRevision:Number(row.access_revision),dataRevision:Number(row.version)})),
      workspacesTruncated: workspaces.rows.length>1000,
      cursor: Number(maximum.rows[0]?.cursor ?? 0),
      generatedAt: new Date().toISOString(),
    };
  }, { consistentRead: true });
}

export async function listSecurityEvents(
  pool: pg.Pool,
  user: AuthedUser,
  after: number,
  options: { publish?: boolean; onAuthority?: (live:boolean)=>void } = {},
): Promise<SecurityEventWire[]> {
  if (options.publish !== false) await publishPendingSecurityEvents(pool);
  return withSystemTx(pool, async (tx) => {
    const live=await securityStreamAuthority(tx,user);
    options.onAuthority?.(live);
    const events = await tx.query<{
      sequence: string | number;
      kind: SecurityEventWire["kind"];
      org_id: string | null;
      workspace_id: string | null;
      account_revision: string | number | null;
      authorization_revision: string | number | null;
      data_revision: string | number | null;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT e.delivery_sequence AS sequence, e.kind, e.org_id, e.workspace_id, e.account_revision,
              e.authorization_revision, e.data_revision, e.payload,
              e.created_at
       FROM security_events e
       WHERE e.delivery_sequence > $1 AND e.expires_at > now()
         AND ($5::boolean OR (e.kind='account.revoked' AND e.user_id=$2)
           OR (e.kind='session.revoked' AND $3::text IS NOT NULL AND e.provider_session_id=$3))
         AND (
           (e.workspace_id IS NOT NULL AND (e.user_id=$2 OR (e.user_id IS NULL AND cloud_workspace_read_role(e.workspace_id,$2) IS NOT NULL)))
           OR (e.workspace_id IS NULL AND (
           (
             e.kind = 'session.revoked'
             AND $3::text IS NOT NULL
             AND e.provider_session_id = $3
           )
           OR (
             e.kind <> 'session.revoked'
             AND (
               e.user_id = $2
               OR ($3::text IS NOT NULL AND e.provider_session_id = $3)
               OR (
                 e.org_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM organization_members om
                   WHERE om.org_id = e.org_id AND om.user_id = $2
                 )
               )
             )
           )
           ))
         )
       ORDER BY e.delivery_sequence
       LIMIT $4`,
      [after, user.id, user.authentication.sessionId, EVENT_PAGE_SIZE, live],
    );
    return events.rows.map((event) => ({
      sequence: Number(event.sequence),
      kind: event.kind,
      organizationId: event.org_id,
      workspaceId: event.workspace_id,
      accountRevision:
        event.account_revision === null ? null : Number(event.account_revision),
      authorizationRevision:
        event.authorization_revision === null
          ? null
          : Number(event.authorization_revision),
      dataRevision:
        event.data_revision === null ? null : Number(event.data_revision),
      payload: event.payload,
      createdAt: event.created_at.toISOString(),
    }));
  }, {consistentRead:true});
}

type Wake = () => void;

/** One dedicated Postgres LISTEN connection per control-plane process. The
 * notification is only a wake-up; every subscriber replays durable rows. */
export class PostgresSecurityEventBroker {
  private client: pg.PoolClient | null = null;
  private starting: Promise<void> | null = null;
  private disconnect: (() => void) | null = null;
  private readonly subscribers = new Set<Wake>();
  private stopped = false;
  private wakeRevision = 0;

  constructor(private readonly pool: pg.Pool) {}

  async start(): Promise<void> {
    if (this.stopped || this.client) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const client = await this.pool.connect();
      if (this.stopped) {
        client.release(true);
        return;
      }
      let disposed = false;
      let retirement: ReturnType<typeof setTimeout> | undefined;
      const notify = () => this.wakeSubscribers();
      const disconnect = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(retirement);
        client.removeListener("notification", notify);
        if (this.client === client) {
          this.client = null;
          this.disconnect = null;
        }
        // Destroy instead of returning a session with LISTEN state to the
        // request pool. Retain the idempotent error handler until pg closes it.
        client.release(true);
        this.wakeSubscribers();
      };
      client.on("notification", notify);
      client.on("error", disconnect);
      client.on("end", disconnect);
      try {
        await client.query("LISTEN zeros_security_event");
        if (this.stopped || disposed) {
          disconnect();
          return;
        }
        this.client = client;
        this.disconnect = disconnect;
        // Pool lifetime eviction waits for release. LISTEN holds its checkout,
        // so it needs its own retirement; clients reconnect and replay rows.
        retirement = setTimeout(
          disconnect,
          DATABASE_CONNECTION_LIFETIME_SECONDS * 1_000,
        );
        retirement.unref();
      } catch (error) {
        disconnect();
        throw error;
      }
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  subscribe(wake: Wake): () => void {
    this.subscribers.add(wake);
    return () => this.subscribers.delete(wake);
  }

  healthy(): boolean {
    return this.client !== null;
  }

  revision(): number {
    return this.wakeRevision;
  }

  private wakeSubscribers(): void {
    this.wakeRevision += 1;
    for (const wake of this.subscribers) {
      try {
        wake();
      } catch {
        console.error("[security-events] subscriber wake failed");
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting?.catch(() => {});
    if (this.disconnect) this.disconnect();
    else this.wakeSubscribers();
  }
}

export function waitForSecurityEventWake(
  broker: PostgresSecurityEventBroker,
  signal: AbortSignal,
  beforeReplay: number,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = broker.subscribe(finish);
    const timer = setTimeout(finish, HEARTBEAT_MS);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted || broker.revision() !== beforeReplay) finish();
  });
}

export function createSecurityEventRoutes(
  pool: pg.Pool,
  broker: PostgresSecurityEventBroker,
): Hono {
  const app = new Hono();
  app.get("/v1/auth/snapshot", async (c) =>
    c.json(await getSecuritySnapshot(pool, c.get("user"))),
  );
  app.get("/v1/auth/events", async (c) => {
    const user = c.get("user");
    let after = cursor(
      c.req.query("after") ?? c.req.header("last-event-id") ?? null,
    );
    await broker.start();
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({
        event: "ready",
        data: JSON.stringify({ cursor: after }),
        retry: 3_000,
      });
      while (!stream.aborted && !c.req.raw.signal.aborted) {
        const beforeReplay = broker.revision();
        const published = await publishPendingSecurityEvents(pool);
        let authorityLive=true;
        const events = await listSecurityEvents(pool, user, after, { publish: false,onAuthority:live=>{authorityLive=live;} });
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.sequence),
            event: event.kind,
            data: JSON.stringify(event),
          });
          after = event.sequence;
        }
        if(!authorityLive) {
          if(!events.some(event=>event.kind==='session.revoked'||event.kind==='account.revoked')) {
            await stream.writeSSE({event:'session.revoked',data:JSON.stringify({reason:'authentication_changed'})});
          }
          break;
        }
        if (events.length === EVENT_PAGE_SIZE || published === 1000) continue;
        if (!broker.healthy()) break;
        await waitForSecurityEventWake(broker, c.req.raw.signal, beforeReplay);
        if (!stream.aborted)
          await stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
    });
  });
  return app;
}
