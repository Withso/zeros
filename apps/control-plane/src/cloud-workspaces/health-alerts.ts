import { createHash } from "node:crypto";

import type { CloudWorkspaceHealth } from "./health.js";

type Health = Pick<CloudWorkspaceHealth, "reasons">;

export type CloudWorkspaceHealthAlert = {
  subject: string;
  html: string;
  /** Stable for one alert in one repeat window, across restarts and replicas. */
  idempotencyKey: string;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REPEAT_MS = 6 * 60 * 60_000;
const RUNBOOK =
  "https://github.com/Withso/zeros/blob/main/docs/cloud-workspace/infrastructure-and-operations.md#health-alert-runbooks";

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

/** Emails an operator when aggregate cloud health changes. Health carries no
 * tenant identifiers, so neither do alerts. A degraded reason set must persist
 * for two consecutive reads before it alerts, repeats while unchanged once per
 * window, and a recovery follows its alert. Provider idempotency keys make a
 * restart or a second replica send each alert once per window. */
export class CloudWorkspaceHealthAlertWorker {
  private readonly intervalMs: number;
  private readonly repeatMs: number;
  private readonly now: () => number;
  private candidate: string | null = null;
  private alerted: { reasons: string; at: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<unknown> | null = null;
  private started = false;
  private stopped = false;

  constructor(
    private readonly options: {
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
          `[cloud-workspace] health alert failed: ${
            error instanceof Error ? error.name : "unknown"
          }`,
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

  async runOnce(): Promise<
    "healthy" | "pending" | "alerted" | "unchanged" | "recovered"
  > {
    let reasons: string[];
    try {
      reasons = [...new Set((await this.options.read()).reasons)].sort();
    } catch {
      reasons = ["health_query_failed"];
    }
    const now = this.now();
    if (reasons.length === 0) {
      this.candidate = null;
      if (!this.alerted) return "healthy";
      await this.options.send(this.recovery(this.alerted, now));
      this.alerted = null;
      return "recovered";
    }
    const key = reasons.join(",");
    if (this.candidate !== key) {
      this.candidate = key;
      return "pending";
    }
    if (this.alerted?.reasons === key && now - this.alerted.at < this.repeatMs)
      return "unchanged";
    await this.options.send(this.degraded(reasons, now));
    this.alerted = { reasons: key, at: now };
    return "alerted";
  }

  private digest(reasons: string): string {
    return createHash("sha256").update(reasons, "utf8").digest("hex").slice(0, 16);
  }

  private key(kind: string, reasons: string, at: number): string {
    const environment = this.options.environment.replaceAll("/", ".");
    return `cloud-health/${environment}/${kind}/${this.digest(reasons)}/${Math.floor(at / this.repeatMs)}`;
  }

  private degraded(reasons: string[], now: number): CloudWorkspaceHealthAlert {
    const environment = escape(this.options.environment);
    return {
      subject: `[Zeros ${this.options.environment}] Cloud health degraded: ${reasons.join(", ")}`,
      html:
        `<p>Cloud workspace health on <b>${environment}</b> has been degraded for at least two consecutive checks.</p>` +
        `<ul>${reasons.map((reason) => `<li><code>${escape(reason)}</code></li>`).join("")}</ul>` +
        `<p>Observed ${new Date(now).toISOString()}. Each reason has a response in the <a href="${RUNBOOK}">health alert runbooks</a>. ` +
        `This alert repeats while the same reasons persist.</p>`,
      idempotencyKey: this.key("degraded", reasons.join(","), now),
    };
  }

  private recovery(
    alerted: { reasons: string; at: number },
    now: number,
  ): CloudWorkspaceHealthAlert {
    return {
      subject: `[Zeros ${this.options.environment}] Cloud health recovered`,
      html:
        `<p>Cloud workspace health on <b>${escape(this.options.environment)}</b> is healthy again.</p>` +
        `<p>Previously degraded: <code>${escape(alerted.reasons)}</code> (alerted ${new Date(alerted.at).toISOString()}); ` +
        `recovered ${new Date(now).toISOString()}.</p>`,
      idempotencyKey: this.key("recovered", alerted.reasons, alerted.at),
    };
  }
}
