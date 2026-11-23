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
import { readRuntimeCapabilities } from "../runtime-capabilities.js";
import { BoatCloudV2Compute } from "../boat.js";
import { ALPHA_PROBE_ORIGIN, alphaProbeIdentity } from "../gate0-alpha.js";
import { BridgeProbe, Gate0Failure } from "../gate0.js";
import { RehearsalFailure, type AgentCredentialPort, type Api, type Boat, type Bridge, type Clock, type Database, type Github, type Ports, type ProGrant, type ProPort, type Query,
  type Storage } from "./contract.js";
import { manageAccountPro } from "../../manage-account-pro.js";
import { manageStaffRole, validateStaffRoleRequest } from "../../manage-staff.js";
import { assertRepository, prefixed } from "./guard.js";
import { connectWorkspace } from "./steps.js";

const TIMEOUT_MS = 30_000;

export const liveClock: Clock = { now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) };

/** Where a run goes: Alpha, or the Dev stack this checkout runs (`pnpm electron:cloud`, `--local`). Every request the
 * rehearsal's API, release and Pro ports make goes to `origin` with `channel`'s identity; nothing else is reached. */
export type RehearsalTarget = { kind: "alpha" | "local"; origin: string; channel: "alpha" | "development";
  /** --local: this stack's own recorded API port on loopback (http://127.0.0.1:<port>). API, identity and bridge requests go
   * there, so the tunnel is only on the path a VM needs; the public origin stays the stack's identity. */
  loopback?: string };

/** Transport failures a read may repeat, and the ones where the request never left (a write may repeat those too). */
const TRANSIENT = new Set(["ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"]);
const NEVER_SENT = new Set(["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "EAI_AGAIN"]);
/** Waits before the second, third and fourth try. */
export const NETWORK_RETRY_MS = [1_000, 3_000, 9_000] as const;
/** The transport code of a raw fetch failure (the error's or its cause's), or null when it is not one. */
export function networkCode(error: unknown): string | null {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = [value?.code, value?.cause?.code].find(item => typeof item === "string" && TRANSIENT.has(item));
  return typeof code === "string" ? code : null;
}
/** Retries counted since the last take (the runner prints them at each stage's end). */
export const networkRetries = { count: 0, take(): number { const taken = this.count; this.count = 0; return taken; } };
/** One request, repeated after a transient transport failure up to four tries in all, 1, 3 and 9 s apart, when repeating is
 * safe: a read always; a write only when it never left (a connect-phase failure) or carries its own Idempotency-Key. */
export async function withNetworkRetry<T>(work: () => Promise<T>, safe: (code: string) => boolean, sleep: (ms: number) => Promise<void> = liveClock.sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); } catch (error) {
      const code = networkCode(error), wait = NETWORK_RETRY_MS[attempt];
      if (!code || wait === undefined || !safe(code)) throw error;
      networkRetries.count++;
      await sleep(wait);
    }
  }
}
const repeatable = (method: string, headers: Record<string, string>) => (code: string) =>
  method === "GET" || method === "HEAD" || NEVER_SENT.has(code) || Object.keys(headers).some(name => name.toLowerCase() === "idempotency-key");
export const ALPHA_TARGET: RehearsalTarget = Object.freeze({ kind: "alpha", origin: ALPHA_PROBE_ORIGIN, channel: "alpha" });

/** A release identity of the target's own channel: ready, not in maintenance, its cloud healthy. Alpha's check is gate0's. */
export function targetIdentity(target: RehearsalTarget, value: unknown): { sourceSha: string; workerSha256: string } {
  if (target.kind === "alpha") return alphaProbeIdentity(value);
  // A Dev stack is never "ready" by the route's own rule (release-identity.ts: ready needs a deployed source sha, which only
  // a hosted deploy has), so it answers 503 with ready false and no source sha. What it can show is checked instead: its
  // own channel, no maintenance, every migration applied (head = expected head), its cloud on, and a pinned worker.
  const checked = z.object({ channel: z.literal(target.channel), maintenance: z.literal(false),
    migrations: z.object({ state: z.literal("current"), head: z.string().min(1), expectedHead: z.string().min(1) }).passthrough(),
    cloud: z.object({ enabled: z.literal(true) }).passthrough(),
    worker: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).passthrough() }).passthrough().safeParse(value);
  if (!checked.success || checked.data.migrations.head !== checked.data.migrations.expectedHead) throw new RehearsalFailure("release_identity", "not_ready");
  return { sourceSha: "local", workerSha256: checked.data.worker.sha256 };
}

export async function liveRelease(fetchImpl: typeof fetch = fetch, target: RehearsalTarget = ALPHA_TARGET): Promise<boolean> {
  return await liveReleaseIdentity(fetchImpl, target) !== null;
}

/** The target's release identity (its channel, ready, not in maintenance), or null. */
export async function liveReleaseIdentity(fetchImpl: typeof fetch = fetch, target: RehearsalTarget = ALPHA_TARGET): Promise<{ sourceSha: string; workerSha256: string } | null> {
  try {
    const response = await withNetworkRetry(() => fetchImpl(`${target.loopback ?? target.origin}/v1/release-identity`, { redirect: "error", signal: AbortSignal.timeout(15_000) }),
      () => true);
    // A Dev stack answers its identity with 503 (never "ready"; targetIdentity checks what it can show).
    if (!response.ok && !(target.kind === "local" && response.status === 503)) { await response.body?.cancel(); return null; }
    return targetIdentity(target, await response.json());
  } catch { return null; }
}

