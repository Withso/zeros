// The rehearsal's live adapters for Alpha. Credentials are read by the CLI from .env.agent and the private profile, held
// in memory, and used only in request headers and connection strings; no adapter returns, logs or stores one, and no
// failure carries a provider's message or body.
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import pg from "pg";
import { z } from "zod";
import type { GithubBackendConfig } from "../../config.js";
import { createGithubAppJwt } from "../../github-app-jwt.js";
import { planetScaleClient, roleConnectionString } from "../../manage-release-migration.js";
import { BoatApiClient } from "../boat-client.js";
import { BoatCloudV2Compute } from "../boat.js";
import { ALPHA_PROBE_ORIGIN, alphaProbeIdentity } from "../gate0-alpha.js";
import { BridgeProbe, Gate0Failure } from "../gate0.js";
import { RehearsalFailure, type Api, type Boat, type Bridge, type Clock, type Database, type Github, type Ports, type ProGrant, type ProPort, type Query,
  type Storage } from "./contract.js";
import { manageAccountPro } from "../../manage-account-pro.js";
import { assertRepository, prefixed } from "./guard.js";

const TIMEOUT_MS = 30_000;

export const liveClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

export async function liveRelease(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${ALPHA_PROBE_ORIGIN}/v1/release-identity`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); return false; }
    alphaProbeIdentity(await response.json());
    return true;
  } catch { return false; }
}

export function liveApi(accessToken: () => Promise<string>, fetchImpl: typeof fetch = fetch): Api {
  return {
    async json(method, path, body, headers = {}) {
      if (!path.startsWith("/v1/")) throw new RehearsalFailure("api", "path");
      const response = await fetchImpl(`${ALPHA_PROBE_ORIGIN}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const raw = await response.text();
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed };
    },
  };
}

/** gate0's bridge client, opened with a connect ticket validated as gate0 validates it. */
export function liveBridge(api: Api, timeoutMs = 600_000, pollMs = 1_000): (workspaceId: string) => Promise<Bridge> {
  return async workspaceId => {
    const reply = await api.json("POST", `/v1/cloud-v2/workspaces/${workspaceId}/connect`);
    if (reply.status !== 200) throw new RehearsalFailure("connect", `http_${reply.status}`);
    const ticket = z.object({ url: z.string().url(), protocols: z.array(z.string()).length(2) }).safeParse(reply.body);
    if (!ticket.success) throw new RehearsalFailure("connect", "schema");
    const target = new URL(ticket.data.url);
    if (target.protocol !== "wss:" || target.username || target.password || target.search || target.hash ||
      ticket.data.protocols[0] !== "zeros.cloud.v2" || !ticket.data.protocols[1]?.startsWith("ticket.")) throw new RehearsalFailure("connect", "ticket");
    const probe = await wrap("bridge_open", () => BridgeProbe.open(ticket.data, timeoutMs, pollMs));
    return {
      op: (op, params) => wrap(op, () => probe.op(op, params)),
      request: (type, fields, step) => wrap(step, () => probe.request(type, fields, step)),
      send: (type, fields) => { try { return probe.send(type, fields); } catch { throw new RehearsalFailure("bridge_send", "disconnected"); } },
      frames: () => probe.frames,
      close: () => probe.close(),
    };
  };
}
async function wrap<T>(step: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    throw error instanceof Gate0Failure ? new RehearsalFailure(step.slice(0, 64).replace(/[^a-z0-9_.:-]/gi, "_").toLowerCase(), error.cause ?? "bridge")
      : new RehearsalFailure(step.slice(0, 64).replace(/[^a-z0-9_.:-]/gi, "_").toLowerCase(), "bridge");
  }
}

