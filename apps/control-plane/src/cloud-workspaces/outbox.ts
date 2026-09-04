import { createHmac, randomUUID } from "node:crypto";

import type pg from "pg";

import { withSystemTx } from "../db.js";

export type CloudWorkspaceOutboxEvent = {
  id: string;
  sequence: number;
  organizationId: string;
  workspaceId: string | null;
  eventType: string;
  aggregateKey: string;
  aggregateRevision: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attempt: number;
};

export interface CloudWorkspaceOutboxSink {
  deliver(event: CloudWorkspaceOutboxEvent, signal: AbortSignal): Promise<void>;
}

export class CloudWorkspaceOutboxDeliveryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super("Cloud workspace event delivery did not complete", options);
    this.name = "CloudWorkspaceOutboxDeliveryError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Signed, redirect-free webhook delivery for a hosted or customer-managed
 * event consumer. The idempotency key and sequence are authenticated inside
 * the body as well as carried in headers for ordinary receiver middleware. */
export class HttpCloudWorkspaceOutboxSink implements CloudWorkspaceOutboxSink {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly signingSecret: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      signingSecret.length < 32 ||
      signingSecret.length > 4_096 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 60_000
    ) {
      throw new Error("cloud workspace outbox sink configuration is invalid");
    }
    this.endpoint = url.toString();
  }

  async deliver(
    event: CloudWorkspaceOutboxEvent,
    outerSignal: AbortSignal,
  ): Promise<void> {
    const body = canonicalJson({ schemaVersion: 1, event });
    const signature = createHmac("sha256", this.signingSecret)
      .update(body, "utf8")
      .digest("base64url");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([outerSignal, timeout]);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          "content-type": "application/json",
          "x-zeros-event-id": event.id,
          "x-zeros-idempotency-key": event.idempotencyKey,
          "x-zeros-signature-v1": signature,
        },
        body,
      });
    } catch (error) {
      throw new CloudWorkspaceOutboxDeliveryError(
        signal.aborted ? "outbox_delivery_timeout" : "outbox_transport_error",
        true,
        { cause: error },
      );
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await response.body?.cancel().catch(() => undefined);
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new CloudWorkspaceOutboxDeliveryError(
      `outbox_http_${response.status}`,
      retryable,
    );
  }
}

type ClaimedOutboxEvent = CloudWorkspaceOutboxEvent & { leaseOwner: string };

function retryDelayMs(attempt: number): number {
  return Math.min(15 * 60_000, 1_000 * 2 ** Math.min(attempt - 1, 9));
}

function safeFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof CloudWorkspaceOutboxDeliveryError) {
    return {
      code: error.code.slice(0, 128),
      retryable: error.retryable,
    };
  }
  return { code: "outbox_unknown_failure", retryable: true };
}

