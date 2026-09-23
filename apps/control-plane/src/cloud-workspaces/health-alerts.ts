import { createHash } from "node:crypto";
import type pg from "pg";

import { withSystemTx } from "../db.js";
import { EmailDeliveryError } from "../email.js";
import type { CloudWorkspaceHealth } from "./health.js";

type Health = Pick<CloudWorkspaceHealth, "reasons">;

export type CloudWorkspaceHealthAlert = {
  subject: string;
  html: string;
  /** Resend requires one exact payload per key: bodies are deterministic. */
  idempotencyKey: string;
};

type State = {
  observed_reasons: string[];
  observed_reads: number;
  degraded_reads: number;
  incident: string;
  alerted_reasons: string[] | null;
  alerted_window: string | null;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REPEAT_MS = 6 * 60 * 60_000;
const MAX_READS = 1_000_000;
const RUNBOOK =
  "https://github.com/Withso/zeros/blob/main/docs/cloud-workspace/infrastructure-and-operations.md#health-alert-runbooks";

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
const same = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export function describeAlertFailure(error: unknown): string {
  if (error instanceof EmailDeliveryError)
    return `${error.code}${error.status ? ` status=${error.status}` : ""}`;
  return error instanceof Error ? error.name : "unknown";
}

/** Emails an operator when aggregate cloud health changes. Health carries no
 * tenant identifiers, so neither do alerts. Two consecutive degraded reads
 * open an incident; a changed reason set that holds for two reads, or a new
 * repeat window, sends an update; two healthy reads close the incident with a
 * recovery. State lives in one locked row, so replicas and deploys agree. */
export class CloudWorkspaceHealthAlertWorker {
  private readonly intervalMs: number;
  private readonly repeatMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<unknown> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly options: {
      pool: pg.Pool;
      /** Deployment label for subjects, e.g. "alpha/zeros-control-plane". */
      environment: string;
      read: () => Promise<Health>;
      send: (alert: CloudWorkspaceHealthAlert) => Promise<unknown>;
      intervalMs?: number;
      repeatMs?: number;
      now?: () => number;
      logger?: Pick<Console, "error">;
    },
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.repeatMs = options.repeatMs ?? DEFAULT_REPEAT_MS;
    this.now = options.now ?? Date.now;
    if (
      !/^[A-Za-z0-9._/-]{1,128}$/.test(options.environment) ||
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 1_000 ||
      this.intervalMs > 600_000 ||
      !Number.isSafeInteger(this.repeatMs) ||
      this.repeatMs < this.intervalMs ||
      this.repeatMs > 7 * 24 * 60 * 60_000
    ) {
      throw new Error("cloud workspace health alert configuration is invalid");
    }
  }

  start(): () => Promise<void> {
    if (this.started || this.stopped) {
      throw new Error("cloud workspace health alert lifecycle is invalid");
    }
    this.started = true;
    const tick = () => {
      if (this.stopped) return;
      const task = this.runOnce().catch((error: unknown) => {
        (this.options.logger ?? console).error(
          `[cloud-workspace] health alert failed: ${describeAlertFailure(error)}`,
        );
      });
      this.active = task;
      void task.finally(() => {
        if (this.active === task) this.active = null;
        if (this.stopped) return;
        this.timer = setTimeout(tick, this.intervalMs);
        this.timer.unref();
      });
    };
    tick();
    return () => this.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  /** A failed send rolls the tick back, so the next read retries the same
   * deterministic alert under the same key. */
  async runOnce(): Promise<
    "healthy" | "pending" | "alerted" | "unchanged" | "recovered"
  > {
    let reasons: string[];
    try {
      reasons = [...new Set((await this.options.read()).reasons)].sort().slice(0, 64);
    } catch {
      reasons = ["health_query_failed"];
    }
    const window = Math.floor(this.now() / this.repeatMs);
    return withSystemTx(this.options.pool, async (tx) => {
      await tx.query(
        "INSERT INTO cloud_health_alert_state (scope) VALUES ('cloud') ON CONFLICT DO NOTHING",
      );
      const state = (
        await tx.query<State>(
          `SELECT observed_reasons, observed_reads, degraded_reads, incident,
                  alerted_reasons, alerted_window
           FROM cloud_health_alert_state WHERE scope = 'cloud' FOR UPDATE`,
        )
      ).rows[0]!;
      const observedReads = same(state.observed_reasons, reasons)
        ? Math.min(state.observed_reads + 1, MAX_READS)
        : 1;
      const degradedReads =
        reasons.length === 0 ? 0 : Math.min(state.degraded_reads + 1, MAX_READS);
      let incident = Number(state.incident);
      let alerted = state.alerted_reasons;
      let alertedWindow = state.alerted_window === null ? null : Number(state.alerted_window);
      let outcome: "healthy" | "pending" | "alerted" | "unchanged" | "recovered";
      if (reasons.length === 0) {
        if (!alerted) outcome = "healthy";
        else if (observedReads < 2) outcome = "pending";
        else {
          await this.options.send(this.recovery(incident, alerted, alertedWindow!));
          alerted = null;
          alertedWindow = null;
          outcome = "recovered";
        }
      } else if (!alerted) {
        if (degradedReads < 2) outcome = "pending";
        else {
          incident += 1;
          await this.options.send(this.degraded(incident, reasons, window));
          alerted = reasons;
          alertedWindow = window;
          outcome = "alerted";
        }
      } else if (
        alertedWindow !== window ||
        (!same(alerted, reasons) && observedReads >= 2)
      ) {
        await this.options.send(this.degraded(incident, reasons, window));
        alerted = reasons;
        alertedWindow = window;
        outcome = "alerted";
      } else {
        outcome = "unchanged";
      }
      await tx.query(
        `UPDATE cloud_health_alert_state
         SET observed_reasons = $1, observed_reads = $2, degraded_reads = $3,
             incident = $4, alerted_reasons = $5, alerted_window = $6,
             updated_at = now()
         WHERE scope = 'cloud'`,
        [reasons, observedReads, degradedReads, incident, alerted, alertedWindow],
      );
      return outcome;
    });
  }

  private key(kind: string, incident: number, reasons: readonly string[], window: number): string {
    const environment = this.options.environment.replaceAll("/", ".");
    const digest = createHash("sha256").update(reasons.join(","), "utf8").digest("hex").slice(0, 16);
    return `cloud-health/${environment}/${incident}/${kind}/${digest}/${window}`;
  }

  private windowStart(window: number): string {
    return new Date(window * this.repeatMs).toISOString();
  }

  private degraded(incident: number, reasons: string[], window: number): CloudWorkspaceHealthAlert {
    return {
      subject: `[Zeros ${this.options.environment}] Cloud health degraded: ${reasons.join(", ")}`,
      html:
        `<p>Cloud workspace health on <b>${escape(this.options.environment)}</b> is degraded (incident ${incident}).</p>` +
        `<ul>${reasons.map((reason) => `<li><code>${escape(reason)}</code></li>`).join("")}</ul>` +
        `<p>Reported for the window starting ${this.windowStart(window)}; it repeats each window while degraded. ` +
        `Each reason has a response in the <a href="${RUNBOOK}">health alert runbooks</a>.</p>`,
      idempotencyKey: this.key("degraded", incident, reasons, window),
    };
  }

  private recovery(incident: number, reasons: string[], window: number): CloudWorkspaceHealthAlert {
    return {
      subject: `[Zeros ${this.options.environment}] Cloud health recovered`,
      html:
        `<p>Cloud workspace health on <b>${escape(this.options.environment)}</b> is healthy again (incident ${incident}).</p>` +
        `<p>Last reported: <code>${escape(reasons.join(", "))}</code> in the window starting ${this.windowStart(window)}.</p>`,
      idempotencyKey: this.key("recovered", incident, reasons, window),
    };
  }
}
