import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type pg from "pg";

import type { AuthedUser } from "./auth.js";
import { HttpError } from "./authz.js";
import { withSystemTx } from "./db.js";

const EVENT_PAGE_SIZE = 100;
const HEARTBEAT_MS = 25_000;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;

export type SecurityEventWire = {
  sequence: number;
  kind:
    | "account.revoked"
    | "account.authorization_changed"
    | "session.revoked"
    | "organization.access_revoked"
    | "organization.authorization_changed"
    | "organization.data_changed";
  organizationId: string | null;
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

export async function getSecuritySnapshot(
  pool: pg.Pool,
  user: AuthedUser,
): Promise<SecuritySnapshot> {
  return withSystemTx(pool, async (tx) => {
    const account = await tx.query<{
      auth_status: string;
      auth_revision: string | number;
    }>(
      `SELECT auth_status, auth_revision FROM users WHERE id = $1`,
      [user.id],
    );
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
    const maximum = await tx.query<{ cursor: string | number }>(
      `SELECT COALESCE(max(sequence), 0) AS cursor FROM security_events`,
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
      cursor: Number(maximum.rows[0]?.cursor ?? 0),
      generatedAt: new Date().toISOString(),
    };
  });
}

export async function listSecurityEvents(
  pool: pg.Pool,
  user: AuthedUser,
  after: number,
): Promise<SecurityEventWire[]> {
  return withSystemTx(pool, async (tx) => {
    const events = await tx.query<{
      sequence: string | number;
      kind: SecurityEventWire["kind"];
      org_id: string | null;
      account_revision: string | number | null;
      authorization_revision: string | number | null;
      data_revision: string | number | null;
      payload: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT e.sequence, e.kind, e.org_id, e.account_revision,
              e.authorization_revision, e.data_revision, e.payload,
              e.created_at
       FROM security_events e
       WHERE e.sequence > $1 AND e.expires_at > now()
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
       ORDER BY e.sequence
       LIMIT $4`,
      [after, user.id, user.authentication.sessionId, EVENT_PAGE_SIZE],
    );
    return events.rows.map((event) => ({
      sequence: Number(event.sequence),
      kind: event.kind,
      organizationId: event.org_id,
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
  });
}

type Wake = () => void;

/** One dedicated Postgres LISTEN connection per control-plane process. The
 * notification is only a wake-up; every subscriber replays durable rows. */
export class PostgresSecurityEventBroker {
  private client: pg.PoolClient | null = null;
  private starting: Promise<void> | null = null;
  private readonly subscribers = new Set<Wake>();
  private stopped = false;

  constructor(private readonly pool: pg.Pool) {}

  async start(): Promise<void> {
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const client = await this.pool.connect();
      if (this.stopped) {
        client.release();
        return;
      }
      client.on("notification", () => {
        for (const wake of this.subscribers) wake();
      });
      client.on("error", () => {
        if (this.client === client) this.client = null;
        for (const wake of this.subscribers) wake();
      });
      await client.query("LISTEN zeros_security_event");
      this.client = client;
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

  async stop(): Promise<void> {
    this.stopped = true;
    await this.starting;
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query("UNLISTEN zeros_security_event").catch(() => {});
      client.release();
    }
    for (const wake of this.subscribers) wake();
  }
}

function waitForWake(
  broker: PostgresSecurityEventBroker,
  signal: AbortSignal,
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
        const events = await listSecurityEvents(pool, user, after);
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.sequence),
            event: event.kind,
            data: JSON.stringify(event),
          });
          after = event.sequence;
        }
        if (events.length === EVENT_PAGE_SIZE) continue;
        if (!broker.healthy()) break;
        await waitForWake(broker, c.req.raw.signal);
        if (!stream.aborted) await stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
    });
  });
  return app;
}
