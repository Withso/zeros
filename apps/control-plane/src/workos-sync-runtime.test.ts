import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  return {
    pool: {} as pg.Pool,
    provider: {} as WorkOSManagementProvider,
    email: {} as EmailConfig,
    commandIntervalMs: 60_000,
    eventIntervalMs: 60_000,
    notificationIntervalMs: 60_000,
    deletionIntervalMs: 60_000,
    ...overrides,
  } as WorkOSSyncRuntimeOptions;
}

describe("WorkOS sync runtime migration boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the deletion lifecycle stopped while its controlled migration is pending", async () => {
    const runtime = startWorkOSSyncRuntime(
      options({ deletionLifecycleEnabled: false }),
    );

    await runtime.stop();

    expect(ticks.commands).toHaveBeenCalledTimes(1);
    expect(ticks.events).toHaveBeenCalledTimes(1);
    expect(ticks.notifications).toHaveBeenCalledTimes(1);
    expect(ticks.deletions).not.toHaveBeenCalled();
  });
});
