// Runtime archive cleanup for a release-managed store (Alpha, Production). It runs in the release controller once a
// release has saved its receipt, so the pins it keeps are the ones that release confirmed. Each runtime may have two
// archive keys: the served copy VMs install and the older retained copy under releases/archives/. Both go together.
// JSON (manifests, qualifications, receipts, intents, capabilities, source indices) is never deleted.
import { DIGEST } from "./contracts";

export const RUNTIME_ARCHIVE_RETENTION = { windowDays: 7, newest: 3 } as const;
const DAY_MS = 86_400_000;
/** R2 Standard storage, USD per GB-month, for the plan's estimate only. */
const USD_PER_GB_MONTH = 0.015;
const SERVED = /^cloud-v2\/runtime\/([a-f0-9]{64})\.tar\.gz$/;
const RETAINED = /^cloud-v2\/runtime\/releases\/archives\/([a-f0-9]{64})\.tar\.gz$/;
const MAX_OBJECTS = 100_000;

export type RuntimeStoredObject = { key: string; lastModified: Date; size: number };
export type RuntimeRetentionMode = "dry-run" | "apply";
export type RuntimeRetentionReason = "current" | "previous" | "referenced" | "recent" | "newest";
export type RuntimeRetentionStatus = "planned" | "deleted" | "refused" | "failed";
export type RuntimeRetentionPlan = {
  version: 1; channel: "alpha" | "production"; mode: RuntimeRetentionMode; status: RuntimeRetentionStatus; reason: string | null; at: string;
  rule: { windowDays: number; newest: number }; pins: { current: string; previous: string }; references: string[] | null;
  kept: Array<{ sha256: string; reasons: RuntimeRetentionReason[]; keys: string[]; bytes: number; lastModified: string }>;
  remove: Array<{ sha256: string; keys: string[]; bytes: number; lastModified: string }>;
  totals: { keptBytes: number; removeBytes: number; removeObjects: number; removeUsdPerMonth: number };
};
export type RuntimeArchiveStore = {
  listRuntimeObjects(): Promise<RuntimeStoredObject[]>;
  deleteRuntimeArchives(keys: readonly string[]): Promise<void>;
};

/** Only exactly "apply" deletes; anything else, including unset, plans and reports. */
export function runtimeRetentionMode(env: NodeJS.ProcessEnv): RuntimeRetentionMode {
  return env.ZEROS_RUNTIME_RETENTION === "apply" ? "apply" : "dry-run";
}

export const runtimeArchiveDigest = (key: string) => key.match(SERVED)?.[1] ?? key.match(RETAINED)?.[1];

/** Keeps the current and previous pins, every live database reference, anything written in the last `windowDays`
 * and the `newest` runtimes; plans the rest for removal. Pure: the caller supplies the listing and references. */
export function planRuntimeArchiveRetention(objects: readonly RuntimeStoredObject[], input: {
  channel: "alpha" | "production"; mode: RuntimeRetentionMode; current: string; previous: string; references: readonly string[]; now: number;
}): RuntimeRetentionPlan {
  if (![input.current, input.previous, ...input.references].every(sha => DIGEST.test(sha))) throw new Error("Runtime retention input is invalid");
  const runtimes = new Map<string, { keys: string[]; bytes: number; lastModified: number }>();
  for (const object of objects) {
    const sha256 = runtimeArchiveDigest(object.key);
    if (!sha256) continue;
    const entry = runtimes.get(sha256) ?? { keys: [], bytes: 0, lastModified: 0 };
    entry.keys.push(object.key); entry.bytes += object.size;
    // The latest write counts: a rollback or retention that re-copies a runtime makes it recent again.
    entry.lastModified = Math.max(entry.lastModified, object.lastModified.getTime());
    runtimes.set(sha256, entry);
  }
  const newest = new Set([...runtimes].sort(([a, x], [b, y]) => y.lastModified - x.lastModified || a.localeCompare(b))
    .slice(0, RUNTIME_ARCHIVE_RETENTION.newest).map(([sha256]) => sha256));
  const references = new Set(input.references), cutoff = input.now - RUNTIME_ARCHIVE_RETENTION.windowDays * DAY_MS;
  const plan: RuntimeRetentionPlan = { version: 1, channel: input.channel, mode: input.mode, status: "planned", reason: null,
    at: new Date(input.now).toISOString(), rule: { ...RUNTIME_ARCHIVE_RETENTION }, pins: { current: input.current, previous: input.previous },
    references: [...references].sort(), kept: [], remove: [], totals: { keptBytes: 0, removeBytes: 0, removeObjects: 0, removeUsdPerMonth: 0 } };
  for (const [sha256, entry] of [...runtimes].sort(([a], [b]) => a.localeCompare(b))) {
    const reasons: RuntimeRetentionReason[] = [];
    if (sha256 === input.current) reasons.push("current");
    if (sha256 === input.previous) reasons.push("previous");
    if (references.has(sha256)) reasons.push("referenced");
    if (entry.lastModified >= cutoff) reasons.push("recent");
    if (newest.has(sha256)) reasons.push("newest");
    const item = { sha256, keys: entry.keys.sort(), bytes: entry.bytes, lastModified: new Date(entry.lastModified).toISOString() };
    if (reasons.length) { plan.kept.push({ ...item, reasons }); plan.totals.keptBytes += entry.bytes; }
    else { plan.remove.push(item); plan.totals.removeBytes += entry.bytes; plan.totals.removeObjects += entry.keys.length; }
  }
  plan.totals.removeUsdPerMonth = Math.round(plan.totals.removeBytes / 1e9 * USD_PER_GB_MONTH * 100) / 100;
  return plan;
}