export class CloudWorkspaceOutboxWorker {
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopped = false;
  private started = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly sink: CloudWorkspaceOutboxSink,
    private readonly options: {
      intervalMs?: number;
      leaseMs?: number;
      maxAttempts?: number;
      workerId?: string;
      logger?: Pick<Console, "warn" | "error">;
    } = {},
  ) {
    const intervalMs = options.intervalMs ?? 1_000;
    const leaseMs = options.leaseMs ?? 30_000;
    const maxAttempts = options.maxAttempts ?? 12;
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs < 100 ||
      intervalMs > 300_000 ||
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1_000 ||
      leaseMs > 3_600_000 ||
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 100
    ) {
      throw new Error("cloud workspace outbox worker configuration is invalid");
    }
    this.workerId = options.workerId ?? `cloud-outbox:${randomUUID()}`;
    if (
      this.workerId.length < 1 ||
      this.workerId.length > 255 ||
      /[\u0000-\u001f\u007f]/u.test(this.workerId)
    ) {
      throw new Error("cloud workspace outbox worker identity is invalid");
    }
  }

  private get intervalMs(): number {
    return this.options.intervalMs ?? 1_000;
  }

  private get leaseMs(): number {
    return this.options.leaseMs ?? 30_000;
  }

  private get maxAttempts(): number {
    return this.options.maxAttempts ?? 12;
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) {
      throw new Error("cloud workspace outbox worker lifecycle is invalid");
    }
    this.started = true;
    const run = () => {
      if (this.stopped) return;
      const task = this.drain().catch((error) => {
        (this.options.logger ?? console).error(
          `[cloud-workspace] outbox tick failed: ${
            error instanceof Error ? error.name : "unknown"
          }`,
        );
      });
      this.active = task;
      void task.finally(() => {
        if (this.active === task) this.active = null;
        if (this.stopped) return;
        this.timer = setTimeout(run, this.intervalMs);
        this.timer.unref();
      });
    };
    run();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  private async drain(): Promise<void> {
    for (let processed = 0; processed < 100 && !this.stopped; processed += 1) {
      if (!(await this.runOnce())) return;
    }
  }

  private async claim(): Promise<ClaimedOutboxEvent | null> {
    return withSystemTx(this.pool, async (tx) => {
      const row = (
        await tx.query<{
          id: string;
          sequence: string | number;
          org_id: string;
          workspace_id: string | null;
          event_type: string;
          aggregate_key: string;
          aggregate_revision: string | number;
          idempotency_key: string;
          payload: Record<string, unknown>;
          created_at: Date | string;
          attempt_count: number;
        }>(
          `WITH candidate AS (
             SELECT id FROM cloud_workspace_outbox
             WHERE (
               state = 'queued' AND next_attempt_at <= now()
             ) OR (
               state = 'processing' AND lease_expires_at <= now()
             )
             ORDER BY sequence
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE cloud_workspace_outbox event
           SET state = 'processing', attempt_count = attempt_count + 1,
               lease_owner = $1,
               lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
               last_error_code = NULL, last_error_at = NULL
           FROM candidate
           WHERE event.id = candidate.id
           RETURNING event.id, event.sequence, event.org_id,
                     event.workspace_id, event.event_type, event.aggregate_key,
                     event.aggregate_revision, event.idempotency_key,
                     event.payload, event.created_at, event.attempt_count`,
          [this.workerId, this.leaseMs],
        )
      ).rows[0];
      if (!row) return null;
      return {
        id: row.id,
        sequence: Number(row.sequence),
        organizationId: row.org_id,
        workspaceId: row.workspace_id,
        eventType: row.event_type,
        aggregateKey: row.aggregate_key,
        aggregateRevision: Number(row.aggregate_revision),
        idempotencyKey: row.idempotency_key,
        payload: row.payload,
        createdAt: new Date(row.created_at).toISOString(),
        attempt: row.attempt_count,
        leaseOwner: this.workerId,
      };
    });
  }

  async runOnce(): Promise<boolean> {
    const event = await this.claim();
    if (!event) return false;
    const controller = new AbortController();
    try {
      await this.sink.deliver(event, controller.signal);
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_outbox
           SET state = 'succeeded', completed_at = now(),
               lease_owner = NULL, lease_expires_at = NULL
           WHERE id = $1 AND state = 'processing' AND lease_owner = $2`,
          [event.id, event.leaseOwner],
        ),
      );
    } catch (error) {
      const failure = safeFailure(error);
      const dead = !failure.retryable || event.attempt >= this.maxAttempts;
      await withSystemTx(this.pool, (tx) =>
        tx.query(
          `UPDATE cloud_workspace_outbox
           SET state = CASE WHEN $3 THEN 'dead' ELSE 'queued' END,
               next_attempt_at = CASE
                 WHEN $3 THEN next_attempt_at
                 ELSE now() + ($4::bigint * interval '1 millisecond')
               END,
               completed_at = CASE WHEN $3 THEN now() ELSE NULL END,
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = $5, last_error_at = now()
           WHERE id = $1 AND state = 'processing' AND lease_owner = $2`,
          [
            event.id,
            event.leaseOwner,
            dead,
            retryDelayMs(event.attempt),
            failure.code,
          ],
        ),
      );
      (this.options.logger ?? console).warn(
        `[cloud-workspace] outbox delivery failed (${failure.code})`,
      );
    } finally {
      controller.abort();
    }
    return true;
  }
}