export function liveBoat(input: { apiKey: string; billingOrg?: string }): Boat {
  const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: input.apiKey, timeoutMs: 20_000, ...(input.billingOrg ? { billingOrg: input.billingOrg } : {}) }));
  return {
    async inspect(machineId) {
      try { const row = await compute.inspect(machineId); return { name: row.name, state: row.state }; } catch (error) {
        if ((error as { code?: unknown }).code === "provider_not_found") return null;
        throw new RehearsalFailure("boat_inspect", String((error as { code?: unknown }).code ?? "failed"));
      }
    },
    async delete(machineId) {
      try { await compute.delete(machineId); } catch (error) { throw new RehearsalFailure("boat_delete", String((error as { code?: unknown }).code ?? "failed")); }
    },
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Backup objects live under cloud-v2/checkpoints/<workspace>/ (checkpoint.ts). Only those prefixes are listed or deleted. */
export function liveStorage(input: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string }, workspaces: () => readonly string[]): Storage {
  const client = new S3Client({ region: "auto", endpoint: input.endpoint, forcePathStyle: true, maxAttempts: 2,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey } });
  const prefix = (workspaceId: string) => {
    if (!UUID.test(workspaceId)) throw new RehearsalFailure("storage", "workspace");
    return `cloud-v2/checkpoints/${workspaceId}/`;
  };
  return {
    async keys(workspaceId) {
      const keys: string[] = [];
      let token: string | undefined;
      try {
        do {
          const page = await client.send(new ListObjectsV2Command({ Bucket: input.bucket, Prefix: prefix(workspaceId), ContinuationToken: token, MaxKeys: 1000 }));
          for (const row of page.Contents ?? []) if (row.Key) keys.push(row.Key);
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
      } catch (error) { throw error instanceof RehearsalFailure ? error : new RehearsalFailure("storage_list", "failed"); }
      return keys;
    },
    async delete(key) {
      if (!workspaces().some(id => key.startsWith(prefix(id)))) throw new RehearsalFailure("storage_delete", "not_this_run");
      try { await client.send(new DeleteObjectCommand({ Bucket: input.bucket, Key: key })); } catch { throw new RehearsalFailure("storage_delete", "failed"); }
    },
  };
}

