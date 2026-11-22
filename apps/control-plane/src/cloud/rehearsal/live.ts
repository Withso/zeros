// The rehearsal's live adapters for Alpha. Credentials are read by the CLI from .env.agent and the private profile, held
// in memory, and used only in request headers and connection strings; no adapter returns, logs or stores one, and no
// failure carries a provider's message or body.
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
import { RehearsalFailure, type Api, type Boat, type Bridge, type Clock, type Database, type Github, type Query, type Storage } from "./contract.js";
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
      const created = await request("POST", `/orgs/${input.owner}/repos`, admin, { name: repo, private: true, auto_init: true });
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
    async closePull(repository, number) {
      const read = await request("GET", `/repos/${repository}/pulls/${number}`, await write(repository));
      const head = z.object({ head: z.object({ ref: z.string() }) }).passthrough().safeParse(read.body);
      if (!head.success || !/^zr-[0-9a-f]{8}-/.test(head.data.head.ref)) throw new RehearsalFailure("pull_refused", "unprefixed");
      ok((await request("PATCH", `/repos/${repository}/pulls/${number}`, await write(repository), { state: "closed" })).status, "pull_close", [200]);
    },
  };
}

/** One temporary PlanetScale role (inherits postgres, TTL 3600), minted on first use, granted zeros_app on its
 * session_user as the operator playbook says, and deleted by close() until a GET answers 404. */
export function liveDatabase(input: { organization: string; database: string; tokenId: string; token: string; roleName: () => string }): Database {
  const planetScale = planetScaleClient({ organization: input.organization, tokenId: input.tokenId, token: input.token });
  let open: Promise<{ client: pg.Client; roleId: string; branchPath: string }> | undefined;
  const connect = () => open ??= (async () => {
    const database = await planetScale("GET", `/databases/${input.database}`);
    const branch = z.object({ default_branch: z.string().regex(/^[a-z0-9-]{1,64}$/) }).passthrough().safeParse(database.body);
    if (database.status !== 200 || !branch.success) throw new RehearsalFailure("database_branch", `http_${database.status}`);
    const branchPath = `/databases/${input.database}/branches/${branch.data.default_branch}`;
    const created = await planetScale("POST", `${branchPath}/roles`, { name: input.roleName(), inherited_roles: ["postgres"], ttl: 3600 });
    const role = z.object({ id: z.string(), name: z.string(), username: z.string(), password: z.string(), access_host_url: z.string() }).passthrough().safeParse(created.body);
    if (created.status >= 300 || !role.success) throw new RehearsalFailure("database_role", `http_${created.status}`);
    const client = new pg.Client({ connectionString: roleConnectionString(role.data), connectionTimeoutMillis: 15_000 });
    try {
      await client.connect();
      const user = (await client.query<{ name: string }>("SELECT session_user::text AS name")).rows[0]!.name;
      await client.query(`GRANT zeros_app TO "${user.replace(/"/g, '""')}"`);
    } catch {
      await client.end().catch(() => undefined);
      await removeRole(branchPath, role.data.id);
      open = undefined;
      throw new RehearsalFailure("database_connect", "failed");
    }
    return { client, roleId: role.data.id, branchPath };
  })();
  const removeRole = async (branchPath: string, roleId: string) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await planetScale("DELETE", `${branchPath}/roles/${encodeURIComponent(roleId)}`).catch(() => undefined);
      const read = await planetScale("GET", `${branchPath}/roles/${encodeURIComponent(roleId)}`).catch(() => ({ status: 0 }));
      if (read.status === 404) return;
      await liveClock.sleep(2_000);
    }
    throw new RehearsalFailure("database_role_delete", "unconfirmed");
  };
  const query = (client: pg.Client): Query => async (text, values) => {
    try { const result = await client.query(text, values as unknown[] | undefined); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; }
    catch { throw new RehearsalFailure("database", "query"); }
  };
  return {
    async read(text, values) {
      const { client } = await connect(), run = query(client);
      await run("BEGIN READ ONLY");
      try {
        await run("SELECT set_config('app.system','on',true)");
        const result = await run(text, values);
        await run("COMMIT");
        return result.rows;
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    },
    async transaction(work) {
      const { client } = await connect(), run = query(client);
      await run("BEGIN");
      try {
        await run("SELECT set_config('app.system','on',true)");
        const result = await work(run);
        await run("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    },
    async close() {
      if (!open) return;
      const pending = open; open = undefined;
      let held: Awaited<typeof pending>;
      try { held = await pending; } catch { return; }
      await held.client.end().catch(() => undefined);
      await removeRole(held.branchPath, held.roleId);
    },
  };
}