/** Lists the store, plans, and in apply mode deletes. Never throws: the release has already succeeded, so a failure
 * here is reported in the plan and the workflow log, and deletes nothing it has not planned. */
export async function retainRuntimeArchives(input: {
  channel: "alpha" | "production"; mode: RuntimeRetentionMode; current: string; previous: string;
  references: readonly string[] | null; store: RuntimeArchiveStore; active(): boolean; now?: number;
}): Promise<RuntimeRetentionPlan> {
  const now = input.now ?? Date.now();
  const refused = (reason: string, status: RuntimeRetentionStatus = "refused"): RuntimeRetentionPlan => ({
    version: 1, channel: input.channel, mode: input.mode, status, reason, at: new Date(now).toISOString(), rule: { ...RUNTIME_ARCHIVE_RETENTION },
    pins: { current: input.current, previous: input.previous }, references: input.references ? [...input.references].sort() : null,
    kept: [], remove: [], totals: { keptBytes: 0, removeBytes: 0, removeObjects: 0, removeUsdPerMonth: 0 } });
  // Without every live reference, nothing can be shown unreferenced.
  if (!input.references) return refused("references_unavailable");
  let objects: RuntimeStoredObject[];
  try { objects = await input.store.listRuntimeObjects(); } catch { return refused("listing_failed"); }
  if (objects.length > MAX_OBJECTS) return refused("listing_too_large");
  let plan: RuntimeRetentionPlan;
  try { plan = planRuntimeArchiveRetention(objects, { ...input, references: input.references, now }); } catch { return refused("invalid_input"); }
  // The pin this release just confirmed must be in the listing; otherwise this is not the store the channel serves.
  if (!plan.kept.some(item => item.reasons.includes("current") && item.keys.some(key => SERVED.test(key))))
    return { ...plan, status: "refused", reason: "current_archive_not_listed" };
  if (input.mode !== "apply" || !plan.remove.length) return plan;
  if (!input.active()) return { ...plan, status: "refused", reason: "cancelled" };
  try { await input.store.deleteRuntimeArchives(plan.remove.flatMap(item => item.keys)); }
  catch { return { ...plan, status: "failed", reason: "delete_failed" }; }
  return { ...plan, status: "deleted" };
}

type ReferenceClient = { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>; release(): void };
// Every database row that can make a VM download a runtime other than the channel pin. Snapshots, shared bases and
// ready copies that are already built carry their runtime on disk and need no archive; ones still building do.
// Conditions are deliberately wide (any non-deleted workspace), so a new state keeps its runtime.
const REFERENCES = `SELECT DISTINCT sha FROM (
  SELECT p.runtime_sha256 AS sha FROM cloud_v2_runtime_canaries p LEFT JOIN cloud_v2_workspaces w ON w.id=p.workspace_id
    WHERE w.id IS NULL OR w.state <> 'deleted'
  UNION ALL SELECT c.runtime_sha256 FROM cloud_v2_execution_creations c JOIN cloud_v2_workspaces w ON w.id=c.workspace_id WHERE w.state <> 'deleted'
  UNION ALL SELECT a.runtime_sha256 FROM cloud_v2_execution_activations a JOIN cloud_v2_workspaces w ON w.id=a.workspace_id WHERE w.state <> 'deleted'
  UNION ALL SELECT r.source_runtime_sha256 FROM cloud_v2_recovery_attempts r JOIN cloud_v2_workspaces w ON w.id=r.workspace_id WHERE w.state <> 'deleted'
  UNION ALL SELECT r.replacement_runtime_sha256 FROM cloud_v2_recovery_attempts r JOIN cloud_v2_workspaces w ON w.id=r.workspace_id WHERE w.state <> 'deleted'
  UNION ALL SELECT w.worker_runtime_sha256 FROM cloud_v2_workspaces w WHERE w.state <> 'deleted'
  UNION ALL SELECT h.previous_sha256 FROM cloud_worker_runtime_handoffs h WHERE h.state IN ('prepared','committed','activating','rolling_back')
  UNION ALL SELECT h.target_sha256 FROM cloud_worker_runtime_handoffs h WHERE h.state IN ('prepared','committed','activating','rolling_back')
  UNION ALL SELECT b.runtime_sha256 FROM cloud_v2_computer_builds b WHERE b.state NOT IN ('succeeded','failed','cancelled')
  UNION ALL SELECT s.runtime_sha256 FROM cloud_v2_shared_bases s WHERE s.state = 'building'
  UNION ALL SELECT d.prior_runtime_sha256 FROM cloud_runtime_build_drain d
) refs WHERE sha IS NOT NULL ORDER BY sha`;

/** The runtimes live rows still name, read in one read-only transaction with row security opened for the system. */
export async function readRuntimeReferences(pool: { connect(): Promise<ReferenceClient> }): Promise<string[]> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN READ ONLY; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'; SELECT set_config('app.system','on',true)");
    try {
      const opened = (await tx.query("SELECT current_setting('app.system', true) AS system")).rows[0] as { system?: unknown } | undefined;
      if (opened?.system !== "on") throw new Error("Runtime references require the system read policy");
      const rows = (await tx.query(REFERENCES)).rows as Array<{ sha?: unknown }>;
      const references = rows.map(row => row.sha);
      if (!references.every((sha): sha is string => typeof sha === "string" && DIGEST.test(sha))) throw new Error("Runtime reference is invalid");
      await tx.query("COMMIT");
      return references;
    } catch (error) { await tx.query("ROLLBACK").catch(() => {}); throw error; }
  } finally { tx.release(); }
}
