import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EmailDeliveryError } from "../email.js";
import { runMigrations } from "../migrate.js";
import {
  CloudWorkspaceHealthAlertWorker,
  describeAlertFailure,
  type CloudWorkspaceHealthAlert,
} from "./health-alerts.js";

describe("cloud health alert configuration", () => {
  it("rejects unsafe labels and cadences and names delivery failures", () => {
    for (const options of [
      { environment: "alpha\nBcc: x" },
      { environment: "alpha", intervalMs: 500 },
      { environment: "alpha", intervalMs: 60_000, repeatMs: 1_000 },
    ])
      expect(() => new CloudWorkspaceHealthAlertWorker({
        pool: {} as pg.Pool, read: async () => ({ reasons: [] }), send: async () => undefined, ...options,
      })).toThrow(/configuration is invalid/);
    expect(describeAlertFailure(new EmailDeliveryError("resend_429", true, 429))).toBe("resend_429 status=429");
    expect(describeAlertFailure(new TypeError("x"))).toBe("TypeError");
  });
});

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("cloud health alerts", () => {
  let pool: pg.Pool;
  let clock: number;
  let readings: Array<string[] | Error>;
  let sent: CloudWorkspaceHealthAlert[];
  let send: ReturnType<typeof vi.fn>;
  const worker = () => new CloudWorkspaceHealthAlertWorker({
    pool, environment: "alpha/zeros-control-plane", now: () => clock, send,
    read: async () => {
      const next = readings.shift();
      if (next instanceof Error) throw next;
      return { reasons: next ?? [] };
    },
  });
  /** One read per minute, as the worker's timer would space them. */
  const run = async (count: number, reasons: string[] | Error, alerts = worker()) => {
    const outcomes: string[] = [];
    for (let i = 0; i < count; i++) {
      clock += 60_000; readings.push(reasons); outcomes.push(await alerts.runOnce());
    }
    return outcomes;
  };

  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"); await runMigrations(pool);
    clock = Date.UTC(2026, 8, 23, 12, 30); readings = []; sent = [];
    send = vi.fn(async (alert: CloudWorkspaceHealthAlert) => { sent.push(alert); });
  });

  it("opens after two degraded reads and closes after two healthy reads", async () => {
    expect(await run(1, [])).toEqual(["healthy"]);
    expect(await run(3, ["outbox_stalled"])).toEqual(["pending", "alerted", "unchanged"]);
    expect(await run(3, [])).toEqual(["pending", "recovered", "healthy"]);
    expect(sent.map(alert => alert.subject)).toEqual([
      "[Zeros alpha/zeros-control-plane] Cloud health degraded: outbox_stalled",
      "[Zeros alpha/zeros-control-plane] Cloud health recovered",
    ]);
    expect(sent[0]!.html).toContain("#health-alert-runbooks");
    expect(sent[0]!.idempotencyKey).toMatch(/^cloud-health\/alpha\.zeros-control-plane\/1\/1\/degraded\/[a-f0-9]{16}\/\d+$/);
    expect(sent[1]!.idempotencyKey).toMatch(/^cloud-health\/alpha\.zeros-control-plane\/1\/1\/recovered\//);
  });

  it("survives a restart mid-incident and still sends the recovery", async () => {
    await run(2, ["lifecycle_stalled"]);
    expect(await run(2, [], worker())).toEqual(["pending", "recovered"]);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.html).toContain("lifecycle_stalled");
  });

  it("opens despite a flapping secondary reason and updates only for a set that holds", async () => {
    const alerts = worker();
    const both = ["lifecycle_stalled", "outbox_stalled"];
    const outcomes = [];
    for (const reasons of [["lifecycle_stalled"], both, ["lifecycle_stalled"], both, ["lifecycle_stalled"], ["lifecycle_stalled"]])
      outcomes.push(...await run(1, reasons, alerts));
    expect(outcomes).toEqual(["pending", "alerted", "unchanged", "unchanged", "unchanged", "alerted"]);
    expect(sent.map(alert => alert.subject.split(": ")[1])).toEqual([
      "lifecycle_stalled, outbox_stalled", "lifecycle_stalled",
    ]);
    expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
  });

  it("delivers a return to an earlier reason set as a new update", async () => {
    await run(2, ["lifecycle_stalled"]);
    await run(2, ["outbox_stalled"]);
    await run(2, ["lifecycle_stalled"]);
    expect(sent.map(alert => alert.subject.split(": ")[1])).toEqual(["lifecycle_stalled", "outbox_stalled", "lifecycle_stalled"]);
    expect(new Set(sent.map(alert => alert.idempotencyKey)).size).toBe(3);
    expect(sent[2]!.html).toContain("update 3");
  });

  it("does not count replica reads that land within half an interval", async () => {
    const [first, second] = [worker(), worker()];
    clock += 60_000;
    readings.push(["outbox_stalled"], ["outbox_stalled"]);
    expect(await first.runOnce()).toBe("pending");
    clock += 5_000;
    expect(await second.runOnce()).toBe("skipped");
    expect(await run(1, [], second)).toEqual(["healthy"]);
    expect(sent).toEqual([]);
  });

  it("repeats once per window and numbers a new incident after recovery", async () => {
    await run(2, ["outbox_stalled"]);
    clock += 60 * 60_000;
    expect(await run(1, ["outbox_stalled"])).toEqual(["unchanged"]);
    clock += 6 * 60 * 60_000;
    expect(await run(1, ["outbox_stalled"])).toEqual(["alerted"]);
    await run(2, []);
    await run(2, ["outbox_stalled"]);
    expect(sent.map(alert => alert.idempotencyKey.split("/").slice(2, 5).join("/"))).toEqual([
      "1/1/degraded", "1/2/degraded", "1/2/recovered", "2/1/degraded",
    ]);
    expect(new Set(sent.map(alert => alert.idempotencyKey)).size).toBe(4);
  });

  it("rolls back a failed send and retries the identical alert", async () => {
    send.mockRejectedValueOnce(new EmailDeliveryError("resend_500", true, 500));
    await run(1, new Error("down"));
    clock += 60_000; readings.push(new Error("down"));
    await expect(worker().runOnce()).rejects.toThrow("resend_500");
    expect(await run(1, new Error("down"))).toEqual(["alerted"]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0]).toEqual(send.mock.calls[1]![0]);
    expect(sent[0]!.subject).toContain("health_query_failed");
  });

  it("escapes reason text in bodies and keeps state private to the system role", async () => {
    await run(2, ["<b>x</b>"]);
    expect(sent[0]!.html).not.toContain("<b>x</b>");
    const client = await pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app");
      expect((await client.query("SELECT * FROM cloud_health_alert_state")).rows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
