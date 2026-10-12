import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailConfig } from "./email.js";
import type { WorkOSManagementProvider } from "./workos-provider.js";
const ticks = vi.hoisted(() => ({
  commands: vi.fn(async () => 0),
  notifications: vi.fn(async () => 0),
  deletions: vi.fn(async () => 0),
  events: vi.fn(async () => 0),
}));
vi.mock("./workos-command-outbox.js", () => ({
  WorkOSCommandProcessor: class {
    tick = ticks.commands;
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
vi.mock("./workos-sync-events.js", () => ({
  WorkOSEventsReconciler: class {
    tick = ticks.events;
  },
}));
import { startWorkOSSyncRuntime } from "./workos-sync-runtime.js";
function fixture() {
  const statements: string[] = [];
  let rows: Array<{ kind: string; delay_ms: number }> = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      return { rows: sql.includes("delay_ms") ? rows : [], rowCount: 0 };
    }),
  };
  return {
    statements,
    due: (value: typeof rows) => {
      rows = value;
    },
    options: {
      pool: { connect: async () => client } as unknown as pg.Pool,
      provider: {} as WorkOSManagementProvider,
      email: {} as EmailConfig,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    },
  };
}
beforeEach(() => {
  for (const tick of Object.values(ticks))
    tick.mockReset().mockResolvedValue(0);
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("idle account maintenance", () => {
  it.each([false, true])(
    "skips empty commands, mail and deletion claims (deletion=%s)",
    async (deletionLifecycleEnabled) => {
      const f = fixture(),
        runtime = startWorkOSSyncRuntime({
          ...f.options,
          deletionLifecycleEnabled,
        });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(ticks.commands).not.toHaveBeenCalled();
        expect(ticks.notifications).not.toHaveBeenCalled();
        expect(ticks.deletions).not.toHaveBeenCalled();
        expect(ticks.events).toHaveBeenCalledTimes(2);
        expect(
          f.statements.filter((sql) => sql.startsWith("BEGIN")).length,
        ).toBeLessThanOrEqual(3);
      } finally {
        await runtime.stop();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("claims a newly hinted command while leaving other empty queues asleep", async () => {
    const f = fixture(),
      runtime = startWorkOSSyncRuntime(f.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      f.due([{ kind: "commands", delay_ms: 0 }]);
      ticks.commands.mockImplementationOnce(async () => {
        f.due([]);
        return 1;
      });
      runtime.notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks.commands).toHaveBeenCalledTimes(1);
      expect(ticks.notifications).not.toHaveBeenCalled();
      expect(ticks.deletions).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });
  it("does not let an in-flight provider command block newly queued security mail", async () => {
    const f = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    ticks.commands.mockImplementationOnce(async () => {
      await blocked;
      return 1;
    });
    f.due([{ kind: "commands", delay_ms: 0 }]);
    const runtime = startWorkOSSyncRuntime(f.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks.commands).toHaveBeenCalledOnce();
      f.due([
        { kind: "commands", delay_ms: 0 },
        { kind: "notifications", delay_ms: 0 },
      ]);
      ticks.notifications.mockImplementationOnce(async () => {
        f.due([{ kind: "commands", delay_ms: 0 }]);
        return 1;
      });
      runtime.notify();
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks.notifications).toHaveBeenCalledOnce();
      expect(ticks.commands).toHaveBeenCalledOnce();
    } finally {
      f.due([]);
      release();
      await runtime.stop();
    }
  });
  it("preserves the security-mail burst cadence after processing a nonempty batch", async () => {
    const f = fixture();
    f.due([{ kind: "notifications", delay_ms: 0 }]);
    ticks.notifications.mockResolvedValue(4);
    const runtime = startWorkOSSyncRuntime(f.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks.notifications).toHaveBeenCalledOnce();
      runtime.notify();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(ticks.notifications).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks.notifications).toHaveBeenCalledTimes(2);
      expect(ticks.notifications).toHaveBeenLastCalledWith(4);
    } finally {
      f.due([]);
      await runtime.stop();
    }
  });
  it("keeps deletion-schema reads behind the existing migration boundary", async () => {
    const f = fixture();
    f.due([{ kind: "commands", delay_ms: 0 }]);
    ticks.commands.mockImplementationOnce(async () => {
      f.due([]);
      return 1;
    });
    const runtime = startWorkOSSyncRuntime({
      ...f.options,
      deletionLifecycleEnabled: false,
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks.commands).toHaveBeenCalledOnce();
      expect(f.statements.join(" ")).not.toContain("deletion_requests");
      expect(f.options.logger.error).not.toHaveBeenCalled();
    } finally {
      await runtime.stop();
    }
  });
  it("waits for a future deadline and discovers a dropped hint at the bounded fallback", async () => {
    const f = fixture(),
      runtime = startWorkOSSyncRuntime(f.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      f.due([{ kind: "commands", delay_ms: 150 }]);
      runtime.notify();
      await vi.advanceTimersByTimeAsync(149);
      expect(ticks.commands).not.toHaveBeenCalled();
      f.due([{ kind: "commands", delay_ms: 0 }]);
      ticks.commands.mockImplementationOnce(async () => {
        f.due([]);
        return 1;
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks.commands).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(3_000);
      f.due([{ kind: "commands", delay_ms: 0 }]);
      ticks.commands.mockImplementationOnce(async () => {
        f.due([]);
        return 1;
      });
      await vi.advanceTimersByTimeAsync(41_849);
      expect(ticks.commands).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(ticks.commands).toHaveBeenCalledTimes(2);
    } finally {
      f.due([]);
      await runtime.stop();
    }
  });

  it("retries a failed deadline read without exposing its details or claiming blindly", async () => {
    const f = fixture();
    const connect = f.options.pool.connect.bind(f.options.pool);
    f.options.pool.connect = vi.fn().mockRejectedValueOnce(new Error("private database details"))
      .mockImplementation(connect);
    const runtime = startWorkOSSyncRuntime(f.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks.commands).not.toHaveBeenCalled();
      expect(f.options.logger.error).toHaveBeenCalledExactlyOnceWith(
        "[workos-sync] deadline read failed; fallback remains enabled",
      );
      f.due([{ kind: "commands", delay_ms: 0 }]);
      ticks.commands.mockImplementationOnce(async () => { f.due([]); return 1; });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(ticks.commands).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.options.logger.error.mock.calls)).not.toContain("private");
    } finally { await runtime.stop(); }
  });

  it("drains all independent flights and ignores late hints after shutdown", async () => {
    const f = fixture();
    const releases: Array<() => void> = [];
    for (const kind of ["commands", "notifications", "deletions"] as const) {
      ticks[kind].mockImplementationOnce(() => new Promise<number>(resolve => {
        releases.push(() => resolve(1));
      }));
    }
    f.due(["commands", "notifications", "deletions"].map(kind => ({ kind, delay_ms: 0 })));
    const runtime = startWorkOSSyncRuntime(f.options);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(releases).toHaveLength(3);
      let stopped = false;
      const stopping = runtime.stop().then(() => { stopped = true; });
      runtime.notify();
      releases[0]!();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stopped).toBe(false);
      for (const release of releases) release();
      await stopping;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ticks.commands).toHaveBeenCalledOnce();
      expect(ticks.notifications).toHaveBeenCalledOnce();
      expect(ticks.deletions).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      for (const release of releases) release();
      await runtime.stop();
    }
  });
});
