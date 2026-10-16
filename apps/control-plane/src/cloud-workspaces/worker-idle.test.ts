import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSecurityEventPublisher } from "../security-events.js";
import { CloudWorkspaceAccessRevocationWorker } from "./access.js";
import { CloudWorkspaceForkWorker } from "./forks.js";
import { CloudWorkspaceInvitationDeliveryWorker } from "./invitation-delivery.js";
import { CloudWorkspaceOutboxWorker } from "./outbox.js";
import { CloudWorkspaceSetupWorker } from "./setup-worker.js";
import type { DatabaseCloudWorkspaceBlobService } from "./object-store.js";
import type { CloudWorkspaceProvider } from "./provider.js";
import { CloudWorkspaceOperationsWorker } from "./operations.js";
import { CloudComputerRetirementWorker } from "./computer-retirement.js";
import { CloudWorkspaceReconciler } from "./reconciler.js";
import { ComputerTemplateWorker, type ComputerTemplateWorkerDependencies } from "./computer-template-worker.js";

function database() {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    return { rows: sql.includes("delay_ms") ? [{ delay_ms: null }] : [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: async () => client, query } as unknown as pg.Pool, statements };
}
const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
// Idle tests fail on any claim/provider action; only the empty inventory sweep
// is expected to run, at its maintenance cadence.
const provider = { name: "boat", revokeSshAccess: vi.fn(), listManaged: async function* () {} } as unknown as CloudWorkspaceProvider;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.spyOn(Math, "random").mockReturnValue(0.5); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("idle worker demand", () => {
  const workers: Record<string, (pool: pg.Pool) => () => Promise<void>> = {
    outbox: pool => new CloudWorkspaceOutboxWorker(pool, { deliver: vi.fn() }, { logger }).start(),
    access: pool => new CloudWorkspaceAccessRevocationWorker({ pool, provider, leaseMs: 30_000, logger }).start(),
    invitations: pool => new CloudWorkspaceInvitationDeliveryWorker(pool,
      { keys: {}, currentKeyVersion: 1, webOrigin: "https://example.test" }, vi.fn(), logger).start(),
    forks: pool => new CloudWorkspaceForkWorker(pool, {} as DatabaseCloudWorkspaceBlobService, { logger }).start(),
    security: pool => startSecurityEventPublisher(pool, logger),
    setup: pool => new CloudWorkspaceSetupWorker({ pool, executor: { execute: vi.fn() }, sanitizeLog: value => value, logger }).start(),
    operations: pool => new CloudWorkspaceOperationsWorker(pool, { deleteUnreferencedSystem: vi.fn() }, { logger }).start(),
    retirement: pool => new CloudComputerRetirementWorker(pool).start(),
    lifecycle: pool => new CloudWorkspaceReconciler({ pool, provider, intervalMs: 60_000, logger }).start(),
    templates: pool => new ComputerTemplateWorker({ pool, accountScope: "fixture", billingOrg: "fixture",
      service: { claimNextBuild: async () => null } } as unknown as ComputerTemplateWorkerDependencies).start(),
  };
  it.each(Object.keys(workers))("%s does not poll every second or write when idle", async name => {
    const { pool, statements } = database();
    const stop = workers[name]!(pool);
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      const begins = statements.filter(sql => /^BEGIN\b/.test(sql));
      expect(begins.length).toBeLessThanOrEqual(3);
      expect(statements.filter(sql => /\b(?:DELETE|INSERT|pg_advisory_xact_lock)\b|(?<!FOR )\bUPDATE\b/.test(sql))).toEqual([]);
    } finally { await stop(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue access expiry UPDATEs on a direct empty claim", async () => {
    const { pool, statements } = database();
    const worker = new CloudWorkspaceAccessRevocationWorker({ pool, provider, leaseMs: 30_000, logger });
    expect(await worker.runOnce()).toBe(false);
    expect(statements.filter(sql => /(?<!FOR )\bUPDATE\b/.test(sql))).toEqual([]);
  });
});