/** The Alpha GitHub App on the Withso installation, with tokens scoped to the fixture repositories only. */
export function liveGithub(input: { appId: number; privateKey: string; owner: string }, fetchImpl: typeof fetch = fetch): Github {
  const api = "https://api.github.com";
  const config = { appId: input.appId, privateKey: input.privateKey } as GithubBackendConfig;
  let installation: number | undefined;
  const tokens = new Map<string, { token: string; until: number }>();
  const request = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetchImpl(`${api}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const raw = await response.text();
    let parsed: unknown = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
    return { status: response.status, body: parsed };
  };
  const installationId = async () => {
    if (installation) return installation;
    const listed = await request("GET", "/app/installations?per_page=100", createGithubAppJwt(config));
    const rows = z.array(z.object({ id: z.number(), account: z.object({ login: z.string() }).nullable() }).passthrough()).safeParse(listed.body);
    const found = rows.success ? rows.data.find(row => row.account?.login.toLowerCase() === input.owner.toLowerCase()) : undefined;
    if (!found) throw new RehearsalFailure("github_installation", `http_${listed.status}`);
    return installation = found.id;
  };
  /** A token for `names` only (repository names under the owner), or the installation's administration token for creates. */
  const token = async (names: readonly string[], permissions: Record<string, string>) => {
    const key = `${names.join(",")}|${JSON.stringify(permissions)}`, cached = tokens.get(key);
    if (cached && cached.until > Date.now()) return cached.token;
    const minted = await request("POST", `/app/installations/${await installationId()}/access_tokens`, createGithubAppJwt(config),
      { repositories: names, permissions });
    const body = z.object({ token: z.string().min(1) }).passthrough().safeParse(minted.body);
    if (minted.status !== 201 || !body.success) throw new RehearsalFailure("github_token", `http_${minted.status}`);
    tokens.set(key, { token: body.data.token, until: Date.now() + 40 * 60_000 });
    return body.data.token;
  };
  const name = (repository: string) => {
    const [owner, repo] = assertRepository(repository).split("/");
    if (owner!.toLowerCase() !== input.owner.toLowerCase()) throw new RehearsalFailure("repository_refused", "owner");
    return repo!;
  };
  const write = (repository: string) => token([name(repository)], { metadata: "read", contents: "write", pull_requests: "write" });
  const ok = (status: number, step: string, allowed: number[]) => { if (!allowed.includes(status)) throw new RehearsalFailure(step, `http_${status}`); };
  return {
    async repositoryExists(repository) {
      try { return (await request("GET", `/repos/${repository}`, await token([name(repository)], { metadata: "read" }))).status === 200; }
      catch (error) { if (error instanceof RehearsalFailure && error.step === "github_token") return false; throw error; }
    },
    async createRepository(repository) {
      const repo = name(repository);
      if (repo === "zeros-dev-fixture") throw new RehearsalFailure("repository_refused", "r1");
      // Created by the App, so the installation includes it; administration is asked for on R1 only, which exists.
      const admin = await token(["zeros-dev-fixture"], { metadata: "read", administration: "write" });
      const created = await request("POST", `/orgs/${input.owner}/repos`, admin, { name: repo, private: true, auto_init: true, gitignore_template: "Node" });
      ok(created.status, "repository_create", [201]);
    },
    async deleteRepository(repository) {
      const repo = name(repository);
      if (repo === "zeros-dev-fixture") throw new RehearsalFailure("repository_refused", "r1");
      const removed = await request("DELETE", `/repos/${input.owner}/${repo}`, await token([repo], { metadata: "read", administration: "write" }));
      ok(removed.status, "repository_delete", [204, 404]);
    },
    async branches(repository, prefix) {
      const reply = await request("GET", `/repos/${repository}/git/matching-refs/heads/${encodeURIComponent(prefix)}`, await write(repository));
      ok(reply.status, "github_branches", [200]);
      const refs = z.array(z.object({ ref: z.string() }).passthrough()).safeParse(reply.body);
      return refs.success ? refs.data.map(row => row.ref.replace(/^refs\/heads\//, "")).filter(branch => prefixed(prefix, branch)) : [];
    },
    async deleteBranch(repository, branch) {
      if (!/^zr-[0-9a-f]{8}-/.test(branch)) throw new RehearsalFailure("branch_refused", "unprefixed");
      const reply = await request("DELETE", `/repos/${repository}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, await write(repository));
      ok(reply.status, "branch_delete", [204, 404, 422]);
    },
    async openPulls(repository, prefix) {
      const reply = await request("GET", `/repos/${repository}/pulls?state=open&per_page=100`, await write(repository));
      ok(reply.status, "github_pulls", [200]);
      const rows = z.array(z.object({ number: z.number(), head: z.object({ ref: z.string() }) }).passthrough()).safeParse(reply.body);
      return rows.success ? rows.data.filter(row => prefixed(prefix, row.head.ref)).map(row => row.number) : [];
    },
    async ignores(repository, path) {
      const reply = await request("GET", `/repos/${repository}/contents/.gitignore`, await token([name(repository)], { metadata: "read", contents: "read" }));
      if (reply.status === 404) return false;
      ok(reply.status, "github_gitignore", [200]);
      const file = z.object({ content: z.string(), encoding: z.literal("base64") }).passthrough().safeParse(reply.body);
      if (!file.success) return false;
      const rules = new Set([path, `/${path}`, `${path}*`, `*${path.slice(path.lastIndexOf("."))}`]);
      return Buffer.from(file.data.content, "base64").toString("utf8").split(/\r?\n/).some(line => rules.has(line.trim()));
    },
    async closePull(repository, number) {
      const read = await request("GET", `/repos/${repository}/pulls/${number}`, await write(repository));
      const head = z.object({ head: z.object({ ref: z.string() }) }).passthrough().safeParse(read.body);
      if (!head.success || !/^zr-[0-9a-f]{8}-/.test(head.data.head.ref)) throw new RehearsalFailure("pull_refused", "unprefixed");
      ok((await request("PATCH", `/repos/${repository}/pulls/${number}`, await write(repository), { state: "closed" })).status, "pull_close", [200]);
    },
  };
}

/** The playbook's RLS-safe read: app.system is set by a materialized CTE before the statement's rows are read. */
export const rlsSafe = (text: string) => `WITH cfg AS MATERIALIZED (SELECT set_config('app.system','on',true) AS v)
          SELECT x.* FROM cfg CROSS JOIN LATERAL (${text}) x WHERE cfg.v = 'on'`;

export type DatabaseClient = { connect(): Promise<unknown>; query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void> };
type Role = { id: string; name: string; username: string; password: string; access_host_url: string };

/** Least privilege (alpha-operator.md). Reads: one temporary role inheriting only pg_read_all_data (TTL 3600), minted on
 * the first read, every statement in the playbook's RLS-safe form inside READ ONLY, deleted by close(). A write: its own
 * role inheriting postgres, with zeros_app granted to the session_user, for that one transaction, deleted (until a GET
 * answers 404) before transaction() returns. */
/** The live database, plus one operator capability: work as a table's owner, for operators that require it
 * (manage-account-pro.ts checks current_user owns its tables). */
export type LiveDatabase = Database & {
  asTableOwner<T>(table: string, work: (pool: pg.Pool, connectionString: string) => Promise<T>): Promise<T>;
};