/** The active runtime's admission record, read-only, from the rehearsal's R2 bucket: found only when that bucket is Alpha's
 * runtime store (where checkpoints live too). */
export async function liveRuntimeQualification(store: { bucket: string; endpoint: string; accessKeyId: string; secretAccessKey: string }, sha256: string):
  Promise<{ found: boolean; actingUser: boolean; syncContext: boolean }> {
  const record = await readRuntimeCapabilities(sha256, store);
  return { found: !!record, actingUser: !!record?.features.includes("acting-user-v1"), syncContext: !!record?.features.includes("sync-context-v1") };
}

export function liveApi(accessToken: () => Promise<string>, fetchImpl: typeof fetch = fetch, target: RehearsalTarget = ALPHA_TARGET,
  sleep: (ms: number) => Promise<void> = liveClock.sleep): Api {
  return {
    async json(method, path, body, headers = {}) {
      if (!path.startsWith("/v1/")) throw new RehearsalFailure("api", "path");
      const send = async () => {
        const response = await fetchImpl(`${target.loopback ?? target.origin}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json", ...headers },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        // The body is part of the read: a reset while it streams is the same transport failure.
        return { response, raw: await response.text() };
      };
      const { response, raw } = await withNetworkRetry(send, repeatable(method, headers), sleep);
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
      return { status: response.status, body: parsed };
    },
  };
}

/** The socket a bridge rides on, as liveBridge needs it (BridgeProbe in production; a fake in tests). */
export type BridgeSocket = { readyState: number; on(event: "close", listener: (code: number) => void): unknown; on(event: "ping", listener: () => void): unknown };
export type OpenedProbe = Pick<BridgeProbe, "op" | "request" | "send" | "frames" | "close"> & { socket: BridgeSocket };
const SOCKET_OPEN = 1;
/** Closes after which the desktop reconnects at once (runtime-client.ts onclose: a ready socket that did not end normally,
 * was not refused and was not a relay's retry-later); any other close is a failure, named. */
const REOPENED_CLOSES = new Set([1001, 1006, 1011, 1012]);
const MAX_REOPENS = 3;

/** gate0's bridge client, opened with a connect ticket validated as gate0 validates it. As the desktop's: after an
 * abnormal close of a ready socket the next request reconnects (a fresh connect ticket, a new socket), at most three times
 * per bridge; a request a close interrupted is never resent. A close is named by its code, how long the socket had been
 * open, and how many relay pings it had answered (bridge_closed_1006:open_25s:pings_0). */
export function liveBridge(api: Api, timeoutMs = 600_000, pollMs = 1_000,
  openProbe: (ticket: { url: string; protocols: string[] }) => Promise<OpenedProbe> = ticket => BridgeProbe.open(ticket, timeoutMs, pollMs),
  options: { loopback?: string; sleep?: (ms: number) => Promise<void> } = {}): (workspaceId: string) => Promise<Bridge> {
  return async workspaceId => {
    // The ticket request and the socket open are both safe to repeat: a new ticket, a new socket, nothing done yet.
    const connect = async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await connectOnce(); } catch (error) {
          const wait = NETWORK_RETRY_MS[attempt];
          const transient = error instanceof RehearsalFailure && (error.step === "bridge_open" || /^network/.test(error.code));
          if (!transient || wait === undefined) throw error;
          networkRetries.count++;
          await (options.sleep ?? liveClock.sleep)(wait);
        }
      }
    };
    const connectOnce = async () => {
      const reply = await connectWorkspace(api, workspaceId, "connect");
      const ticket = z.object({ url: z.string().url(), protocols: z.array(z.string()).length(2) }).safeParse(reply.body);
      if (!ticket.success) throw new RehearsalFailure("connect", "schema");
      const target = new URL(ticket.data.url);
      if (target.protocol !== "wss:" || target.username || target.password || target.search || target.hash ||
        ticket.data.protocols[0] !== "zeros.cloud.v2" || !ticket.data.protocols[1]?.startsWith("ticket.")) throw new RehearsalFailure("connect", "ticket");
      // --local: the same path on this stack's own loopback port (the relay serves it on the API's port), never another.
      const url = options.loopback ? `${options.loopback.replace(/^http/, "ws")}${target.pathname}` : ticket.data.url;
      const probe = await wrap("bridge_open", () => openProbe({ url, protocols: ticket.data.protocols }));
      const life = { openedAt: Date.now(), closedAt: null as number | null, code: null as number | null, pings: 0 };
      probe.socket.on("ping", () => { life.pings++; });
      probe.socket.on("close", code => { life.code = code; life.closedAt = Date.now(); });
      return { probe, life };
    };
    let current = await connect(), reopens = 0;
    const closed = () => current.life.code === null ? null
      : `bridge_closed_${current.life.code}:open_${Math.round(((current.life.closedAt ?? Date.now()) - current.life.openedAt) / 1000)}s:pings_${current.life.pings}`;
    const usable = async (step: string) => {
      if (current.probe.socket.readyState === SOCKET_OPEN) return current.probe;
      if (current.life.code !== null && REOPENED_CLOSES.has(current.life.code) && reopens < MAX_REOPENS) {
        reopens++; current.probe.close(); current = await connect(); return current.probe;
      }
      throw new RehearsalFailure(clean(step), closed() ?? "bridge_disconnected");
    };
    const named = async <T>(step: string, work: (probe: OpenedProbe) => Promise<T>): Promise<T> => {
      const probe = await usable(step);
      try { return await work(probe); }
      catch (error) {
        // Closed while the request was out: named by the close, and not resent (it may have run).
        const why = probe === current.probe ? closed() : null;
        if (why) throw new RehearsalFailure(clean(step), why);
        throw error;
      }
    };
    return {
      op: (op, params) => named(op, probe => wrap(op, () => probe.op(op, params))),
      request: (type, fields, step) => named(step, probe => wrap(step, () => probe.request(type, fields, step))),
      send: (type, fields) => {
        if (current.probe.socket.readyState !== SOCKET_OPEN) throw new RehearsalFailure("bridge_send", closed() ?? "disconnected");
        try { return current.probe.send(type, fields); } catch { throw new RehearsalFailure("bridge_send", closed() ?? "disconnected"); }
      },
      frames: () => current.probe.frames,
      close: () => current.probe.close(),
    };
  };
}
const clean = (step: string) => step.slice(0, 64).replace(/[^a-z0-9_.:-]/gi, "_").toLowerCase();
async function wrap<T>(step: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    throw error instanceof Gate0Failure ? new RehearsalFailure(step.slice(0, 64).replace(/[^a-z0-9_.:-]/gi, "_").toLowerCase(), error.cause ?? "bridge")
      : new RehearsalFailure(step.slice(0, 64).replace(/[^a-z0-9_.:-]/gi, "_").toLowerCase(), "bridge");
  }
}

const RawSnapshot = z.object({ sandbox: z.object({
  createdAt: z.string().max(64).nullable().optional().catch(null), stoppedAt: z.string().max(64).nullable().optional().catch(null),
  hydrated: z.boolean().nullable().optional().catch(null), lastSnapshotStatus: z.string().max(32).nullable().optional().catch(null),
  lastSnapshotAttemptAt: z.string().max(64).nullable().optional().catch(null), snapshotCompletedAt: z.string().max(64).nullable().optional().catch(null),
}).passthrough() }).passthrough();

export function liveBoat(input: { apiKey: string; billingOrg?: string }): Boat {
  const client = new BoatApiClient({ apiKey: input.apiKey, timeoutMs: 20_000, ...(input.billingOrg ? { billingOrg: input.billingOrg } : {}) });
  const compute = new BoatCloudV2Compute(client);
  return {
    async snapshot(machineId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(machineId)) throw new RehearsalFailure("boat_snapshot_read", "machine_id");
      try {
        const { sandbox } = RawSnapshot.parse(await client.request(`/sandboxes/${machineId}`, { method: "GET" }));
        return { createdAt: sandbox.createdAt ?? null, stoppedAt: sandbox.stoppedAt ?? null, hydrated: sandbox.hydrated ?? null,
          lastSnapshotStatus: sandbox.lastSnapshotStatus ?? null, lastSnapshotAttemptAt: sandbox.lastSnapshotAttemptAt ?? null,
          snapshotCompletedAt: sandbox.snapshotCompletedAt ?? null };
      } catch (error) {
        if ((error as { code?: unknown }).code === "provider_not_found") return null;
        throw new RehearsalFailure("boat_snapshot_read", String((error as { code?: unknown }).code ?? "failed"));
      }
    },
    async inspect(machineId) {
      try { const row = await compute.inspect(machineId); return { name: row.name, state: row.state }; } catch (error) {
        if ((error as { code?: unknown }).code === "provider_not_found") return null;
        throw new RehearsalFailure("boat_inspect", String((error as { code?: unknown }).code ?? "failed"));
      }
    },
    async delete(machineId) {
      try { await compute.delete(machineId); } catch (error) { throw new RehearsalFailure("boat_delete", String((error as { code?: unknown }).code ?? "failed")); }
    },
    async snapshotExists(name) {
      try { return await compute.snapshotExists(name); } catch { throw new RehearsalFailure("boat_snapshot", "failed"); }
    },
    async deleteSnapshot(name) {
      try { await compute.deleteSnapshot(name); } catch (error) { throw new RehearsalFailure("boat_snapshot_delete", String((error as { code?: unknown }).code ?? "failed")); }
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

type GithubRequest = (method: string, path: string, token: string, body?: unknown) => Promise<{ status: number; body: unknown }>;
const githubRequest = (fetchImpl: typeof fetch): GithubRequest => async (method, path, token, body) => {
  const response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28",
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const raw = await response.text();
  let parsed: unknown = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = null; }
  return { status: response.status, body: parsed };
};

/** The fixture repositories through one identity: `tokenFor` answers the token for a repository and an access level. The
 * rehearsal reads and cleans up only: it never creates, renames or deletes a repository. */
function githubPort(request: GithubRequest, owner: string, tokenFor: (repository: string, access: "read" | "write") => Promise<string>): Github {
  const checked = (repository: string) => {
    const name = assertRepository(repository);
    if (name.split("/")[0]!.toLowerCase() !== owner.toLowerCase()) throw new RehearsalFailure("repository_refused", "owner");
    return name;
  };
  const ok = (status: number, step: string, allowed: number[]) => { if (!allowed.includes(status)) throw new RehearsalFailure(step, `http_${status}`); };
  const write = (repository: string) => tokenFor(checked(repository), "write");
  return {
    async repositoryExists(repository) {
      try { return (await request("GET", `/repos/${checked(repository)}`, await tokenFor(checked(repository), "read"))).status === 200; }
      catch (error) { if (error instanceof RehearsalFailure && error.step === "github_token") return false; throw error; }
    },
    async defaultHead(repository) {
      const token = await tokenFor(checked(repository), "read");
      const repo = await request("GET", `/repos/${checked(repository)}`, token);
      const branch = z.object({ default_branch: z.string().min(1) }).passthrough().safeParse(repo.body);
      if (repo.status !== 200 || !branch.success) return null;
      const head = await request("GET", `/repos/${checked(repository)}/commits/${branch.data.default_branch.split("/").map(encodeURIComponent).join("/")}`, token);
      const sha = z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) }).passthrough().safeParse(head.body);
      return head.status === 200 && sha.success ? sha.data.sha : null;
    },
    async branches(repository, prefix) {
      const reply = await request("GET", `/repos/${checked(repository)}/git/matching-refs/heads/${encodeURIComponent(prefix)}`, await write(repository));
      ok(reply.status, "github_branches", [200]);
      const refs = z.array(z.object({ ref: z.string() }).passthrough()).safeParse(reply.body);
      return refs.success ? refs.data.map(row => row.ref.replace(/^refs\/heads\//, "")).filter(branch => prefixed(prefix, branch)) : [];
    },
    async deleteBranch(repository, branch) {
      if (!/^zr-[0-9a-f]{8}-/.test(branch)) throw new RehearsalFailure("branch_refused", "unprefixed");
      const reply = await request("DELETE", `/repos/${checked(repository)}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, await write(repository));
      ok(reply.status, "branch_delete", [204, 404, 422]);
    },
    async openPulls(repository, prefix) {
      const reply = await request("GET", `/repos/${checked(repository)}/pulls?state=open&per_page=100`, await write(repository));
      ok(reply.status, "github_pulls", [200]);
      const rows = z.array(z.object({ number: z.number(), head: z.object({ ref: z.string() }) }).passthrough()).safeParse(reply.body);
      return rows.success ? rows.data.filter(row => prefixed(prefix, row.head.ref)).map(row => row.number) : [];
    },
    async ignores(repository, path) {
      const reply = await request("GET", `/repos/${checked(repository)}/contents/.gitignore`, await tokenFor(checked(repository), "read"));
      if (reply.status === 404) return false;
      ok(reply.status, "github_gitignore", [200]);
      const file = z.object({ content: z.string(), encoding: z.literal("base64") }).passthrough().safeParse(reply.body);
      if (!file.success) return false;
      const rules = new Set([path, `/${path}`, `${path}*`, `*${path.slice(path.lastIndexOf("."))}`]);
      return Buffer.from(file.data.content, "base64").toString("utf8").split(/\r?\n/).some(line => rules.has(line.trim()));
    },
    async closePull(repository, number) {
      const read = await request("GET", `/repos/${checked(repository)}/pulls/${number}`, await write(repository));
      const head = z.object({ head: z.object({ ref: z.string() }) }).passthrough().safeParse(read.body);
      if (!head.success || !/^zr-[0-9a-f]{8}-/.test(head.data.head.ref)) throw new RehearsalFailure("pull_refused", "unprefixed");
      ok((await request("PATCH", `/repos/${checked(repository)}/pulls/${number}`, await write(repository), { state: "closed" })).status, "pull_close", [200]);
    },
  };
}

/** The fixtures through the Alpha GitHub App on the owner's installation, with tokens scoped to one repository each. Works
 * only for repositories the App's installation selects. */
export function liveGithub(input: { appId: number; privateKey: string; owner: string }, fetchImpl: typeof fetch = fetch): Github {
  const request = githubRequest(fetchImpl);
  const config = { appId: input.appId, privateKey: input.privateKey } as GithubBackendConfig;
  let installation: number | undefined;
  const tokens = new Map<string, { token: string; until: number }>();
  const installationId = async () => {
    if (installation) return installation;
    const listed = await request("GET", "/app/installations?per_page=100", createGithubAppJwt(config));
    const rows = z.array(z.object({ id: z.number(), account: z.object({ login: z.string() }).nullable() }).passthrough()).safeParse(listed.body);
    const found = rows.success ? rows.data.find(row => row.account?.login.toLowerCase() === input.owner.toLowerCase()) : undefined;
    if (!found) throw new RehearsalFailure("github_installation", `http_${listed.status}`);
    return installation = found.id;
  };
  return githubPort(request, input.owner, async (repository, access) => {
    const permissions = access === "write" ? { metadata: "read", contents: "write", pull_requests: "write" } : { metadata: "read", contents: "read" };
    const key = `${repository}|${access}`, cached = tokens.get(key);
    if (cached && cached.until > Date.now()) return cached.token;
    const minted = await request("POST", `/app/installations/${await installationId()}/access_tokens`, createGithubAppJwt(config),
      { repositories: [repository.split("/")[1]], permissions });
    const body = z.object({ token: z.string().min(1) }).passthrough().safeParse(minted.body);
    if (minted.status !== 201 || !body.success) throw new RehearsalFailure("github_token", `http_${minted.status}`);
    tokens.set(key, { token: body.data.token, until: Date.now() + 40 * 60_000 });
    return body.data.token;
  });
}

/** The fixtures through ZEROS_REHEARSAL_GITHUB_TOKEN, the same token the test user's sign-in uses: no dependence on the
 * App's selected repositories. */
export function liveGithubToken(token: string, owner: string, fetchImpl: typeof fetch = fetch): Github {
  return githubPort(githubRequest(fetchImpl), owner, async () => token);
}

export type TokenCheck = {
  /** fine_grained (github_pat_), classic (ghp_) or other: only the kind, never the value. */
  kind: "fine_grained" | "classic" | "other";
  /** Every repository the token lists (GitHub's /user/repos as the token), with whether it is private. A fine-grained token
   * lists public repositories it can merely read, as anyone can: those are probed for write, not refused for being listed. */
  reachable: { repository: string; private: boolean }[];
  /** Per fixture: reachable, and whether the token may write contents and pull requests. */
  fixtures: WriteProbe[];
  /** Per public repository outside the fixtures: the same two write probes (both must be refused). Private ones are not probed. */
  outside: WriteProbe[];
};
export type WriteProbe = { repository: string; reachable: boolean; contentsWrite: boolean; pullRequestsWrite: boolean };
/** At most this many public repositories outside the fixtures are probed; more refuses the token as too broad to check. */
export const OUTSIDE_PROBE_LIMIT = 50;

/** Write access probed with requests GitHub refuses on validation (a ref to the all-zero commit, a pull request from a branch
 * that does not exist): 422 is the permission there, 403 or 404 the permission refusing it. Neither changes anything. */
async function probeWrite(request: GithubRequest, token: string, repository: string): Promise<WriteProbe> {
  if ((await request("GET", `/repos/${repository}`, token)).status !== 200) return { repository, reachable: false, contentsWrite: false, pullRequestsWrite: false };
  const ref = await request("POST", `/repos/${repository}/git/refs`, token, { ref: "refs/heads/zr-token-check", sha: "0".repeat(40) });
  const pull = await request("POST", `/repos/${repository}/pulls`, token, { title: "zr-token-check", head: "zr-token-check-absent", base: "main" });
  return { repository, reachable: true, contentsWrite: ref.status === 422, pullRequestsWrite: pull.status === 422 };
}

/** Verifies the token without printing it: its kind, everything it lists, its write access on each fixture, and that it can
 * write nothing outside them. */
export async function checkGithubToken(token: string, fixtures: readonly string[], fetchImpl: typeof fetch = fetch): Promise<TokenCheck> {
  const request = githubRequest(fetchImpl);
  const kind = token.startsWith("github_pat_") ? "fine_grained" : token.startsWith("ghp_") ? "classic" : "other";
  const reachable: TokenCheck["reachable"] = [];
  for (let page = 1; page <= 10; page++) {
    const reply = await request("GET", `/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`, token);
    if (reply.status !== 200) throw new RehearsalFailure("github_token_repositories", `http_${reply.status}`);
    const rows = z.array(z.object({ full_name: z.string().max(201), private: z.boolean() }).passthrough()).safeParse(reply.body);
    if (!rows.success) throw new RehearsalFailure("github_token_repositories", "schema");
    reachable.push(...rows.data.map(row => ({ repository: row.full_name, private: row.private })));
    if (rows.data.length < 100) break;
  }
  const fixtureSet = new Set(fixtures.map(name => name.toLowerCase()));
  const fixtureProbes: WriteProbe[] = [];
  for (const repository of fixtures.map(assertRepository)) fixtureProbes.push(await probeWrite(request, token, repository));
  const publicOutside = reachable.filter(row => !fixtureSet.has(row.repository.toLowerCase()) && !row.private);
  if (publicOutside.length > OUTSIDE_PROBE_LIMIT) throw new RehearsalFailure("github_token", "too_broad_to_check");
  const outside: WriteProbe[] = [];
  for (const row of publicOutside) outside.push(await probeWrite(request, token, row.repository));
  return { kind, reachable, fixtures: fixtureProbes, outside };
}

/** Why a token check refuses, or null: a classic token, a private repository outside the fixtures, write on any public one
 * outside them, or a fixture it cannot reach or write. */
export function tokenRefusal(check: TokenCheck, fixtures: readonly string[]): string | null {
  if (check.kind !== "fine_grained") return `kind_${check.kind}`;
  const allowed = new Set(fixtures.map(name => name.toLowerCase()));
  if (check.reachable.some(row => row.private && !allowed.has(row.repository.toLowerCase()))) return "reaches_private_outside_fixtures";
  if (check.outside.some(row => row.contentsWrite || row.pullRequestsWrite)) return "writes_outside_fixtures";
  const missing = check.fixtures.find(row => !row.reachable || !row.contentsWrite || !row.pullRequestsWrite);
  return missing ? `fixture_${!missing.reachable ? "unreachable" : !missing.contentsWrite ? "contents_read_only" : "pull_requests_read_only"}` : null;
}

/** The token check as printed lines: counts and the few names that matter, never the token. */
export function tokenLines(check: TokenCheck, fixtures: readonly string[]): string[] {
  const allowed = new Set(fixtures.map(name => name.toLowerCase()));
  const privateOutside = check.reachable.filter(row => row.private && !allowed.has(row.repository.toLowerCase())).map(row => row.repository);
  const writable = check.outside.filter(row => row.contentsWrite || row.pullRequestsWrite).map(row => row.repository);
  const readOnly = check.outside.filter(row => !row.contentsWrite && !row.pullRequestsWrite).map(row => row.repository);
  const few = (names: string[]) => names.length ? `: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}` : "";
  return [
    `github token: kind ${check.kind}; lists ${check.reachable.length} repositories: ${check.fixtures.filter(row => row.reachable).length} fixtures, ` +
      `${privateOutside.length} private outside the fixtures${privateOutside.length ? `: ${privateOutside.join(", ")}` : ""}, ${check.outside.length} public outside`,
    ...check.fixtures.map(row => `  github token on ${row.repository}: ${row.reachable ? "reachable" : "unreachable"}, contents write ${row.contentsWrite ? "yes" : "no"},` +
      ` pull requests write ${row.pullRequestsWrite ? "yes" : "no"}`),
    `  public outside the fixtures, read only (both write probes refused): ${readOnly.length}${few(readOnly)}`,
    ...(writable.length ? [`  public outside the fixtures it can write: ${writable.join(", ")}`] : []),
    "  write probes are requests GitHub refuses on validation (a ref to the all-zero commit, a pull request from an absent branch): nothing changes",
  ];
}

/** A database refusal by closed values only: `sqlstate_<SQLSTATE>`, then the constraint's name, or the message when it is
 * a bare identifier as the entitlement triggers raise (`cloud_creator_ineligible`, `seat refresh scope changed`), spaces
 * as underscores. Null when the error carries no SQLSTATE; a message that is anything else is never printed. */
export function databaseRefusal(error: unknown): string | null {
  const value = error as { code?: unknown; constraint?: unknown; message?: unknown } | null;
  if (typeof value?.code !== "string" || !/^[0-9A-Z]{5}$/.test(value.code)) return null;
  const detail = typeof value.constraint === "string" && /^[a-z0-9_]{1,63}$/.test(value.constraint) ? value.constraint
    : typeof value.message === "string" && /^[a-z_ ]{1,64}$/.test(value.message) ? value.message.replace(/ /g, "_") : null;
  return `sqlstate_${value.code}${detail ? `:${detail}` : ""}`;
}

/** A database failure's closed class: its SQLSTATE (five characters, never the message), or "connection" when it has none. */
export function databaseErrorCode(error: unknown): string {
  const state = (error as { code?: unknown } | null)?.code;
  if (typeof state !== "string" || !/^[0-9A-Z]{5}$/.test(state)) return "connection";
  return state.startsWith("08") || state === "57P01" ? "connection" : `sqlstate_${state}`;
}

/** Sets app.system for the rest of the transaction, as its own statement before any read (the RLS policies' app_is_system()).
 * Never inside the read itself: a CTE that sets it does not order the read after it unless the read depends on it, so a
 * single-statement wrapper can read with the policy closed and see no rows, silently and depending on the plan. */
export const SET_APP_SYSTEM = "SELECT set_config('app.system','on',true)";

export type DatabaseClient = { connect(): Promise<unknown>; query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>; on?(event: "error", listener: (error: unknown) => void): unknown };
/** A connection the server ends under us (57P01 at a restart, a dropped socket) emits "error" while idle: with no listener
 * that would crash the process. It is taken here and the connection is marked ended; the next query on it fails named
 * (`database connection`), and a reader is opened afresh for the next read. */
function onEnded(held: { on?(event: "error", listener: (error: unknown) => void): unknown }, ended: () => void): void {
  held.on?.("error", () => ended());
}
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

/** Waits before each retry of a role PlanetScale's API refused with 429 or 5xx. */
export const ROLE_RETRY_MS = [2_000, 5_000, 15_000] as const;

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
    // PlanetScale's API answering 429 or 5xx is retried, bounded, each time under a new name. A role a lost reply might
    // still have made needs nothing: it has no password anyone holds, and its TTL (3600 s) removes it.
    let created = await planetScale("POST", `${path}/roles`, { name: input.roleName(kind), inherited_roles: [kind === "read" ? "pg_read_all_data" : "postgres"], ttl: 3600 });
    for (const wait of ROLE_RETRY_MS) {
      if (created.status !== 429 && created.status < 500) break;
      await sleep(wait);
      created = await planetScale("POST", `${path}/roles`, { name: input.roleName(kind), inherited_roles: [kind === "read" ? "pg_read_all_data" : "postgres"], ttl: 3600 });
    }
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
    // Its role is still removed at close; a query on the ended connection fails named.
    onEnded(held, () => undefined);
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
    catch (error) { throw new RehearsalFailure("database", databaseErrorCode(error)); }
  };
  let reader: Promise<Awaited<ReturnType<typeof mint>>> | undefined;
  return {
    async read(text, values) {
      for (let attempt = 0; ; attempt++) {
        const opened = reader ??= mint("read").catch(error => { reader = undefined; throw error; });
        const current = await opened, run = query(current.held);
        try {
          await run("BEGIN READ ONLY");
          try {
            await run(SET_APP_SYSTEM);
            const rows = (await run(text, values)).rows;
            await run("COMMIT");
            return rows;
          } catch (error) { await current.held.query("ROLLBACK").catch(() => undefined); throw error; }
        } catch (error) {
          // A dropped connection (the read role idles through the sign-ins) is replaced once: its role deleted, a new one minted.
          if (attempt > 0 || !(error instanceof RehearsalFailure && error.code === "connection")) throw error;
          if (reader === opened) reader = undefined;
          await current.remove().catch(() => undefined);
        }
      }
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
      onEnded(pool, () => undefined);
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
/** The Dev stack's own PostgreSQL, directly: no provider role is minted. Reads go through the stack's runtime login in the
 * same RLS-safe form as Alpha's (READ ONLY, `set_config('app.system','on',true)` as its own statement, then the read);
 * a write (a clock shift) and the Pro operator run as the stack's migration login, which owns the tables, as Alpha's
 * operator roles do. */
export function localDatabase(input: { readUrl: string; ownerUrl: string; client?: (connectionString: string) => DatabaseClient;
  pool?: (connectionString: string) => pg.Pool }): LiveDatabase {
  const client = input.client ?? (connectionString => new pg.Client({ connectionString, connectionTimeoutMillis: 15_000 }));
  const run = (held: DatabaseClient) => async (text: string, values?: unknown[]) => {
    try { const result = await held.query(text, values); return { rows: result.rows, rowCount: result.rowCount ?? 0 }; }
    catch (error) { throw new RehearsalFailure("database", databaseErrorCode(error)); }
  };
  let reader: Promise<DatabaseClient> | undefined;
  const ended = new WeakSet<DatabaseClient>();
  const open = async (url: string) => {
    const held = client(url);
    onEnded(held, () => { ended.add(held); void held.end().catch(() => undefined); });
    try { await held.connect(); } catch (error) { throw new RehearsalFailure("database", databaseErrorCode(error)); }
    return held;
  };
  return {
    async read(text, values) {
      const reading = () => reader ??= open(input.readUrl).catch(error => { reader = undefined; throw error; });
      let held = await reading();
      // The server ended the reader (a restart): this read opens a new one.
      if (ended.has(held)) { reader = undefined; held = await reading(); }
      const query = run(held);
      await query("BEGIN READ ONLY");
      try {
        await query(SET_APP_SYSTEM);
        const rows = (await query(text, values)).rows;
        await query("COMMIT");
        return rows;
      } catch (error) { await held.query("ROLLBACK").catch(() => undefined); throw error; }
    },
    async transaction(work) {
      const held = await open(input.ownerUrl), query = run(held);
      try {
        await query("BEGIN");
        try {
          await query(SET_APP_SYSTEM);
          const result = await work(query);
          await query("COMMIT");
          return result;
        } catch (error) { await held.query("ROLLBACK").catch(() => undefined); throw error; }
      } finally { await held.end().catch(() => undefined); }
    },
    async asTableOwner(table, work) {
      if (!/^public\.[a-z_]{1,63}$/.test(table)) throw new RehearsalFailure("database_owner", "table");
      const pool = (input.pool ?? (url => new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 15_000 })))(input.ownerUrl);
      onEnded(pool, () => undefined);
      try {
        const owner = (await pool.query<{ owner: boolean }>("SELECT pg_get_userbyid(relowner) = current_user AS owner FROM pg_class WHERE oid = $1::regclass", [table])).rows[0];
        if (owner?.owner !== true) throw new RehearsalFailure("database_owner", "not_owner");
        return await work(pool, input.ownerUrl);
      } catch (error) {
        throw error instanceof RehearsalFailure ? error : new RehearsalFailure("database_owner", "failed");
      } finally { await pool.end().catch(() => undefined); }
    },
    async close() {
      const held = reader; reader = undefined;
      if (held) await (await held.catch(() => undefined))?.end().catch(() => undefined);
    },
  };
}

