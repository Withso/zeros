import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmailConfig } from "./email.js";
import type { WorkOSManagementProvider } from "./workos-provider.js";

const ticks = vi.hoisted(() => ({
  commands: vi.fn(async () => 0),
  events: vi.fn(async () => 0),
  notifications: vi.fn(async () => 0),
  deletions: vi.fn(async () => 0),
}));

vi.mock("./workos-command-outbox.js", () => ({
  WorkOSCommandProcessor: class {
    tick = ticks.commands;
  },
}));

vi.mock("./workos-sync-events.js", () => ({
  WorkOSEventsReconciler: class {
    tick = ticks.events;
  },
}));

vi.mock("./security-notification-outbox.js", () => ({
  SecurityNotificationDeliveryError: class extends Error {},
  SecurityNotificationProcessor: class {
    tick = ticks.notifications;
  },
}));

vi.mock("./deletion-lifecycle.js", () => ({
  DeletionLifecycleProcessor: class {
    tick = ticks.deletions;
  },
}));

import {
  startWorkOSSyncRuntime,
  type WorkOSSyncRuntimeOptions,
} from "./workos-sync-runtime.js";

function options(
  overrides: Partial<WorkOSSyncRuntimeOptions> & {
    deletionLifecycleEnabled?: boolean;
  } = {},
): WorkOSSyncRuntimeOptions {
  const client = {
    query: vi.fn(async (sql: string) => ({ rows: sql.includes("delay_ms")
      ? [{ kind: "commands", delay_ms: 0 }, { kind: "notifications", delay_ms: 0 }] : [] })),
    release: vi.fn(),
  };
  return {
    pool: { connect: async () => client } as unknown as pg.Pool,
    provider: {} as WorkOSManagementProvider,
    email: {} as EmailConfig,
    commandIntervalMs: 60_000,
    eventIntervalMs: 60_000,
    notificationIntervalMs: 60_000,
    deletionIntervalMs: 60_000,
    ...overrides,
  } as WorkOSSyncRuntimeOptions;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("keeps empty WorkOS queues quiet for sixty seconds while retaining notification wakes", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const query = vi.fn(async () => ({ rows: [] }));
  const runtime = startWorkOSSyncRuntime(options({
    pool: { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool,
    commandIntervalMs: undefined, notificationIntervalMs: undefined, deletionIntervalMs: undefined,
  }));
  try {
    await vi.advanceTimersByTimeAsync(0);
    const initial = query.mock.calls.length;
    expect(initial).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(query).toHaveBeenCalledTimes(initial);
    await vi.advanceTimersByTimeAsync(1);
    const periodic = query.mock.calls.length;
    expect(periodic).toBeGreaterThan(initial);
    runtime.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(query.mock.calls.length).toBeGreaterThan(periodic);
  } finally { await runtime.stop(); }
});

describe("WorkOS sync runtime migration boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the deletion lifecycle stopped while its controlled migration is pending", async () => {
    const runtime = startWorkOSSyncRuntime(
      options({ deletionLifecycleEnabled: false }),
    );

    await vi.waitFor(() => {
      expect(ticks.commands).toHaveBeenCalledTimes(1);
      expect(ticks.notifications).toHaveBeenCalledTimes(1);
    });
    await runtime.stop();

    expect(ticks.commands).toHaveBeenCalledTimes(1);
    expect(ticks.events).toHaveBeenCalledTimes(1);
    expect(ticks.notifications).toHaveBeenCalledTimes(1);
    expect(ticks.deletions).not.toHaveBeenCalled();
  });
});
