import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import type { RolloutFlagName } from "../rollout-flags.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import {
  AUTHORITY_CACHE_CHANNEL,
  EngineAuthorityCache,
  installEngineAuthorityCache,
  loadEngineAuthorityEntry,
  type EngineAuthorityKey,
} from "./engine-authority-cache.js";
import { assertCurrentCloudEngineAuthority, CloudWorkspaceEngineAuthorityError, readCurrentCloudEngineAuthority } from "./engine-authority.js";

const url = process.env.TEST_DATABASE_URL, d = url ? describe : describe.skip;

const DEADLINE_COLUMNS = new Set(["lease_expires_at", "funded_until", "provider_expires_at", "covered_until"]);
const PRESERVED_PREDICATES: Record<string, string> = {
  reserved_micro_usd: "((new_row ->> 'reserved_micro_usd')::numeric > 0) = ((old_row ->> 'reserved_micro_usd')::numeric > 0)",
};

/**
 * Each extension-only branch of notify_cloud_authority_cache lists the
 * columns an UPDATE may change without a hint. A listed column is safe only
 * as a deadline guarded (inside that same branch) to move later, as a column
 * whose predicate the branch itself preserves, or when neither the predicate
 * closure nor the loader reads it. Returns the branches and every violation.
 */
function authorityExemptions(notifier: string, code: string) {
  const branches = [...notifier.matchAll(/TG_TABLE_NAME = '([a-z_]+)'\s+AND \(new_row - ARRAY\[([^\]]*)\]\)/g)].map(match => {
    const start = match.index!;
    const end = notifier.slice(start).search(/\bTHEN\b/);
    return {
      table: match[1]!,
      columns: [...match[2]!.matchAll(/'([a-z_]+)'/g)].map(column => column[1]!),
      text: end < 0 ? "" : notifier.slice(start, start + end),
    };
  });
  const violations: string[] = [];
  for (const { table, columns, text } of branches) {
    for (const column of columns) {
      if (DEADLINE_COLUMNS.has(column)) {
        if (!text.includes(`(new_row ->> '${column}')::timestamptz >= (old_row ->> '${column}')::timestamptz`)) violations.push(`${table}.${column} may only move later`);
      } else if (PRESERVED_PREDICATES[column]) {
        if (!text.includes(PRESERVED_PREDICATES[column])) violations.push(`${table}.${column} keeps its predicate`);
      } else if (new RegExp(`\\b${column}\\b`).test(code)) {
        violations.push(`${table}.${column} is read by the authority predicate or loader`);
      }
    }
  }
  return { branches, violations };
}

describe("authority cache exemption guard", () => {
  const guarded = `IF TG_TABLE_NAME = 'a_table'
       AND (new_row - ARRAY['covered_until']) = (old_row - ARRAY['covered_until'])
       AND (new_row ->> 'covered_until')::timestamptz >= (old_row ->> 'covered_until')::timestamptz THEN
      RETURN NULL;
    END IF;`;
  it("accepts a deadline exemption guarded inside its own branch", () => {
    expect(authorityExemptions(guarded, "").violations).toEqual([]);
  });
  it("rejects a second table that exempts a deadline without its own guard", () => {
    const unguarded = guarded + `
    IF TG_TABLE_NAME = 'b_table'
       AND (new_row - ARRAY['covered_until']) = (old_row - ARRAY['covered_until']) THEN
      RETURN NULL;
    END IF;`;
    expect(authorityExemptions(unguarded, "").violations).toEqual(["b_table.covered_until may only move later"]);
  });
  it("rejects a preserved predicate that sits in another table's branch", () => {
    const notifier = `IF TG_TABLE_NAME = 'a_table'
       AND (new_row - ARRAY['reserved_micro_usd']) = (old_row - ARRAY['reserved_micro_usd']) THEN
      RETURN NULL;
    END IF;
    IF TG_TABLE_NAME = 'b_table' AND (new_row - ARRAY['x']) = (old_row - ARRAY['x'])
       AND ${PRESERVED_PREDICATES.reserved_micro_usd} THEN RETURN NULL; END IF;`;
    expect(authorityExemptions(notifier, "").violations).toEqual(["a_table.reserved_micro_usd keeps its predicate"]);
  });
});
const hash = (token: string) => createHash("sha256").update(token, "utf8").digest();