/** --local: a non-personal organization owned by the account, in the Dev stack's own database (a platform owner must own one,
 * and a fresh stack's accounts have only their Personal organization). Named with the run's prefix; kept afterwards, as
 * the staff role's audit refers to it. */
export async function localStaffOrganization(database: LiveDatabase, input: { userId: string; prefix: string }): Promise<string> {
  const id = randomUUID(), slug = `${input.prefix}staff`;
  await database.transaction(async query => {
    await query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1::uuid, $2, $3, $4::uuid, false, false)",
      [id, slug, slug, input.userId]);
    await query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'owner')", [id, input.userId]);
  });
  return id;
}

/** --local: an account's staff role on the Dev stack, through the staff operator (manage-staff.ts) as the launcher's own seed
 * uses it, as the table owner, on the development channel; the account is its own actor (an active user) and owns the
 * organization named. Returns the role it had. */
export async function localStaffRole(database: LiveDatabase, input: { userId: string; email: string; organizationId: string },
  nextRole: "platform_owner" | "developer" | "support_admin" | "none"): Promise<"platform_owner" | "developer" | "support_admin" | null> {
  return database.asTableOwner("public.users", async (pool, databaseUrl) => {
    const base = { databaseUrl, channel: "development", subjectUserId: input.userId, expectedEmail: input.email, actorUserId: input.userId,
      nextRole, ownerOrganizationId: input.organizationId, reason: "Zeros rehearsal on this checkout's Dev stack: the Pro operator's actor" };
    try {
      const plan = await manageStaffRole(pool, validateStaffRoleRequest({ ...base, execute: false }));
      if (plan.state !== "unchanged") await manageStaffRole(pool, validateStaffRoleRequest({ ...base, execute: true, approval: plan.approval ?? undefined }));
      return (plan.previousRole ?? null) as "platform_owner" | "developer" | "support_admin" | null;
    } catch (error) { throw error instanceof RehearsalFailure ? error : new RehearsalFailure("staff_role", databaseRefusal(error) ?? "refused"); }
  });
}

