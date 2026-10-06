import { quarantineRestoredConnections } from "./quarantine.js";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { syntheticCodexCache } from "../cloud-workspaces/codex-auth-test-fixture.js";
import { checkDevConnectionsSchema, migrateDevConnections } from "./migrate.js";
import { DevConnectionStore } from "./store.js";
import { DevConnectionBroker } from "./broker.js";
import type { Context, GenerationRegistration } from "./types.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("persistent Dev connection authority (real PostgreSQL)", () => {
  let pool: pg.Pool, admin: pg.Pool, store: DevConnectionStore;
  const databaseName = `dev_connections_${randomUUID().replaceAll("-", "")}`;
  const keys = {
    currentKeyVersion: 1,
    keys: { 1: randomBytes(32).toString("base64url") },
    refreshFingerprints: {
      currentKeyVersion: 1,
      keys: { 1: randomBytes(32).toString("base64url") },
    },
  };
  let a: Context, b: Context;
  const principal = () => ({
    issuer: "https://identity.example.test",
    subject: "user_member",
    organization: "org_dev",
    sessionId: "session_member",
    expiresAt: Date.now() + 3600000,
  });
  const registration = (): GenerationRegistration => ({
    id: randomUUID(),
    owner: randomBytes(12).toString("hex"),
    organization: "org_dev",
    audience: "zeros-dev-connections-v1",
    credential: randomBytes(32).toString("base64url"),
    keyRevision: 1,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    source: "hosted-dev",
  });
  beforeAll(async () => {
    admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 1,
    });
    // Global setup migrates the product database; the broker requires its own.
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const connectionString = new URL(process.env.TEST_DATABASE_URL!);
    connectionString.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: connectionString.href, max: 8 });
    await migrateDevConnections(pool);
  });
  afterAll(async () => {
    try {
      await pool?.end();
    } finally {
      try {
        await admin?.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      } finally {
        await admin?.end();
      }
    }
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE dev_connections.members, dev_connections.generations, dev_connections.fingerprint_keys CASCADE",
    );
    store = new DevConnectionStore(pool, keys);
    const ga = registration(),
      gb = registration();
    await store.registerGeneration(ga);
    await store.registerGeneration(gb);
    a = {
      member: principal(),
      generation: {
        id: ga.id,
        credential: ga.credential,
        audience: ga.audience,
      },
    };
    b = {
      member: principal(),
      generation: {
        id: gb.id,
        credential: gb.credential,
        audience: gb.audience,
      },
    };
  });
  async function connect(kind: "codex" | "github" = "codex") {
    const material =
      kind === "codex"
        ? {
            kind: "codex-chatgpt",
            nativeCache: syntheticCodexCache({
              expiresAt: Math.floor(Date.now() / 1000) + 30,
            }),
          }
        : {
            kind: "github-app",
            accessToken: "synthetic-access-token",
            refreshToken: "synthetic-refresh-token",
            expiresAt: Math.floor(Date.now() / 1000) + 30,
            refreshExpiresAt: Math.floor(Date.now() / 1000) + 86400,
            accountId: "1234",
            appId: "42",
            clientId: "client_dev",
          };
    const connection = await store.connect(a, {
      id: randomUUID(),
      accountId: kind === "codex" ? "synthetic-account" : "1234",
      appScope: kind === "codex" ? "chatgpt" : "42:client_dev",
      material,
      consent: {
        models: ["test-model"],
        repositories: ["example/repo"],
        scopes: ["agent", "github:read"],
      },
    });
    const ar = (await store.restore(a)).find(
      (x) => x.connectionId === connection.connectionId,
    )!;
    const br = (await store.restore(b)).find(
      (x) => x.connectionId === connection.connectionId,
    )!;
    return { ar, br };
  }
  const scope = {
    workspaceId: randomUUID(),
    model: "test-model",
    action: "agent" as const,
  };
  const rotated = () =>
    syntheticCodexCache({ refresh: `synthetic-rotated-${randomUUID()}` });
  const broker = (renew: any) =>
    new DevConnectionBroker(store, {
      codex: renew,
      github: async () => {
        throw new Error("unused");
      },
      githubAccess: async () => {},
    });
  it("never advances a revocation cursor past another member's uncommitted event", async () => {
    const { ar } = await connect("github");
    const other = { ...a, member: { ...a.member, subject: "user_other" } }, id = randomUUID();
    await store.connect(other, { id, accountId: id, appScope: "api", material: { kind: "cursor-api-key", apiKey: "synthetic-other-cursor-api-key" },
      consent: { models: [], repositories: [], scopes: ["agent"] } });
    const ref = (await store.restore(other))[0]!;
    let entered!: () => void, release!: () => void;
    const paused = new Promise<void>(r => { entered = r; }), resume = new Promise<void>(r => { release = r; });
    const delayedPool = { connect: async () => {
      const client = await pool.connect(), query = client.query, done = client.release;
      client.query = (async (...args: any[]) => { if (args[0] === "COMMIT") { entered(); await resume; } return (query as any).apply(client, args); }) as any;
      client.release = (...args: any[]) => { client.query = query; client.release = done; return done.apply(client, args); };
      return client;
    } };
    const pending = new DevConnectionStore(delayedPool as pg.Pool, keys).revokeConnection(a, ar.connectionId);
    await paused;
    const second = store.revokeConnection(other, id);
    let first: any[] = [];
    try {
      // A correct writer waits for A's commit; the old writer commits B first.
      await Promise.race([second, new Promise(resolve => setTimeout(resolve, 150))]);
      first = await store.revocations(a.generation, "0");
    } finally { release(); }
    await Promise.all([pending, second]);
    const remaining = await store.revocations(a.generation, first.at(-1)?.sequence ?? "0");
    expect([...first, ...remaining].map(event => event.binding_id)).toEqual(expect.arrayContaining([ar.bindingId, ref.bindingId]));
  });
  it.each(["github", "codex"] as const)("explicit fresh %s authorization fences an uncertain owner and its late publication", async kind => {
    const { ar, br } = await connect(kind), grantScope = kind === "github" ? { action: "github:catalog" as const } : scope;
    const pending = (await store.reserve(a, ar.bindingId, grantScope))!;
    await store.dispatch(a, ar.bindingId, grantScope, pending); await store.settle(pending);
    const material = kind === "github" ? { ...(pending.material as any), accessToken: "synthetic-new-access", refreshToken: "synthetic-new-refresh",
      expiresAt: Math.floor(Date.now()/1000)+3600 } : { kind: "codex-chatgpt", nativeCache: rotated() };
    const input = { id: randomUUID(), accountId: ar.accountId, appScope: ar.appScope, material, replaceExisting: true,
      consent: { models: ["test-model"], repositories: [], scopes: kind === "github" ? ["github:read"] : ["agent"] } };
    await expect(store.connect(a, input)).resolves.toEqual({ connectionId: input.id });
    await expect(store.connect(a, input)).resolves.toEqual({ connectionId: input.id });
    await expect(store.publish(pending, material as any)).rejects.toThrow();
    await expect(store.snapshot(b, br.bindingId, grantScope)).rejects.toThrow();
    expect((await store.revocations(b.generation, "0")).map(row => row.binding_id)).toContain(br.bindingId);
    expect((await pool.query("SELECT state FROM dev_connections.refresh_attempts WHERE id=$1", [pending.attempt.id])).rows[0].state).toBe("abandoned");
    await expect(store.connect(a, { ...input, id: randomUUID(), material: pending.material })).rejects.toThrow();
    expect((await store.restore(a)).map(row => row.connectionId)).toEqual([input.id]);
    expect((await pool.query("SELECT count(*)::int n FROM dev_connections.refresh_fingerprints WHERE connection_id=$1", [ar.connectionId])).rows[0].n).toBeGreaterThan(0);
  });
  it("persists explicit all-model self consent without authorizing another provider", async () => {
    const id = randomUUID();
    await store.connect(a, { id, accountId: id, appScope: "api", material: { kind: "cursor-api-key", apiKey: "synthetic-consent-test" },
      consent: { models: ["grok-4.6"], repositories: [], scopes: ["agent"] } });
    await store.consent(a, id, { models: ["grok-4.6"], allModels: true, repositories: [], scopes: ["agent"] });
    const [ref] = await store.restore(b);
    expect(ref!.consent).toMatchObject({ allModels: true });
    const request = { action: "agent", workspaceId: randomUUID(), model: "grok-4.7" };
    await expect(store.snapshot(b, ref!.bindingId, request)).resolves.toBeTruthy();
    await expect(store.snapshot(b, ref!.bindingId, { ...request, model: "gpt-6.1-sol" })).rejects.toThrow();
    await store.consent(a, id, { models: ["grok-4.6"], allModels: false, repositories: [], scopes: ["agent"] });
    const [restricted] = await store.restore(b);
    await expect(store.snapshot(b, restricted!.bindingId, request)).rejects.toThrow();
  });
  it("persists one selected agent per provider across generations and consent retries",async()=>{
    const ids=[randomUUID(),randomUUID()];
    for(const id of ids)await store.connect(a,{id,accountId:id,appScope:'api',material:{kind:'cursor-api-key',apiKey:`synthetic-${id}`},consent:{models:[],repositories:[],scopes:['agent']}});
    const consent={models:['test-model'],repositories:[],scopes:['agent']};
    await store.consent(a,ids[0]!,consent);await store.restore(b);
    await store.consent(a,ids[1]!,consent);
    const first=await store.restore(b);
    expect(first.filter(r=>r.consent.models.length).map(r=>r.connectionId)).toEqual([ids[1]]);
    await store.consent(a,ids[1]!,consent);
    expect((await store.restore(b)).map(r=>[r.connectionId,r.consentRevision])).toEqual(first.map(r=>[r.connectionId,r.consentRevision]));
  });
  it("forces one known version through the same journal and quarantines restored backup material",async()=>{
    const {ar}=await connect();
    const renew=vi.fn(async (_cache,dispatch)=>{await dispatch();return rotated();});
    const service=broker(renew),first=await service.grant(a,ar.bindingId,scope);
    await pool.query("UPDATE dev_connections.connections SET refresh_after=clock_timestamp()-interval '1 second'");
    const forced=await service.grant(a,ar.bindingId,scope,first.materialVersion);
    expect(forced.materialVersion).toBe(first.materialVersion!+1);
    expect((await service.grant(a,ar.bindingId,scope,first.materialVersion)).materialVersion).toBe(forced.materialVersion);
    expect(renew).toHaveBeenCalledTimes(2);
    const fingerprints=(await pool.query('SELECT count(*) AS n FROM dev_connections.refresh_fingerprints')).rows;
    await quarantineRestoredConnections(pool);
    await expect(service.grant(a,ar.bindingId,scope)).rejects.toThrow();
    expect((await pool.query('SELECT * FROM dev_connections.connection_versions')).rowCount).toBe(0);
    expect((await pool.query('SELECT count(*) AS n FROM dev_connections.refresh_fingerprints')).rows).toEqual(fingerprints);
    expect((await pool.query('SELECT * FROM dev_connections.generation_revocations WHERE id=$1',[a.generation.id])).rowCount).toBe(1);
  });
  it("two independent generations dispatch exactly one native renewal", async () => {
    const { ar, br } = await connect();
    let resume!: () => void, started!: () => void;
    const wait = new Promise<void>((r) => {
        resume = r;
      }),
      ready = new Promise<void>((r) => {
        started = r;
      });
    const renew = vi.fn(async (_cache, dispatch) => {
      await dispatch();
      started();
      await wait;
      return rotated();
    });
    const first = broker(renew).grant(a, ar.bindingId, scope);
    await ready;
    const second = broker(renew).grant(b, br.bindingId, scope);
    resume();
    const grants = await Promise.all([first, second]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(
      grants.every(
        (g) =>
          g.material.kind === "codex-chatgpt" &&
          !("refreshToken" in g.material) &&
          !("nativeCache" in g.material),
      ),
    ).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM dev_connections.grant_audit",
        )
      ).rows[0].n,
    ).toBe(2);
  });
  it("lost provider acknowledgement becomes uncertain and cannot retry after restart or timeout", async () => {
    const { ar } = await connect();
    const renew = vi.fn(async (_cache, dispatch) => {
      await dispatch();
      throw new Error("synthetic-private-provider-body");
    });
    await expect(
      broker(renew).grant(a, ar.bindingId, scope),
    ).rejects.toMatchObject({ code: "dev_connection_reconnect_required" });
    await pool.query(
      "UPDATE dev_connections.refresh_attempts SET started_at=now()-interval '1 day'",
    );
    await expect(
      broker(renew).grant(a, ar.bindingId, scope),
    ).rejects.toMatchObject({ code: "dev_connection_reconnect_required" });
    expect(renew).toHaveBeenCalledTimes(1);
    expect(
      (await pool.query("SELECT state FROM dev_connections.refresh_attempts"))
        .rows[0].state,
    ).toBe("uncertain");
  });
  it("serializes GitHub refresh ownership across generations too", async () => {
    const { ar, br } = await connect("github");
    const renew = vi.fn(async (material, dispatch) => {
      await dispatch();
      return {
        ...material,
        accessToken: "synthetic-new-access-token",
        refreshToken: "synthetic-new-refresh-token",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });
    const service = () =>
      new DevConnectionBroker(store, {
        codex: async () => {
          throw new Error("unused");
        },
        github: renew,
        githubAccess: async () => {},
      });
    const githubScope = {
      workspaceId: randomUUID(),
      action: "github:read" as const,
      repository: "example/repo",
      installationId: 99,
    };
    const results = await Promise.all([
      service().grant(a, ar.bindingId, githubScope),
      service().grant(b, br.bindingId, githubScope),
    ]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(results.every((g) => !("refreshToken" in g.material))).toBe(true);
  });
  it("archive fences only one generation; global disconnect stops both", async () => {
    const { ar, br } = await connect();
    const renew = vi.fn(async (_cache, dispatch) => {
      await dispatch();
      return rotated();
    });
    await store.revokeGeneration(a.generation.id);
    await expect(
      broker(renew).grant(a, ar.bindingId, scope),
    ).rejects.toMatchObject({ status: 403 });
    await broker(renew).grant(b, br.bindingId, scope);
    await store.revokeConnection(b, br.connectionId);
    await expect(
      broker(renew).grant(b, br.bindingId, scope),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM dev_connections.revocation_outbox",
        )
      ).rows[0].n,
    ).toBeGreaterThanOrEqual(2);
  });
  it("disconnect racing refresh cannot publish newly usable access", async () => {
    const { ar } = await connect();
    const renew = vi.fn(async (_cache, dispatch) => {
      await dispatch();
      await store.revokeConnection(a, ar.connectionId);
      return rotated();
    });
    await expect(
      broker(renew).grant(a, ar.bindingId, scope),
    ).rejects.toBeDefined();
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM dev_connections.grant_audit",
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it.each([
    "member",
    "issuer",
    "organization",
    "generation",
    "audience",
    "credential",
    "model",
  ])("denies cross-%s use", async (mode) => {
    const { ar } = await connect();
    const ctx = structuredClone(a),
      requested = { ...scope };
    if (mode === "member") ctx.member.subject = "user_other";
    if (mode === "issuer") ctx.member.issuer = "https://another.example.test";
    if (mode === "organization") ctx.member.organization = "org_other";
    if (mode === "generation") ctx.generation = b.generation;
    if (mode === "audience") ctx.generation.audience = "other";
    if (mode === "credential")
      ctx.generation.credential = randomBytes(32).toString("base64url");
    if (mode === "model") requested.model = "unconsented-model";
    const renew = vi.fn();
    await expect(
      broker(renew).grant(ctx, ar.bindingId, requested),
    ).rejects.toMatchObject({ status: 403 });
    expect(renew).not.toHaveBeenCalled();
  });
  it("does not restore another member or another organization's consent", async () => {
    await connect();
    expect(
      await store.restore({
        ...a,
        member: { ...a.member, subject: "user_other" },
      }),
    ).toEqual([]);
    await expect(
      store.restore({
        ...a,
        member: { ...a.member, organization: "org_other" },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("a duplicate native seed cannot evade the persistent family fence", async () => {
    await connect();
    await expect(connect()).rejects.toMatchObject({ status: 409 });
  });
  it("retains a refresh-only Codex rotation without issuing expired access or immediately rotating again", async () => {
    const cache = syntheticCodexCache({
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    await store.connect(a, {
      id: randomUUID(),
      accountId: "synthetic-account",
      appScope: "chatgpt",
      material: { kind: "codex-chatgpt", nativeCache: cache },
      consent: { models: ["test-model"], repositories: [], scopes: ["agent"] },
    });
    const [ref] = await store.restore(a),
      nextSeed = "synthetic-new-refresh-only-token";
    const renew = vi.fn(async (original, dispatch) => {
      await dispatch();
      return {
        ...original,
        tokens: { ...original.tokens, refresh_token: nextSeed },
      };
    });
    await expect(
      broker(renew).grant(a, ref!.bindingId, scope),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await pool.query("SELECT state FROM dev_connections.refresh_attempts"))
        .rows[0].state,
    ).toBe("published");
    const snapshot = await store.snapshot(a, ref!.bindingId, scope);
    expect(
      snapshot.material.kind === "codex-chatgpt" &&
        snapshot.material.nativeCache.tokens.refresh_token === nextSeed,
    ).toBe(true);
    await expect(
      broker(renew).grant(a, ref!.bindingId, scope),
    ).rejects.toMatchObject({ status: 409 });
    expect(renew).toHaveBeenCalledTimes(1);
  });
  it("an archived generation cannot be registered again", async () => {
    const g = registration();
    await store.registerGeneration(g);
    await store.revokeGeneration(g.id);
    await expect(store.registerGeneration(g)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("archive before a delayed registration permanently fences the generation", async () => {
    const g = registration();
    await store.revokeGeneration(g.id);
    await expect(store.registerGeneration(g)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("a consumed seed stays fenced across members and disconnect", async () => {
    const { ar } = await connect();
    await store.revokeConnection(a, ar.connectionId);
    const other = { ...b, member: { ...b.member, subject: "user_other" } };
    await expect(
      store.connect(other, {
        id: randomUUID(),
        accountId: "synthetic-account",
        appScope: "chatgpt",
        material: { kind: "codex-chatgpt", nativeCache: syntheticCodexCache() },
        consent: {
          models: ["test-model"],
          repositories: [],
          scopes: ["agent"],
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("pre-dispatch reservations may expire; dispatched work never does", async () => {
    const { ar } = await connect(),
      first = await store.reserve(a, ar.bindingId, scope);
    await pool.query(
      "UPDATE dev_connections.refresh_attempts SET started_at=now()-interval '1 minute'",
    );
    const next = await store.reserve(a, ar.bindingId, scope);
    expect(next?.attempt.id).not.toBe(first?.attempt.id);
    await expect(
      store.dispatch(a, ar.bindingId, scope, first!),
    ).rejects.toMatchObject({ status: 409 });
    await store.dispatch(a, ar.bindingId, scope, next!);
    await pool.query(
      "UPDATE dev_connections.refresh_attempts SET started_at=now()-interval '1 minute'",
    );
    const stale = await store.reserve(a, ar.bindingId, scope);
    expect(stale?.attempt.state).toBe("uncertain");
    expect(stale?.material).toBeUndefined();
    await store.publish(next!, {
      kind: "codex-chatgpt",
      nativeCache: rotated(),
    });
    expect(await store.renewalState(next!)).toBe("published");
  });
  it("lost database publication acknowledgement reads back without another dispatch", async () => {
    const { ar } = await connect();
    let publication = false,
      lost = false;
    const wrapped = {
      connect: async () => {
        const tx = await pool.connect();
        return new Proxy(tx, {
          get(target, key) {
            if (key === "query")
              return async (...args: unknown[]) => {
                const sql = typeof args[0] === "string" ? args[0] : "";
                if (
                  sql.startsWith(
                    "UPDATE dev_connections.connections SET current_version",
                  )
                )
                  publication = true;
                const result = await (
                  target.query as (...args: unknown[]) => Promise<unknown>
                ).apply(target, args);
                if (sql === "COMMIT" && publication && !lost) {
                  lost = true;
                  throw new Error("synthetic-lost-commit-ack");
                }
                return result;
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as pg.Pool;
    const renew = vi.fn(async (_cache, dispatch) => {
      await dispatch();
      return rotated();
    });
    await new DevConnectionBroker(new DevConnectionStore(wrapped, keys), {
      codex: renew,
      github: vi.fn(),
      githubAccess: vi.fn(),
    }).grant(a, ar.bindingId, scope);
    expect(lost).toBe(true);
    expect(renew).toHaveBeenCalledTimes(1);
  });
  it("rotating a generation credential immediately fences old credentials and bindings", async () => {
    const g = registration();
    await store.registerGeneration(g);
    const old = {
      ...a,
      generation: { id: g.id, credential: g.credential, audience: g.audience },
    };
    await connect();
    const [ref] = await store.restore(old);
    const changed = {
      ...g,
      keyRevision: 2,
      credential: randomBytes(32).toString("base64url"),
    };
    await store.rotateGeneration(changed);
    await store.rotateGeneration(changed);
    await expect(
      store.snapshot(old, ref!.bindingId, scope),
    ).rejects.toMatchObject({ status: 403 });
    const next = {
      ...old,
      generation: { ...old.generation, credential: changed.credential },
    };
    await expect(
      store.snapshot(next, ref!.bindingId, scope),
    ).rejects.toMatchObject({ status: 403 });
    expect(await store.restore(next)).toHaveLength(1);
  });
  it("consent revocation propagates to both generations and cannot restore", async () => {
    const { ar, br } = await connect();
    await store.consent(a, ar.connectionId, null);
    expect(await store.restore(b)).toEqual([]);
    await expect(store.snapshot(b, br.bindingId, scope)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("fresh generations restore all four provider references without native caches", async () => {
    await connect();
    await connect("github");
    for (const kind of ["claude-setup-token", "cursor-api-key"])
      await store.connect(a, {
        id: randomUUID(),
        accountId: kind,
        appScope: "api",
        material:
          kind === "claude-setup-token"
            ? { kind, accessToken: "synthetic-claude-token" }
            : { kind, apiKey: "synthetic-cursor-api-key" },
        consent: {
          models: ["test-model"],
          repositories: [],
          scopes: ["agent"],
        },
      });
    const refs = await store.restore(b);
    expect(refs).toHaveLength(4);
    expect(JSON.stringify(refs)).not.toMatch(
      /synthetic-(refresh|claude-token|cursor-api-key)|nativeCache|accessToken/,
    );
  });
  it("old ciphertext remains readable during encryption rotation; missing fingerprint keys fail closed", async () => {
    const { ar } = await connect(),
      key2 = randomBytes(32).toString("base64url");
    const rotatedStore = new DevConnectionStore(pool, {
      ...keys,
      currentKeyVersion: 2,
      keys: { ...keys.keys, 2: key2 },
    });
    expect(
      (await rotatedStore.snapshot(a, ar.bindingId, scope)).material.kind,
    ).toBe("codex-chatgpt");
    const broken = new DevConnectionStore(pool, {
      ...keys,
      refreshFingerprints: {
        currentKeyVersion: 2,
        keys: { 2: randomBytes(32).toString("base64url") },
      },
    });
    const other = { ...a, member: { ...a.member, subject: "other_member" } };
    await expect(
      broken.connect(other, {
        id: randomUUID(),
        accountId: "synthetic-account",
        appScope: "chatgpt",
        material: { kind: "codex-chatgpt", nativeCache: rotated() },
        consent: {
          models: ["test-model"],
          repositories: [],
          scopes: ["agent"],
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("RLS denies an ordinary zeros_app transaction without broker authority", async () => {
    await connect();
    const client = await pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL ROLE zeros_app");
      expect(
        (await client.query("SELECT * FROM dev_connections.connections")).rows,
      ).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
  it("migrations replay idempotently and reject ledger tampering or product databases", async () => {
    await migrateDevConnections(pool);
    await checkDevConnectionsSchema(pool);
    const original = (
      await pool.query(
        "SELECT sha256 FROM public.dev_connections_migrations WHERE name='0001_connections.sql'",
      )
    ).rows[0].sha256;
    await pool.query(
      "UPDATE public.dev_connections_migrations SET sha256='changed' WHERE name='0001_connections.sql'",
    );
    try {
      await expect(migrateDevConnections(pool)).rejects.toThrow(
        "checksum mismatch",
      );
    } finally {
      await pool.query(
        "UPDATE public.dev_connections_migrations SET sha256=$1 WHERE name='0001_connections.sql'",
        [original],
      );
    }
    await pool.query("CREATE TABLE public.users(id uuid)");
    try {
      await expect(migrateDevConnections(pool)).rejects.toThrow(
        "dedicated database",
      );
    } finally {
      await pool.query("DROP TABLE public.users");
    }
  });
});