/** Tables read by the cache loader beyond the authority function closure. */
const LOADER_TABLES = [
  "cloud_workspace_engine_instances", "cloud_workspace_runtime_enrollments", "cloud_workspace_runtime_transitions",
  "managed_compute_allocation_leases", "managed_compute_credit_reservations", "cloud_workspace_generations",
  "provider_connection_versions", "account_entitlements", "organization_entitlements",
];

d("engine authority cache with PostgreSQL", () => {
  let pool: pg.Pool, listenerPool: pg.Pool;
  let scope: EngineAuthorityKey & { heartbeatToken: string };
  let fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>;
  const caches: EngineAuthorityCache[] = [];
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url, max: 4 });
    listenerPool = createPool(url!, { maxConnections: 1, keepAlive: true, applicationName: "zeros-notifications" });
  });
  afterAll(async () => { await listenerPool.end(); await pool.end(); });
  afterEach(async () => {
    installEngineAuthorityCache(undefined);
    await Promise.all(caches.splice(0).map(cache => cache.stop()));
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    const f = await seedReadyCloudWorkspace(pool);
    fixture = f;
    scope = { workspaceId: f.workspaceId, organizationId: f.organizationId, generation: 1,
      engineInstanceId: f.engineInstanceId, heartbeatToken: f.heartbeatToken, workosEnabled: false };
  });

  async function cache(flags: RolloutFlagName[] = ["authority_cache_shadow"]) {
    const value = new EngineAuthorityCache({
      pool, listenerPool, settleMs: 300, summaryMs: 0, logger: { warn: vi.fn(), info: vi.fn() },
      flags: { enabled: (_org, flag) => flags.includes(flag) },
    });
    caches.push(value);
    value.start();
    await vi.waitFor(() => expect(value.feedCurrent()).toBe(true));
    return value;
  }

  async function cached(value: EngineAuthorityCache) {
    value.ensure(scope);
    await vi.waitFor(() => expect(value.lookup(scope, hash(scope.heartbeatToken), { kind: "assert" })).toMatchObject({ allowed: true }));
  }

  async function notificationsDuring(change: () => Promise<unknown>): Promise<string[]> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const seen: string[] = [];
    client.on("notification", message => { if (message.channel === AUTHORITY_CACHE_CHANNEL) seen.push(message.payload ?? ""); });
    try {
      await client.query(`LISTEN ${AUTHORITY_CACHE_CHANNEL}`);
      await change();
      await client.query("SELECT 1");
      await new Promise(resolve => setTimeout(resolve, 100));
      return seen;
    } finally { await client.end(); }
  }

  it("puts the invalidation trigger on every table the authority predicate reads", async () => {
    // Identifier-based extraction (functionInputTables) also sees comma
    // joins, LATERAL and EXISTS inputs, not only the first FROM/JOIN item.
    const closure = await functionInputTables(pool, ["cloud_workspace_engine_authority_current", "cloud_workspace_engine_authority_snapshot"]);
    const functions = closure.functions, tables = new Set<string>([...LOADER_TABLES, ...closure.tables]);
    expect(functions).toContain("cloud_workspace_paid_authority_live");
    expect(functions).toContain("cloud_workspace_compute_authority_live");
    // Every clock comparison in the predicate either only becomes true over
    // time or is a deadline the loader bounds entries by.
    const clocked = new Set<string>();
    for (const name of functions) {
      for (const { body } of (await pool.query<{ body: string }>(`SELECT pg_get_functiondef(oid) AS body FROM pg_proc
        WHERE proname=$1 AND pronamespace='public'::regnamespace`, [name])).rows) {
        for (const match of body.matchAll(/\.([a-z_]+)\s*(?:<=|>=|<|>)\s*(?:clock_timestamp|now)\(/gi)) clocked.add(match[1]!.toLowerCase());
        for (const match of body.matchAll(/(?:clock_timestamp|now)\(\)\s*(?:<=|>=|<|>)\s*[a-z_]+\.([a-z_]+)/gi)) clocked.add(match[1]!.toLowerCase());
      }
    }
    expect([...clocked].filter(column => ![
      "valid_from", "meter_since",
      "lease_expires_at", "valid_until", "credential_expires_at", "provider_expires_at", "funded_until", "covered_until",
    ].includes(column)).sort()).toEqual([]);
    expect(clocked).toContain("lease_expires_at");
    const triggers = await pool.query<{ table: string; args: string[] }>(`SELECT relation.relname AS table,
        string_to_array(encode(trigger.tgargs,'escape'), E'\\\\000') AS args
      FROM pg_trigger trigger JOIN pg_class relation ON relation.oid=trigger.tgrelid
      WHERE trigger.tgname='zz_cloud_authority_cache' AND trigger.tgfoid='notify_cloud_authority_cache'::regproc
        AND trigger.tgenabled='O' AND (trigger.tgtype & 29) = 29`);
    const covered = new Map(triggers.rows.map(row => [row.table, row.args.filter(Boolean)]));
    expect([...tables].filter(table => !covered.has(table)).sort()).toEqual([]);
    for (const [table, args] of covered) {
      if (args[0] === "*") continue;
      expect(["w", "o", "u"]).toContain(args[0]);
      const column = await pool.query(`SELECT 1 FROM pg_attribute WHERE attrelid=$1::regclass AND attname=$2 AND atttypid='uuid'::regtype`,
        [table, args[1]]);
      expect(column.rowCount, `${table}.${args[1]}`).toBe(1);
    }
  });

  it("exempts from invalidation only columns that cannot lower a cached authority", async () => {
    const closure = await functionInputTables(pool, ["cloud_workspace_engine_authority_current", "cloud_workspace_engine_authority_snapshot"]);
    const code = [...closure.bodies.values()].flat().map(stripSqlLiterals).join("\n") + "\n" +
      readFileSync(new URL("./engine-authority-cache.ts", import.meta.url), "utf8");
    const notifier = (await pool.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname='notify_cloud_authority_cache'")).rows[0]!.body;
    const { branches, violations } = authorityExemptions(notifier, code);
    expect(branches.map(branch => branch.table).sort()).toEqual([
      "cloud_workspace_engine_instances", "cloud_workspace_generations", "cloud_workspace_provider_bindings",
      "managed_compute_allocation_leases", "managed_compute_credit_reservations"]);
    expect(branches.every(branch => branch.text.length > 0)).toBe(true);
    expect(violations).toEqual([]);
  });

  it("loads with the locking predicate's exact body minus its row locks", async () => {
    const body = async (name: string) => (await pool.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace", [name])).rows[0]!.body;
    // Drop the two lock statements and turn each `EXECUTE format(... FOR %s,
    // strength) INTO x USING args` into the same static SELECT ... INTO x
    // with its $n placeholders bound to those arguments.
    const unlocked = (await body("cloud_workspace_engine_authority_current"))
      .replace("  -- Only the lock strength varies between readers and mutators.\n  strength text := CASE WHEN exclusive THEN 'UPDATE' ELSE 'SHARE' END;\n", "")
      .replace("  PERFORM 1 FROM organizations organization WHERE organization.id = target_org_id FOR SHARE;\n", "")
      .replace(/EXECUTE format\(\$query\$\n {4}([\s\S]*?)\n {4}FOR %s\$query\$, strength\)\n {2}INTO (\w+) USING ([^;]+);/g,
        (_match, query: string, into: string, args: string) => {
          const values = args.split(",").map(value => value.trim());
          return `${query.replace(/\$(\d+)/g, (_n, index: string) => values[Number(index) - 1]!)}\n  INTO ${into};`;
        });
    expect(unlocked).not.toMatch(/strength|FOR SHARE|%s|EXECUTE/);
    expect(await body("cloud_workspace_engine_authority_snapshot")).toBe(unlocked);
  });

  it("loads without waiting for a heartbeat that holds the engine row", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("UPDATE cloud_workspace_engine_instances SET last_heartbeat_at=clock_timestamp() WHERE id=$1", [scope.engineInstanceId]);
      const outcome = await Promise.race([
        loadEngineAuthorityEntry(pool, scope, 30_000).then(entry => entry ? "loaded" : "denied"),
        new Promise(resolve => setTimeout(() => resolve("blocked"), 1_000)),
      ]);
      expect(outcome).toBe("loaded");
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  });

  it("loads the committed authority with the engine lease as its deadline bound", async () => {
    await pool.query("UPDATE cloud_workspace_engine_instances SET lease_expires_at=clock_timestamp()+interval '5 seconds' WHERE id=$1", [scope.engineInstanceId]);
    const entry = await loadEngineAuthorityEntry(pool, scope, 30_000);
    const sql = await withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, scope));
    expect(entry).toMatchObject({ authorityEpoch: sql.authorityEpoch, accountUserId: sql.accountUserId, revoked: false });
    expect(entry!.deadlineMs).toBeLessThanOrEqual(entry!.leaseExpiresAtMs);
    expect(entry!.leaseExpiresAtMs - Date.now()).toBeLessThanOrEqual(5_500);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [scope.engineInstanceId]);
    expect(await loadEngineAuthorityEntry(pool, scope, 30_000)).toBeNull();
  });

  it("drops a cached entry when a revocation commits", async () => {
    const value = await cache();
    await cached(value);
    await pool.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [scope.engineInstanceId]);
    await vi.waitFor(() => expect(value.lookup(scope, hash(scope.heartbeatToken), { kind: "assert" })).toBeUndefined());
  });

  it.each([
    ["an authority epoch bump", "UPDATE cloud_workspaces SET authority_epoch=authority_epoch+1 WHERE id=$1::uuid", "w"],
    ["an organization change", "UPDATE organizations SET name=name||' renamed' WHERE id=$1::uuid", "o"],
    ["an account change", "UPDATE users SET auth_revision=auth_revision+1 WHERE id=$1::uuid", "u"],
    ["a provider requirement change", "UPDATE managed_compute_provider_requirements SET require_credit=NOT require_credit", "*"],
  ] as const)("invalidates on %s", async (_label, statement, kind) => {
    const value = await cache();
    await cached(value);
    const user = value.lookup(scope, hash(scope.heartbeatToken), { kind: "assert" });
    const accountUserId = user?.allowed ? user.accountUserId : "";
    const subject = { w: scope.workspaceId, o: scope.organizationId, u: accountUserId, "*": "" }[kind];
    const seen = await notificationsDuring(() => pool.query(statement, kind === "*" ? [] : [subject]));
    expect(seen).toContain(kind === "*" ? "*" : `${kind}:${subject}`);
    await vi.waitFor(() => expect(value.lookup(scope, hash(scope.heartbeatToken), { kind: "assert" })).toBeUndefined());
  });

  it("ignores heartbeat lease extensions but not a shortened lease", async () => {
    const value = await cache();
    await cached(value);
    const extended = await notificationsDuring(() => pool.query(`UPDATE cloud_workspace_engine_instances
      SET last_heartbeat_at=clock_timestamp(),lease_expires_at=lease_expires_at+interval '30 seconds',updated_at=now() WHERE id=$1`, [scope.engineInstanceId]));
    expect(extended).toEqual([]);
    expect(value.lookup(scope, hash(scope.heartbeatToken), { kind: "assert" })).toMatchObject({ allowed: true });
    const shortened = await notificationsDuring(() => pool.query(`UPDATE cloud_workspace_engine_instances
      SET lease_expires_at=clock_timestamp()+interval '1 second' WHERE id=$1`, [scope.engineInstanceId]));
    expect(shortened).toEqual([`w:${scope.workspaceId}`]);
    await vi.waitFor(() => expect(value.lookup(scope, hash(scope.heartbeatToken), { kind: "assert" })).toBeUndefined());
  });

  it("ignores extension-only and bookkeeping updates but not shortenings or state changes", async () => {
    const value = await cache();
    await cached(value);
    // An active compute lease with both deadlines funded.
    const intentId = randomUUID();
    await pool.query(`INSERT INTO cloud_workspace_lifecycle_intents(id,workspace_id,org_id,generation,requested_by,operation,idempotency_key,request_sha256,state,completed_at)
      VALUES($1,$2,$3,1,$4,'create',$5,$6,'succeeded',now())`,
      [intentId, scope.workspaceId, scope.organizationId, fixture.userId, randomUUID(), randomBytes(32)]);
    const leaseId = randomUUID();
    await pool.query(`INSERT INTO managed_compute_allocation_leases(id,workspace_id,org_id,generation,billing_epoch,user_id,lifecycle_intent_id,
      provider,provider_resource_id,policy_id,seconds_per_dollar,weight_numerator,weight_denominator,ttl_seconds,funded_until,provider_expires_at,state)
      VALUES($1,$2,$3,1,1,$4,$5,'boat','res-1','policy',3600,1,1,60,clock_timestamp()+interval '1 hour',clock_timestamp()+interval '50 minutes','active')`,
      [leaseId, scope.workspaceId, scope.organizationId, fixture.userId, intentId]);
    // An open credit reservation with its account, period and scope rows.
    await pool.query("INSERT INTO managed_compute_credit_accounts(org_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [scope.organizationId, fixture.userId]);
    const periodId = randomUUID(), reservationId = randomUUID();
    await pool.query(`INSERT INTO managed_compute_credit_periods(id,org_id,user_id,starts_at,ends_at,funding_mode)
      VALUES($1,$2,$3,now()-interval '1 day',now()+interval '30 days','business')`, [periodId, scope.organizationId, fixture.userId]);
    await pool.query(`INSERT INTO managed_compute_reservation_scopes(id,org_id,user_id,workspace_id,generation,billing_epoch,policy_id,seconds_per_dollar)
      VALUES($1,$2,$3,$4,1,1,'policy',3600)`, [reservationId, scope.organizationId, fixture.userId, scope.workspaceId]);
    await pool.query(`INSERT INTO managed_compute_credit_reservations(id,period_id,org_id,user_id,workspace_id,generation,billing_epoch,policy_id,seconds_per_dollar,
      meter_since,meter_through,covered_until,authorized_micro_usd,reserved_micro_usd)
      VALUES($1,$2,$3,$4,$5,1,1,'policy',3600,now()-interval '1 hour',now(),now()+interval '2 hours',1000000,500000)`,
      [reservationId, periodId, scope.organizationId, fixture.userId, scope.workspaceId]);

    // A cached entry is bounded by the deadlines it loaded, so deadline
    // extensions, credit metering and drift bookkeeping cannot keep a stopped
    // workspace live: none of these commits notify.
    expect(await notificationsDuring(() => pool.query(`UPDATE managed_compute_allocation_leases
      SET funded_until=funded_until+interval '10 minutes',provider_expires_at=provider_expires_at+interval '10 minutes',updated_at=now() WHERE id=$1`, [leaseId]))).toEqual([]);
    expect(await notificationsDuring(() => pool.query(`UPDATE managed_compute_credit_reservations
      SET authorized_micro_usd=authorized_micro_usd+1000,reserved_micro_usd=reserved_micro_usd+1000,covered_until=covered_until+interval '1 hour',updated_at=now() WHERE id=$1`, [reservationId]))).toEqual([]);
    expect(await notificationsDuring(() => pool.query(`UPDATE managed_compute_credit_reservations
      SET actual_micro_usd=10,billable_seconds=60,meter_through=now(),debited_micro_usd=10,updated_at=now() WHERE id=$1`, [reservationId]))).toEqual([]);
    expect(await notificationsDuring(() => pool.query(`UPDATE cloud_workspace_provider_bindings
      SET next_drift_check_at=now()+interval '1 hour',last_observed_at=now(),observed_state='running',updated_at=now() WHERE workspace_id=$1`, [scope.workspaceId]))).toEqual([]);
    // A heartbeat that carries a port scan stamps ports_observed_at.
    expect(await notificationsDuring(() => pool.query(
      "UPDATE cloud_workspace_generations SET ports_observed_at=now() WHERE workspace_id=$1", [scope.workspaceId]))).toEqual([]);

    // A shortened deadline, a state change or an authority-relevant column
    // change still invalidates.
    expect(await notificationsDuring(() => pool.query(
      `UPDATE managed_compute_allocation_leases SET funded_until=funded_until-interval '10 minutes',
       provider_expires_at=provider_expires_at-interval '10 minutes' WHERE id=$1`, [leaseId]))).toEqual([`w:${scope.workspaceId}`]);
    expect(await notificationsDuring(() => pool.query(
      "UPDATE managed_compute_credit_reservations SET covered_until=covered_until-interval '30 minutes' WHERE id=$1", [reservationId]))).toEqual([`w:${scope.workspaceId}`]);
    // The predicate requires reserved_micro_usd > 0: exhausting the
    // reservation ends compute authority with no deadline involved.
    expect(await notificationsDuring(() => pool.query(
      "UPDATE managed_compute_credit_reservations SET reserved_micro_usd=0,updated_at=now() WHERE id=$1", [reservationId]))).toEqual([`w:${scope.workspaceId}`]);
    expect(await notificationsDuring(() => pool.query(
      "UPDATE managed_compute_credit_reservations SET reserved_micro_usd=1000,updated_at=now() WHERE id=$1", [reservationId]))).toEqual([`w:${scope.workspaceId}`]);
    expect(await notificationsDuring(() => pool.query(
      "UPDATE managed_compute_credit_reservations SET state='final',final_reason='period_ended',reserved_micro_usd=0 WHERE id=$1", [reservationId]))).toEqual([`w:${scope.workspaceId}`]);
    expect(await notificationsDuring(() => pool.query(
      "UPDATE cloud_workspace_provider_bindings SET provider_resource_id='moved' WHERE workspace_id=$1", [scope.workspaceId]))).toEqual([`w:${scope.workspaceId}`]);
  });

  it("agrees with SQL on fixture traffic in shadow mode", async () => {
    const value = await cache();
    installEngineAuthorityCache(value);
    await withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, scope));
    await vi.waitFor(() => expect(value.stats().entries).toBe(1));
    for (let i = 0; i < 5; i++) await withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, scope));
    await withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, { ...scope, lock: "share" }));
    await withSystemTx(pool, tx => readCurrentCloudEngineAuthority(tx, scope), { consistentRead: true });
    await expect(withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, { ...scope, heartbeatToken: `zwh_${"Z".repeat(43)}` })))
      .rejects.toBeInstanceOf(CloudWorkspaceEngineAuthorityError);
    expect(value.stats()).toMatchObject({ agree: 8, mismatchCacheAllows: 0, mismatchCacheDenies: 0 });
  });

  it("counts a revocation that bypassed the triggers as a shadow mismatch", async () => {
    const value = await cache();
    installEngineAuthorityCache(value);
    await cached(value);
    const client = await pool.connect();
    try {
      await client.query("SET session_replication_role = replica");
      await client.query("UPDATE cloud_workspace_engine_instances SET state='revoked',revoked_at=now() WHERE id=$1", [scope.engineInstanceId]);
      await client.query("RESET session_replication_role");
    } finally { client.release(); }
    await expect(withSystemTx(pool, tx => assertCurrentCloudEngineAuthority(tx, scope))).rejects.toBeInstanceOf(CloudWorkspaceEngineAuthorityError);
    await vi.waitFor(() => expect(value.stats().mismatchCacheAllows).toBe(1));
    expect(value.lookup(scope, hash(scope.heartbeatToken), { kind: "assert" })).toBeUndefined();
  });

  it("serves enforced reads from memory and returns to SQL after a revocation", async () => {
    const value = await cache(["authority_cache_enforce"]);
    installEngineAuthorityCache(value);
    await cached(value);
    await withSystemTx(pool, tx => readCurrentCloudEngineAuthority(tx, scope), { consistentRead: true });
    expect(value.stats().enforcedHits).toBe(1);
    await pool.query("UPDATE cloud_workspace_engine_instances SET final_checkpoint_at=clock_timestamp() WHERE id=$1", [scope.engineInstanceId]);
    await vi.waitFor(() => expect(value.lookup(scope, hash(scope.heartbeatToken), { kind: "read" })).toBeUndefined());
    await expect(withSystemTx(pool, tx => readCurrentCloudEngineAuthority(tx, scope), { consistentRead: true }))
      .rejects.toBeInstanceOf(CloudWorkspaceEngineAuthorityError);
    expect(value.stats().enforcedHits).toBe(1);
  });
});