export function liveDatabase(input: { organization: string; database: string; tokenId: string; token: string; roleName: (kind: "read" | "write") => string;
  planetScale?: ReturnType<typeof planetScaleClient>; client?: (connectionString: string) => DatabaseClient; sleep?: (ms: number) => Promise<void>;
  pool?: (connectionString: string) => pg.Pool }): LiveDatabase {
  const planetScale = input.planetScale ?? planetScaleClient({ organization: input.organization, tokenId: input.tokenId, token: input.token });
  const client = input.client ?? (connectionString => new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 }));
  const sleep = input.sleep ?? liveClock.sleep;
  let branchPath: Promise<string> | undefined;
  const branch = () => branchPath ??= (async () => {
    const database = await planetScale("GET", `/databases/${input.database}`);
    const parsed = z.object({ default_branch: z.string().regex(/^[a-z0-9-]{1,64}$/) }).passthrough().safeParse(database.body);
    if (database.status !== 200 || !parsed.success) { branchPath = undefined; throw new RehearsalFailure("database_branch", `http_${database.status}`); }
    return `/databases/${input.database}/branches/${parsed.data.default_branch}`;
  })();
  /** A role on the branch, and its deletion (retried until a GET answers 404). */
  const role = async (kind: "read" | "write"): Promise<{ role: Role; remove: () => Promise<void> }> => {
    const path = await branch();
    const created = await planetScale("POST", `${path}/roles`, { name: input.roleName(kind), inherited_roles: [kind === "read" ? "pg_read_all_data" : "postgres"], ttl: 3600 });
    const parsedRole = z.object({ id: z.string(), name: z.string(), username: z.string(), password: z.string(), access_host_url: z.string() }).passthrough().safeParse(created.body);
    const acknowledged = z.object({ id: z.string() }).passthrough().safeParse(created.body);
    const remove = async () => {
      if (!acknowledged.success) return;
      for (let attempt = 0; attempt < 10; attempt++) {
        await planetScale("DELETE", `${path}/roles/${encodeURIComponent(acknowledged.data.id)}`).catch(() => undefined);
        const read = await planetScale("GET", `${path}/roles/${encodeURIComponent(acknowledged.data.id)}`).catch(() => ({ status: 0 }));
        if (read.status === 404) return;
        await sleep(2_000);
      }
      throw new RehearsalFailure("database_role_delete", "unconfirmed");
    };
    if (created.status >= 300 || !parsedRole.success) {
      await remove().catch(() => undefined);
      throw new RehearsalFailure(`database_${kind}_role`, `http_${created.status}`);
    }
    return { role: parsedRole.data as Role, remove };
  };
  const mint = async (kind: "read" | "write"): Promise<{ held: DatabaseClient; remove: () => Promise<void> }> => {
    const { role: minted, remove } = await role(kind);
    const held = client(roleConnectionString(minted));
    try {
      await held.connect();
      if (kind === "write") {
        const user = String((await held.query("SELECT session_user::text AS name")).rows[0]?.name ?? "");
        await held.query(`GRANT zeros_app TO "${user.replace(/"/g, '""')}"`);
      }
    } catch {
      await held.end().catch(() => undefined);
      await remove().catch(() => undefined);
      throw new RehearsalFailure(`database_${kind}_connect`, "failed");
    }
    return { held, remove: async () => { await held.end().catch(() => undefined); await remove(); } };
  };
  const query = (held: DatabaseClient): Query => async (text, values) => {
    try { const result = await held.query(text, values); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; }
    catch { throw new RehearsalFailure("database", "query"); }
  };
  let reader: Promise<Awaited<ReturnType<typeof mint>>> | undefined;
  return {
    async read(text, values) {
      const opened = reader ??= mint("read").catch(error => { reader = undefined; throw error; });
      const { held } = await opened, run = query(held);
      await run("BEGIN READ ONLY");
      try {
        const rows = (await run(rlsSafe(text), values)).rows;
        await run("COMMIT");
        return rows;
      } catch (error) { await held.query("ROLLBACK").catch(() => undefined); throw error; }
    },
    async transaction(work) {
      const { held, remove } = await mint("write"), run = query(held);
      try {
        await run("BEGIN");
        try {
          await run("SELECT set_config('app.system','on',true)");
          const result = await work(run);
          await run("COMMIT");
          return result;
        } catch (error) { await held.query("ROLLBACK").catch(() => undefined); throw error; }
      } finally { await remove(); }
    },
    /** A postgres-inheriting role for this one operator call, its session switched (SET ROLE) to the table's owner when it
     * may, and deleted before this returns. */
    async asTableOwner(table, work) {
      if (!/^public\.[a-z_]{1,63}$/.test(table)) throw new RehearsalFailure("database_owner", "table");
      const { role: minted, remove } = await role("write");
      const connectionString = roleConnectionString(minted);
      const pool = (input.pool ?? (url => new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 })))(connectionString);
      try {
        const probe = await pool.connect();
        let owner: string;
        try {
          const row = (await probe.query<{ owner: string; member: boolean }>(`SELECT pg_get_userbyid(relowner) AS owner,
              pg_has_role(session_user, relowner, 'MEMBER') AS member FROM pg_class WHERE oid = $1::regclass`, [table])).rows[0];
          if (!row?.member) throw new RehearsalFailure("database_owner", "not_a_member");
          owner = row.owner;
        } finally { probe.release(true); }
        const quoted = `"${owner.replace(/"/g, '""')}"`;
        pool.on("connect", connection => { void connection.query(`SET ROLE ${quoted}`); });
        return await work(pool, connectionString);
      } catch (error) {
        throw error instanceof RehearsalFailure ? error : new RehearsalFailure("database_owner", "failed");
      } finally {
        await pool.end().catch(() => undefined);
        await remove();
      }
    },
    async close() {
      if (!reader) return;
      const pending = reader; reader = undefined;
      let opened: Awaited<typeof pending>;
      try { opened = await pending; } catch { return; }
      await opened.remove();
    },
  };
}

