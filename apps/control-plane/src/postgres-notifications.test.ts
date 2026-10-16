import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresSecurityEventBroker } from "./security-events.js";
import { startCloudWorkerNotifications } from "./cloud-workspaces/worker-notifications.js";
import { CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, startCloudEngineCheckpointHintNotifications } from "./cloud-workspaces/engine-checkpoint-hints.js";
import { COMPUTER_TEMPLATE_RETENTION_CHANNEL, CloudComputerTemplateRetentionWorker } from "./cloud-workspaces/computer-template-retention.js";
import { postgresNotificationSubscription } from "./postgres-notifications.js";

const organization = "11111111-1111-4111-8111-111111111111";
function client() {
  return Object.assign(new EventEmitter(), { query: vi.fn(async (_sql: string) => ({ rows: [] })), release: vi.fn() });
}
function fixture() {
  vi.useFakeTimers();
  const clients: ReturnType<typeof client>[] = [];
  const connect = vi.fn(async () => { const next = client(); clients.push(next); return next; });
  const pool = { connect } as unknown as pg.Pool;
  const broker = new PostgresSecurityEventBroker(pool), security = vi.fn();
  broker.subscribe(security);
  const workos = vi.fn(), hints = { notify: vi.fn(), notifyAll: vi.fn() }, warn = vi.fn();
  const retention = new CloudComputerTemplateRetentionWorker(pool, {
    accountScope: "synthetic", billingOrg: "synthetic",
    journal: { find: vi.fn(), state: vi.fn(), deletion: vi.fn() },
    client: { request: vi.fn() }, logger: { warn },
  });
  const sweep = vi.spyOn(retention, "tick").mockResolvedValue(0);
  const stopWorker = startCloudWorkerNotifications(pool, { workos }, { warn });
  const stopHints = startCloudEngineCheckpointHintNotifications(pool, hints, { warn });
  const stopRetention = retention.start(pool);
  const stop = async () => { await Promise.all([stopWorker(), stopHints(), stopRetention(), broker.stop()]); };
  return { clients, connect, pool, broker, security, workos, hints, sweep, warn, stopWorker, stopHints, stopRetention, stop };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("shared PostgreSQL notifications", () => {
  it("does not evict healthy shared LISTEN consumers at the query pool's ten-minute lifetime", async () => {
    const f = fixture();
    try {
      await f.broker.start();
      await vi.advanceTimersByTimeAsync(0);
      f.workos.mockClear(); f.hints.notifyAll.mockClear(); f.warn.mockClear();
      const statements = f.clients[0]!.query.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(f.connect).toHaveBeenCalledOnce();
      expect(f.clients[0]!.release).not.toHaveBeenCalled();
      expect(f.broker.healthy()).toBe(true);
      expect(f.workos).not.toHaveBeenCalled();
      expect(f.hints.notifyAll).not.toHaveBeenCalled();
      expect(f.warn).not.toHaveBeenCalled();
      expect(f.clients[0]!.query).toHaveBeenCalledTimes(statements);
    } finally { await f.stop(); }
  });

  it("still retires the held session before 24 hours and replays once on its replacement", async () => {
    vi.useFakeTimers();
    const first = client(), replacement = client(), ready = vi.fn(), unavailable = vi.fn();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(replacement);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const subscription = postgresNotificationSubscription({ connect } as unknown as pg.Pool, {
      channels: ["test_hint"], onNotification: vi.fn(), onReady: ready, onUnavailable: unavailable,
    });
    try {
      await subscription.start(); info.mockClear();
      await vi.advanceTimersByTimeAsync(23 * 60 * 60_000 - 1);
      expect(first.release).not.toHaveBeenCalled();
      expect(first.query).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(first.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(unavailable).toHaveBeenCalledOnce();
      expect(subscription.healthy()).toBe(false);
      expect(info).toHaveBeenCalledExactlyOnceWith("[database] notification listener rotating at lifetime limit");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(subscription.healthy()).toBe(true);
      expect(ready).toHaveBeenCalledTimes(2);
      expect(info).toHaveBeenLastCalledWith("[database] notification listener restored");
    } finally { await subscription.stop(); }
    expect(replacement.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("announces recovery only after all renewed LISTEN acknowledgements, without a reconnect storm", async () => {
    const f = fixture(), info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await f.broker.start();
      await vi.advanceTimersByTimeAsync(0);
      info.mockClear(); f.workos.mockClear(); f.hints.notifyAll.mockClear();
      const old = f.clients[0]!;
      old.emit("error", new Error("synthetic private idle close")); old.emit("end");
      f.connect.mockRejectedValueOnce(new Error("synthetic private reconnect failure"));
      await vi.advanceTimersByTimeAsync(999);
      expect(f.connect).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(info).not.toHaveBeenCalled();
      let acknowledge!: () => void;
      const renewed = client();
      renewed.query.mockImplementationOnce(() => new Promise(resolve => { acknowledge = () => resolve({ rows: [] }); }));
      f.connect.mockImplementationOnce(async () => { f.clients.push(renewed); return renewed; });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(f.connect).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.connect).toHaveBeenCalledTimes(3);
      expect(info).not.toHaveBeenCalled();
      expect(f.workos).not.toHaveBeenCalled();
      acknowledge();
      await vi.advanceTimersByTimeAsync(0);
      expect(info).toHaveBeenCalledExactlyOnceWith("[database] notification listener restored");
      expect(f.workos).toHaveBeenCalledOnce();
      expect(f.hints.notifyAll).toHaveBeenCalledOnce();
      expect(f.broker.healthy()).toBe(false);
      old.emit("error", new Error("synthetic late socket error"));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.connect).toHaveBeenCalledTimes(3);
      expect(info).toHaveBeenCalledTimes(1);
      expect(old.release).toHaveBeenCalledExactlyOnceWith(true);
    } finally { await f.stop(); }
  });

  it("serves all four consumers through one checked-out connection", async () => {
    const f = fixture();
    try {
      await f.broker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.connect).toHaveBeenCalledTimes(1);
      const sql = f.clients[0]!.query.mock.calls.map(([text]) => text).join("; ");
      for (const channel of ["zeros_account_maintenance_work", "zeros_security_event", CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, COMPUTER_TEMPLATE_RETENTION_CHANNEL]) {
        expect(sql).toContain(`LISTEN ${channel}`);
      }
      expect(f.broker.healthy()).toBe(true);
      expect(f.workos).toHaveBeenCalledOnce();
      expect(f.hints.notifyAll).toHaveBeenCalledOnce();
    } finally { await f.stop(); }
    expect(f.clients[0]!.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes only the matching hints and keeps the other consumers alive when one stops", async () => {
    const f = fixture();
    try {
      await f.broker.start();
      await vi.advanceTimersByTimeAsync(0);
      f.workos.mockClear(); f.hints.notify.mockClear(); f.sweep.mockClear(); f.security.mockClear();
      const connection = f.clients[0]!;
      connection.emit("notification", { channel: "zeros_account_maintenance_work", payload: "private" });
      connection.emit("notification", { channel: COMPUTER_TEMPLATE_RETENTION_CHANNEL, payload: "invalid" });
      connection.emit("notification", { channel: "unknown", payload: "" });
      expect(f.workos).not.toHaveBeenCalled();
      expect(f.sweep).not.toHaveBeenCalled();
      expect(f.security).not.toHaveBeenCalled();
      connection.emit("notification", { channel: "zeros_account_maintenance_work", payload: "" });
      connection.emit("notification", { channel: CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, payload: `${organization}:1` });
      connection.emit("notification", { channel: COMPUTER_TEMPLATE_RETENTION_CHANNEL, payload: organization });
      connection.emit("notification", { channel: "zeros_security_event", payload: "" });
      expect(f.workos).toHaveBeenCalledOnce();
      expect(f.hints.notify).toHaveBeenCalledExactlyOnceWith(`${organization}:1`);
      expect(f.sweep).toHaveBeenCalledExactlyOnceWith(organization);
      expect(f.security).toHaveBeenCalledOnce();
      await f.stopWorker();
      expect(connection.release).not.toHaveBeenCalled();
      connection.emit("notification", { channel: "zeros_account_maintenance_work", payload: "" });
      connection.emit("notification", { channel: "zeros_security_event", payload: "" });
      expect(f.workos).toHaveBeenCalledOnce();
      expect(f.security).toHaveBeenCalledTimes(2);
    } finally { await f.stop(); }
  });

  it("repairs every durable queue after disconnect, but leaves security streams unhealthy until explicitly restarted", async () => {
    const f = fixture();
    try {
      await f.broker.start();
      await vi.advanceTimersByTimeAsync(0);
      f.workos.mockClear(); f.hints.notifyAll.mockClear(); f.sweep.mockClear(); f.security.mockClear();
      f.clients[0]!.emit("error", new Error("synthetic disconnect"));
      expect(f.broker.healthy()).toBe(false);
      expect(f.security).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(f.workos).toHaveBeenCalledOnce();
      expect(f.hints.notifyAll).toHaveBeenCalledOnce();
      expect(f.sweep).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(f.broker.healthy()).toBe(false);
      await f.broker.start();
      expect(f.broker.healthy()).toBe(true);
      expect(f.connect).toHaveBeenCalledTimes(2);
    } finally { await f.stop(); }
  });

  it("joins an already listening security session without acquiring a second connection", async () => {
    vi.useFakeTimers();
    const connection = client(), connect = vi.fn(async () => connection), wake = vi.fn();
    const pool = { connect } as unknown as pg.Pool;
    const broker = new PostgresSecurityEventBroker(pool);
    await broker.start();
    const stopWorker = startCloudWorkerNotifications(pool, { workos: wake });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(connect).toHaveBeenCalledOnce();
      expect(wake).toHaveBeenCalledOnce();
      await broker.stop();
      expect(connection.release).not.toHaveBeenCalled();
      connection.emit("notification", { channel: "zeros_account_maintenance_work", payload: "" });
      expect(wake).toHaveBeenCalledTimes(2);
    } finally { await stopWorker(); await broker.stop(); }
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not hold an explicit security reconnect behind the worker backoff timer", async () => {
    const f = fixture();
    try {
      await f.broker.start();
      await vi.advanceTimersByTimeAsync(0);
      f.clients[0]!.emit("end");
      const starting = f.broker.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.broker.healthy()).toBe(true);
      expect(f.connect).toHaveBeenCalledTimes(2);
      await starting;
    } finally { await f.stop(); }
  });

  it("fails initial callers once and repairs automatic consumers after a failed LISTEN", async () => {
    const f = fixture();
    const failed = client();
    failed.query.mockRejectedValueOnce(new Error("synthetic private driver detail"));
    f.connect.mockImplementationOnce(async () => { f.clients.push(failed); return failed; });
    try {
      await expect(f.broker.start()).rejects.toThrow("synthetic private driver detail");
      await vi.advanceTimersByTimeAsync(0);
      expect(failed.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(f.security).toHaveBeenCalledOnce();
      expect(f.warn).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(f.warn.mock.calls)).not.toContain("private");
      expect(f.broker.healthy()).toBe(false);
      f.sweep.mockClear();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.connect).toHaveBeenCalledTimes(2);
      expect(f.workos).toHaveBeenCalledOnce();
      expect(f.hints.notifyAll).toHaveBeenCalledOnce();
      expect(f.sweep).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(f.broker.healthy()).toBe(false);
    } finally { await f.stop(); }
  });

  it("keeps listeners for different database pools isolated", async () => {
    const first = client(), second = client(), firstWake = vi.fn(), secondWake = vi.fn();
    const firstSubscription = postgresNotificationSubscription({ connect: async () => first } as unknown as pg.Pool,
      { channels: ["test_hint"], onNotification: firstWake });
    const secondSubscription = postgresNotificationSubscription({ connect: async () => second } as unknown as pg.Pool,
      { channels: ["test_hint"], onNotification: secondWake });
    try {
      await Promise.all([firstSubscription.start(), secondSubscription.start()]);
      first.emit("notification", { channel: "test_hint", payload: "" });
      expect(firstWake).toHaveBeenCalledOnce();
      expect(secondWake).not.toHaveBeenCalled();
      await firstSubscription.stop();
      expect(second.release).not.toHaveBeenCalled();
      second.emit("notification", { channel: "test_hint", payload: "" });
      expect(secondWake).toHaveBeenCalledOnce();
    } finally { await Promise.all([firstSubscription.stop(), secondSubscription.stop()]); }
  });

  it("keeps a stopped consumer inert when another channel's LISTEN acknowledgement is delayed", async () => {
    vi.useFakeTimers();
    const connection = client(), pool = { connect: vi.fn(async () => connection) } as unknown as pg.Pool;
    const broker = new PostgresSecurityEventBroker(pool);
    await broker.start();
    let acknowledge!: () => void;
    connection.query.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { acknowledge = resolve; });
      return { rows: [] };
    });
    const wake = vi.fn();
    const stopWorker = startCloudWorkerNotifications(pool, { workos: wake });
    await vi.advanceTimersByTimeAsync(0);
    await stopWorker();
    acknowledge();
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.healthy()).toBe(true);
    expect(wake).not.toHaveBeenCalled();
    connection.emit("notification", { channel: "zeros_account_maintenance_work", payload: "" });
    expect(wake).not.toHaveBeenCalled();
    await broker.stop();
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a late acquisition once after every consumer stops, without issuing LISTEN", async () => {
    vi.useFakeTimers();
    let acquire!: (value: ReturnType<typeof client>) => void;
    const connection = client(), connect = vi.fn(() => new Promise<ReturnType<typeof client>>(resolve => { acquire = resolve; }));
    const pool = { connect } as unknown as pg.Pool;
    const workos = vi.fn(), notify = vi.fn(), notifyAll = vi.fn();
    const stopWorker = startCloudWorkerNotifications(pool, { workos });
    const stopHints = startCloudEngineCheckpointHintNotifications(pool, { notify, notifyAll });
    await vi.advanceTimersByTimeAsync(0);
    const stopping = Promise.all([stopWorker(), stopHints()]);
    acquire(connection);
    await stopping;
    expect(connect).toHaveBeenCalledOnce();
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(connection.query).not.toHaveBeenCalled();
    expect(workos).not.toHaveBeenCalled();
    expect(notifyAll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fans out a notification even if another consumer throws, without logging its error", async () => {
    const connection = client(), pool = { connect: async () => connection } as unknown as pg.Pool;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {}), wake = vi.fn();
    const first = postgresNotificationSubscription(pool, { channels: ["test_hint"],
      onNotification: () => { throw new Error("synthetic private detail"); } });
    const second = postgresNotificationSubscription(pool, { channels: ["test_hint"], onNotification: wake });
    try {
      await Promise.all([first.start(), second.start()]);
      connection.emit("notification", { channel: "test_hint", payload: "synthetic private payload" });
      expect(wake).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
      expect(first.healthy()).toBe(true);
      expect(second.healthy()).toBe(true);
    } finally { await Promise.all([first.stop(), second.stop()]); }
  });

  it("rejects non-static SQL identifiers before acquiring a connection", () => {
    const connect = vi.fn(), pool = { connect } as unknown as pg.Pool;
    for (const channel of ["", "test; SELECT 1", "test\nchannel", "quoted\"channel", "a".repeat(64)]) {
      expect(() => postgresNotificationSubscription(pool, { channels: [channel], onNotification: vi.fn() }))
        .toThrow("invalid_database_notification_channel");
    }
    expect(connect).not.toHaveBeenCalled();
  });
});
