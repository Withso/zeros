import { describe, expect, it, vi } from "vitest";

import {
  CloudWorkspaceHealthAlertWorker,
  type CloudWorkspaceHealthAlert,
} from "./health-alerts.js";

function harness(readings: Array<string[] | Error>) {
  let clock = Date.UTC(2026, 8, 23, 12);
  const sent: CloudWorkspaceHealthAlert[] = [];
  const read = vi.fn(async () => {
    const next = readings.shift();
    if (next instanceof Error) throw next;
    return { reasons: next ?? [] };
  });
  const send = vi.fn(async (alert: CloudWorkspaceHealthAlert) => {
    sent.push(alert);
  });
  const worker = new CloudWorkspaceHealthAlertWorker({
    environment: "alpha/zeros-control-plane",
    read,
    send,
    now: () => clock,
  });
  return { worker, sent, send, advance: (ms: number) => { clock += ms; } };
}

describe("cloud workspace health alerts", () => {
  it("alerts after two consecutive degraded reads and recovers once", async () => {
    const { worker, sent } = harness([
      [], ["outbox_stalled"], ["outbox_stalled"], ["outbox_stalled"], [], [],
    ]);
    expect(await worker.runOnce()).toBe("healthy");
    expect(await worker.runOnce()).toBe("pending");
    expect(await worker.runOnce()).toBe("alerted");
    expect(await worker.runOnce()).toBe("unchanged");
    expect(await worker.runOnce()).toBe("recovered");
    expect(await worker.runOnce()).toBe("healthy");
    expect(sent.map((alert) => alert.subject)).toEqual([
      "[Zeros alpha/zeros-control-plane] Cloud health degraded: outbox_stalled",
      "[Zeros alpha/zeros-control-plane] Cloud health recovered",
    ]);
    expect(sent[0]!.html).toContain("#health-alert-runbooks");
    expect(sent[0]!.idempotencyKey).toMatch(
      /^cloud-health\/alpha\.zeros-control-plane\/degraded\/[a-f0-9]{16}\/\d+$/,
    );
    expect(sent[1]!.idempotencyKey).toMatch(/^cloud-health\/alpha\.zeros-control-plane\/recovered\//);
  });

  it("ignores a single-read blip and re-evaluates a changed reason set", async () => {
    const { worker, sent } = harness([
      ["engine_lease_expired"], [], ["lifecycle_stalled"], ["lifecycle_stalled", "outbox_stalled"],
      ["outbox_stalled", "lifecycle_stalled"],
    ]);
    expect(await worker.runOnce()).toBe("pending");
    expect(await worker.runOnce()).toBe("healthy");
    expect(await worker.runOnce()).toBe("pending");
    expect(await worker.runOnce()).toBe("pending");
    expect(await worker.runOnce()).toBe("alerted");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("lifecycle_stalled, outbox_stalled");
  });

  it("repeats an unchanged alert once per window with a new idempotency key", async () => {
    const { worker, sent, advance } = harness([
      ["outbox_stalled"], ["outbox_stalled"], ["outbox_stalled"], ["outbox_stalled"],
    ]);
    await worker.runOnce();
    expect(await worker.runOnce()).toBe("alerted");
    advance(60 * 60_000);
    expect(await worker.runOnce()).toBe("unchanged");
    advance(5 * 60 * 60_000);
    expect(await worker.runOnce()).toBe("alerted");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
  });

  it("treats a failed health read as a reason and retries a failed send", async () => {
    const { worker, send } = harness([new Error("down"), new Error("down"), new Error("down")]);
    send.mockRejectedValueOnce(new Error("provider"));
    expect(await worker.runOnce()).toBe("pending");
    await expect(worker.runOnce()).rejects.toThrow("provider");
    expect(await worker.runOnce()).toBe("alerted");
    expect(send.mock.calls.at(-1)![0].subject).toContain("health_query_failed");
  });

  it("escapes values in alert bodies and rejects unsafe configuration", async () => {
    const { worker, sent } = harness([["<b>x</b>"], ["<b>x</b>"]]);
    await worker.runOnce();
    await worker.runOnce();
    expect(sent[0]!.html).not.toContain("<b>x</b>");
    for (const options of [
      { environment: "alpha\nBcc: x" },
      { environment: "alpha", intervalMs: 500 },
      { environment: "alpha", intervalMs: 60_000, repeatMs: 1_000 },
    ])
      expect(
        () => new CloudWorkspaceHealthAlertWorker({
          read: async () => ({ reasons: [] }), send: async () => undefined, ...options,
        }),
      ).toThrow(/configuration is invalid/);
  });
});