/** An account_entitlements row as the rehearsal compares grants: none, another authority's ("foreign"), or the operator's. */
export function grantOf(row: { status: string; cloud_workspaces_allowed: boolean; source: string; valid_from: string | Date; valid_until: string | Date | null } | undefined):
  ProGrant | null | "foreign" {
  if (!row) return null;
  if (row.source !== "operator") return "foreign";
  const iso = (value: string | Date) => new Date(value).toISOString();
  return { enabled: row.status === "active" && row.cloud_workspaces_allowed, validFrom: iso(row.valid_from), validUntil: row.valid_until === null ? null : iso(row.valid_until) };
}

/** The selected account's Individual Pro through manage-account-pro.ts: each change planned and executed in one process
 * (retried once on a plan mismatch, as the playbook says), as the entitlement tables' owner, then read back. */
export function livePro(database: LiveDatabase, input: { subjectUserId: string; expectedEmail: string; actorUserId: string }): ProPort {
  const read = async () => grantOf((await database.read(`SELECT status, cloud_workspaces_allowed, source, valid_from, valid_until
    FROM account_entitlements WHERE user_id = $1::uuid`, [input.subjectUserId]))[0] as Parameters<typeof grantOf>[0]);
  return {
    read,
    async change(grant, reason) {
      const operationId = randomUUID();
      const document = { operationId, channel: "alpha", subjectUserId: input.subjectUserId, expectedEmail: input.expectedEmail, actorUserId: input.actorUserId,
        enabled: grant.enabled, validFrom: grant.validFrom, validUntil: grant.validUntil, reason };
      await database.asTableOwner("public.account_entitlements", async (pool, databaseUrl) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const planned = await manageAccountPro(pool, document, { databaseUrl, channel: "alpha" });
            await manageAccountPro(pool, document, { databaseUrl, channel: "alpha", execute: true, approval: planned.planSha256 });
            return;
          } catch (error) {
            // The operator's messages are fixed text, never values; only the plan mismatch is retried.
            if (attempt === 0 && error instanceof Error && error.message.startsWith("Individual Pro plan changed")) continue;
            throw new RehearsalFailure("pro_change", error instanceof Error && /active platform owner/.test(error.message) ? "actor" :
              error instanceof Error && /overwrite billing/.test(error.message) ? "foreign_grant" : "refused");
          }
        }
      });
      const after = await read();
      if (after === "foreign" || !after || after.enabled !== grant.enabled || after.validFrom !== grant.validFrom || after.validUntil !== grant.validUntil)
        throw new RehearsalFailure("pro_read_back", "mismatch");
      return operationId;
    },
  };
}

/** The account's own GitHub sign-in by token. The token is used only in this request's body. */
export function liveGithubSignIn(api: Api, token: string): NonNullable<Ports["githubSignIn"]> {
  return {
    async connect(organizationId, expected) {
      const reply = await api.json("POST", "/v1/cloud-v2/github/connection", { organizationId, expected, action: "pat", token });
      if (reply.status !== 200) throw new RehearsalFailure("github_sign_in_connect", `http_${reply.status}`);
    },
  };
}