/** Test support: the tables a set of SQL functions can read, derived from
 * the live definitions instead of a hand-kept list. Every identifier in a
 * body (after string literals and comments are removed) that names a public
 * table counts, so comma-joined FROM items, LATERAL subqueries and EXISTS
 * probes are found as reliably as JOINs; an alias that happens to share a
 * table's name over-approximates, which only ever asks for more coverage.
 * Public functions called from a body are walked too, except the RLS
 * context helpers (`app_*`). */
export async function functionInputTables(pool: pg.Pool, roots: readonly string[]): Promise<{
  tables: Set<string>;
  functions: Set<string>;
  bodies: Map<string, string[]>;
}> {
  const publicFunctions = new Set((await pool.query<{ name: string }>(
    "SELECT DISTINCT proname AS name FROM pg_proc WHERE pronamespace='public'::regnamespace")).rows.map(row => row.name));
  const publicTables = new Set((await pool.query<{ name: string }>(
    "SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")).rows.map(row => row.name));
  const tables = new Set<string>(), functions = new Set<string>(), bodies = new Map<string, string[]>();
  const queue = [...roots];
  while (queue.length) {
    const name = queue.pop()!;
    if (functions.has(name)) continue;
    functions.add(name);
    const definitions = (await pool.query<{ body: string }>(
      "SELECT prosrc AS body FROM pg_proc WHERE proname=$1 AND pronamespace='public'::regnamespace", [name])).rows;
    if (!definitions.length) throw new Error(`function ${name} is not defined`);
    bodies.set(name, definitions.map(row => row.body));
    for (const { body } of definitions) {
      const code = stripSqlLiterals(body);
      for (const match of code.matchAll(/(?<![\w$.])(?:public\.)?([a-z_][a-z0-9_$]*)(?![\w$])(\s*\()?/gi)) {
        const word = match[1]!.toLowerCase();
        if (publicTables.has(word)) tables.add(word);
        if (match[2] && publicFunctions.has(word) && word !== name && !word.startsWith("app_")) queue.push(word);
      }
    }
  }
  return { tables, functions, bodies };
}

/** Removes comments, quoted strings and quoted identifiers' quotes so only
 * SQL code remains; quoted identifiers keep their text. */
export function stripSqlLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"((?:[^"]|"")*)"/g, (_all, inner: string) => inner.replace(/""/g, "\""));
}