export function livePro(database: LiveDatabase, input: { subjectUserId: string; expectedEmail: string; actorUserId: string },
  channel: RehearsalTarget["channel"] = "alpha"): ProPort {
  const read = async () => grantOf((await database.read(`SELECT status, cloud_workspaces_allowed, source, valid_from, valid_until
    FROM account_entitlements WHERE user_id = $1::uuid`, [input.subjectUserId]))[0] as Parameters<typeof grantOf>[0]);
  return {
    read,
    async change(grant, reason) {
      const operationId = randomUUID();
      const document = { operationId, channel, subjectUserId: input.subjectUserId, expectedEmail: input.expectedEmail, actorUserId: input.actorUserId,
        enabled: grant.enabled, validFrom: grant.validFrom, validUntil: grant.validUntil, reason };
      await database.asTableOwner("public.account_entitlements", async (pool, databaseUrl) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const planned = await manageAccountPro(pool, document, { databaseUrl, channel });
            await manageAccountPro(pool, document, { databaseUrl, channel, execute: true, approval: planned.planSha256 });
            return;
          } catch (error) {
            // The operator's messages are fixed text, never values; only the plan mismatch is retried.
            if (attempt === 0 && error instanceof Error && error.message.startsWith("Individual Pro plan changed")) continue;
            throw new RehearsalFailure("pro_change", error instanceof Error && /active platform owner/.test(error.message) ? "actor" :
              error instanceof Error && /overwrite billing/.test(error.message) ? "foreign_grant" : databaseRefusal(error) ?? "refused");
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

/** The rehearsal's agent credentials, from .env.agent by name, every one set (one per agent, in this order):
 * ZEROS_REHEARSAL_CLAUDE_SETUP_TOKEN (a `claude setup-token`), ZEROS_REHEARSAL_CLAUDE_API_KEY, ZEROS_REHEARSAL_OPENAI_API_KEY
 * (Codex by API key) and ZEROS_REHEARSAL_CURSOR_API_KEY: the forms Settings accepts by paste. A ChatGPT sign-in for Codex
 * is a native cache import, not a pasted value, so it is not taken. A malformed value fails by its variable's name only. */
export const AGENT_CREDENTIAL_SOURCES = [
  { name: "ZEROS_REHEARSAL_CLAUDE_SETUP_TOKEN", provider: "claude", kind: "claude-setup-token", field: "accessToken" },
  { name: "ZEROS_REHEARSAL_CLAUDE_API_KEY", provider: "claude", kind: "claude-api-key", field: "apiKey" },
  { name: "ZEROS_REHEARSAL_OPENAI_API_KEY", provider: "codex", kind: "codex-api-key", field: "apiKey" },
  { name: "ZEROS_REHEARSAL_CURSOR_API_KEY", provider: "cursor", kind: "cursor-api-key", field: "apiKey" },
] as const;
export function agentCredentialsFromEnv(env: NodeJS.ProcessEnv): AgentCredentialPort[] {
  const found: AgentCredentialPort[] = [];
  for (const source of AGENT_CREDENTIAL_SOURCES) {
    const value = env[source.name]?.trim();
    if (!value) continue;
    if (!/^[\x21-\x7e]{16,4096}$/.test(value)) throw new RehearsalFailure("agent_credential", `invalid:${source.name}`);
    // One per agent: Claude's setup token before its API key.
    if (found.some(entry => entry.provider === source.provider)) continue;
    found.push({ provider: source.provider, kind: source.kind, source: source.name, material: () => ({ kind: source.kind, [source.field]: value }) });
  }
  return found;
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
