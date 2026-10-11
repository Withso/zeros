// Loopback dev-server discovery for the Browser tab's start page.
//
// Discovery is scoped to one workspace folder: a listener is listed only when
// its process's working directory is inside that folder and not inside a
// nested folder owned by another registered workspace. lsof is therefore
// required; a port probe cannot tell which folder a server runs in.
//
// The renderer only receives `http://localhost:<port>` URLs plus display
// metadata. Every socket this module opens targets 127.0.0.1 or ::1; listeners
// bound to a specific non-loopback interface are ignored because a loopback
// request could not reach them anyway.

import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  ENGINE_BASE_PORT_ALPHA,
  ENGINE_BASE_PORT_BETA,
  ENGINE_BASE_PORT_DEV,
  ENGINE_BASE_PORT_PROD,
  ENGINE_PORT_SPAN,
} from "../../src/engine/runtime";

export interface LocalDevServer {
  port: number;
  url: string;
  title?: string;
  processName?: string;
  cwd?: string;
}

export interface LocalDevServersResult {
  /** The canonical scope root, which every `cwd` is inside. */
  root: string;
  servers: LocalDevServer[];
}

export interface ListeningSocket {
  pid: number | null;
  command: string | null;
  port: number;
  /** Bound addresses as reported by lsof, e.g. "127.0.0.1", "[::1]", "*". */
  hosts: string[];
}

/** Listeners whose working directory is looked up per discovery. */
export const MAX_LISTENERS = 256;
/** Workspace listeners probed over HTTP per discovery. */
export const MAX_CANDIDATES = 64;
export const MAX_SERVERS = 32;
export const MAX_SCOPE_EXCLUDES = 256;
const MAX_SCOPE_PATH_LENGTH = 4_096;
const LSOF_TIMEOUT_MS = 1_500;
const LSOF_MAX_BUFFER = 2 * 1024 * 1024;
const CWD_TIMEOUT_MS = 900;
const HTTP_TIMEOUT_MS = 700;
const HTTP_MAX_BYTES = 64 * 1024;
const TOTAL_BUDGET_MS = 2_500;
const PROBE_CONCURRENCY = 8;
const TITLE_MAX_LENGTH = 120;
const TEXT_MAX_LENGTH = 512;

export interface LocalDevServerScope {
  /** Canonical workspace folder. */
  root: string;
  /** Canonical folders of other registered workspaces nested inside `root`. */
  exclude: readonly string[];
}

const WILDCARD_HOSTS = new Set(["*", "0.0.0.0", "[::]", "::"]);
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
  "::1",
  "[::ffff:127.0.0.1]",
]);

/** macOS and desktop-app listeners that answer HTTP on loopback but are never
 * a project's dev server (AirPlay receiver, Continuity, app helpers). */
const SYSTEM_PROCESS_PATTERNS: readonly RegExp[] = [
  /^ControlCe/i,
  /^rapportd$/i,
  /^AirPlay/i,
  /^sharingd$/i,
  /^launchd$/i,
  /^mDNSRespo/i,
  /^identitys/i,
  /^remoted$/i,
  /^figma_age/i,
  /^Figma/i,
  /^Dropbox/i,
  /^Spotify/i,
  /^Slack/i,
  /^Discord/i,
  /^zoom/i,
  /^Raycast/i,
  /^Adobe/i,
  /^Creative/i,
  /^OneDrive/i,
  /^Google/i,
  /^Chrome/i,
  /^Code\b/i,
  /^Cursor/i,
  /^Zeros/i,
  /^Electron/i,
  /^logioptio/i,
  /^LogiPlugi/i,
  /^Microsoft/i,
  /^idea$/i,
  /^webstorm$/i,
  /^pycharm$/i,
];

/** Ephemeral ports are where OS services and app helpers park listeners; a
 * project server there must at least be a recognizable runtime. */
const EPHEMERAL_PORT_START = 49_152;
const DEV_RUNTIME_PATTERN =
  /^(node|bun|deno|python[\d.]*|ruby|php|java|dotnet|beam\.smp|go|uvicorn|gunicorn|hugo|caddy|next-serv|esbuild|vite|wrangler|workerd)$/i;

export function isLoopbackOrWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(host) || LOOPBACK_HOSTS.has(host);
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output. Only loopback and
 * wildcard binds survive; one socket per port (first owner wins). */
export function parseLsofListeners(output: string): ListeningSocket[] {
  const byPort = new Map<number, ListeningSocket>();
  let pid: number | null = null;
  let command: string | null = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === "p") {
      const parsed = Number.parseInt(value, 10);
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      command = null;
    } else if (field === "c") {
      command = value.slice(0, 64) || null;
    } else if (field === "n") {
      // A connected socket's name is "a->b"; LISTEN sockets have no peer.
      if (value.includes("->")) continue;
      const colon = value.lastIndexOf(":");
      if (colon <= 0) continue;
      const host = value.slice(0, colon);
      const port = Number(value.slice(colon + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
      if (!isLoopbackOrWildcardHost(host)) continue;
      const existing = byPort.get(port);
      if (existing) {
        if (!existing.hosts.includes(host)) existing.hosts.push(host);
        continue;
      }
      byPort.set(port, { pid, command, port, hosts: [host] });
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Parse `lsof -a -p <pids> -d cwd -Fpn` into pid → cwd. */
export function parseLsofCwd(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (!line) continue;
    if (line[0] === "p") {
      const parsed = Number.parseInt(line.slice(1), 10);
      pid = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line[0] === "n" && pid !== null && !result.has(pid)) {
      const path = sanitizeText(line.slice(1), TEXT_MAX_LENGTH);
      if (path.startsWith("/")) result.set(pid, path);
    }
  }
  return result;
}

export interface ExclusionRules {
  ports: ReadonlySet<number>;
  pids: ReadonlySet<number>;
}

/** Zeros's own listeners are excluded by exact PID or port only. Processes
 * spawned from Zeros terminals descend from the engine and must stay listed. */
export function filterCandidates(
  sockets: readonly ListeningSocket[],
  exclusions: ExclusionRules,
): ListeningSocket[] {
  const out: ListeningSocket[] = [];
  for (const socket of sockets) {
    if (socket.port < 1024) continue;
    if (exclusions.ports.has(socket.port)) continue;
    if (socket.pid !== null && exclusions.pids.has(socket.pid)) continue;
    const command = socket.command ?? "";
    if (command && SYSTEM_PROCESS_PATTERNS.some((pattern) => pattern.test(command)))
      continue;
    if (
      socket.port >= EPHEMERAL_PORT_START &&
      !DEV_RUNTIME_PATTERN.test(command)
    )
      continue;
    out.push(socket);
    if (out.length >= MAX_LISTENERS) break;
  }
  return out;
}

export function isPathWithinFolder(target: string, folder: string): boolean {
  if (folder === "/") return target.startsWith("/");
  return target === folder || target.startsWith(`${folder}/`);
}

/** A cwd belongs to the scope's workspace unless a more specific registered
 * workspace nested inside it owns that folder. */
export function cwdInScope(cwd: string | undefined, scope: LocalDevServerScope): boolean {
  if (!cwd || !isPathWithinFolder(cwd, scope.root)) return false;
  return !scope.exclude.some((nested) => isPathWithinFolder(cwd, nested));
}

function scopePath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_SCOPE_PATH_LENGTH) return null;
  if (!value.startsWith("/") || value.includes("\0")) return null;
  return value;
}

export type Realpath = (target: string) => Promise<string>;

async function canonicalFolder(raw: string, realpath: Realpath): Promise<string> {
  let resolved: string;
  try {
    // lsof reports kernel paths: /tmp is /private/tmp and case is canonical.
    resolved = await realpath(raw);
  } catch {
    resolved = path.posix.resolve(raw);
  }
  return resolved.length > 1 ? resolved.replace(/\/+$/, "") || "/" : resolved;
}

/** Validate a renderer scope and canonicalize it the way lsof reports cwds. */
export async function resolveLocalDevServerScope(
  args: Record<string, unknown>,
  realpath: Realpath = (target) => fs.promises.realpath(target),
): Promise<LocalDevServerScope> {
  const root = scopePath(args.root);
  const rawExclude = args.exclude ?? [];
  if (!root || !Array.isArray(rawExclude) || rawExclude.length > MAX_SCOPE_EXCLUDES)
    throw new Error("Invalid local server scope");
  const excluded = rawExclude.map(scopePath);
  if (excluded.some((value) => value === null)) throw new Error("Invalid local server scope");
  const realRoot = await canonicalFolder(root, realpath);
  // A root of "/" would admit every process on the Mac.
  if (realRoot === "/") throw new Error("Invalid local server scope");
  const nested = await Promise.all(
    (excluded as string[]).map((folder) => canonicalFolder(folder, realpath)),
  );
  return {
    root: realRoot,
    exclude: [
      ...new Set(
        nested.filter((folder) => folder !== realRoot && isPathWithinFolder(folder, realRoot)),
      ),
    ].sort(),
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  middot: "·",
  bull: "•",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

function sanitizeText(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1).trimEnd()}…` : cleaned;
}

/** Extract a display-safe `<title>` from the first bytes of an HTML page. */
export function extractHtmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match) return undefined;
  const inner = match[1].replace(/<[^>]*>/g, " ");
  const title = sanitizeText(decodeHtmlEntities(inner), TITLE_MAX_LENGTH);
  return title || undefined;
}

export interface HttpProbeResult {
  status: number;
  title?: string;
}

export type HttpProbe = (
  address: string,
  port: number,
  timeoutMs: number,
) => Promise<HttpProbeResult | null>;

function assertLoopbackAddress(address: string): void {
  if (address !== "127.0.0.1" && address !== "::1")
    throw new Error("Dev server probes are loopback-only");
}

/** One `GET /` without following redirects. Any HTTP status confirms the
 * listener speaks HTTP; the body is read only for an HTML title. */
export const probeHttp: HttpProbe = (address, port, timeoutMs) => {
  assertLoopbackAddress(address);
  return new Promise((resolve) => {
    let settled = false;
    let status: number | null = null;
    let body = "";
    let bytes = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      if (status === null) {
        resolve(null);
        return;
      }
      resolve({ status, title: body ? extractHtmlTitle(body) : undefined });
    };
    const request = http.request({
      host: address,
      family: address === "::1" ? 6 : 4,
      port,
      method: "GET",
      path: "/",
      agent: false,
      headers: {
        host: `localhost:${port}`,
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": "Zeros",
      },
    });
    const timer = setTimeout(finish, timeoutMs);
    request.on("response", (response) => {
      status = response.statusCode ?? 0;
      const type = String(response.headers["content-type"] ?? "");
      if (!/html/i.test(type)) {
        finish();
        return;
      }
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        body += chunk;
        if (bytes >= HTTP_MAX_BYTES || /<\/title\s*>/i.test(body)) finish();
      });
      response.on("end", finish);
      response.on("error", finish);
    });
    request.on("error", finish);
    request.end();
  });
};

export interface ExecResult {
  stdout: string;
  error: (Error & { code?: string | number | null; killed?: boolean }) | null;
}

export type ExecRunner = (
  file: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
) => Promise<ExecResult>;

const defaultExec: ExecRunner = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) => resolve({ stdout: String(stdout ?? ""), error }),
    );
  });

function resolveLsofPath(): string {
  for (const candidate of ["/usr/sbin/lsof", "/usr/bin/lsof"]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* fall through */
    }
  }
  return "lsof";
}

export interface ListDeps {
  platform: NodeJS.Platform;
  exec: ExecRunner;
  lsofPath: () => string;
  httpProbe: HttpProbe;
  now: () => number;
  exclusions: () => ExclusionRules;
}

/** lsof exits 1 both when nothing matches and on partial failures, so stdout
 * decides. A process killed by the timeout can end mid-record; its last
 * unterminated line is dropped so a truncated path or port is never used. */
async function runLsof(
  deps: ListDeps,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
): Promise<string> {
  const result = await deps.exec(deps.lsofPath(), args, options);
  let stdout = result.stdout;
  if (result.error?.killed && !stdout.endsWith("\n"))
    stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
  if (stdout.trim()) return stdout;
  if (!result.error || (result.error.code === 1 && !result.error.killed)) return "";
  throw new Error("Local server discovery is unavailable");
}

async function enumerateWithLsof(deps: ListDeps): Promise<ListeningSocket[]> {
  if (deps.platform === "win32") throw new Error("Local server discovery is unavailable");
  return parseLsofListeners(
    await runLsof(deps, ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], {
      timeoutMs: LSOF_TIMEOUT_MS,
      maxBuffer: LSOF_MAX_BUFFER,
    }),
  );
}

async function runPool<T>(
  items: readonly T[],
  limit: number,
  deadline: number,
  now: () => number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const worker = async () => {
    while (index < items.length && now() < deadline) {
      const item = items[index++];
      await task(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

function probeAddresses(socket: ListeningSocket): string[] {
  const v6Only = socket.hosts.every((host) => host === "[::1]" || host === "::1");
  const v4Only = socket.hosts.every((host) => host === "127.0.0.1" || host === "0.0.0.0");
  if (v6Only) return ["::1"];
  if (v4Only) return ["127.0.0.1"];
  return ["127.0.0.1", "::1"];
}

async function resolveCwds(
  deps: ListDeps,
  pids: number[],
  deadline: number,
): Promise<Map<number, string>> {
  if (pids.length === 0) return new Map();
  const remaining = deadline - deps.now();
  if (remaining <= 50) throw new Error("Local server discovery timed out");
  return parseLsofCwd(
    await runLsof(deps, ["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"], {
      timeoutMs: Math.min(CWD_TIMEOUT_MS, remaining),
      maxBuffer: 256 * 1024,
    }),
  );
}

/** HTTP listeners started inside `scope.root`. Working directories are
 * resolved before any probe, so servers of other folders are never contacted. */
export async function listLocalDevServers(
  deps: ListDeps,
  scope: LocalDevServerScope,
): Promise<LocalDevServersResult> {
  const deadline = deps.now() + TOTAL_BUDGET_MS;
  const listeners = filterCandidates(await enumerateWithLsof(deps), deps.exclusions());
  const pids = [
    ...new Set(
      listeners
        .map((socket) => socket.pid)
        .filter((pid): pid is number => pid !== null),
    ),
  ];
  const cwds = await resolveCwds(deps, pids, deadline);
  const candidates = listeners
    .filter((socket) => socket.pid !== null && cwdInScope(cwds.get(socket.pid), scope))
    .slice(0, MAX_CANDIDATES);

  const confirmed = new Map<number, { socket: ListeningSocket; title?: string }>();
  await runPool(candidates, PROBE_CONCURRENCY, deadline, deps.now, async (socket) => {
    for (const address of probeAddresses(socket)) {
      const remaining = deadline - deps.now();
      if (remaining <= 0) return;
      const response = await deps.httpProbe(
        address,
        socket.port,
        Math.min(HTTP_TIMEOUT_MS, remaining),
      );
      if (response) {
        confirmed.set(socket.port, { socket, title: response.title });
        return;
      }
    }
  });

  const rows = [...confirmed.values()]
    .sort((a, b) => a.socket.port - b.socket.port)
    .slice(0, MAX_SERVERS);
  return {
    root: scope.root,
    servers: rows.map(({ socket, title }) => {
      const server: LocalDevServer = {
        port: socket.port,
        url: `http://localhost:${socket.port}`,
      };
      if (title) server.title = title;
      const processName = socket.command
        ? sanitizeText(socket.command, 64)
        : "";
      if (processName) server.processName = processName;
      const cwd = socket.pid !== null ? cwds.get(socket.pid) : undefined;
      if (cwd) server.cwd = cwd;
      return server;
    }),
  };
}

export function defaultListDeps(
  exclusions: () => ExclusionRules,
): ListDeps {
  let lsofPath: string | null = null;
  return {
    platform: process.platform,
    exec: defaultExec,
    lsofPath: () => (lsofPath ??= resolveLsofPath()),
    httpProbe: probeHttp,
    now: () => Date.now(),
    exclusions,
  };
}

const RESULT_REUSE_MS = 1_000;
const MAX_CACHED_SCOPES = 8;

/** Shares one in-flight discovery per scope across windows and consumers and
 * reuses a just-finished result, so concurrent polls cannot stack lsof runs. */
export function createLocalDevServerLister(
  deps: ListDeps,
): (scope: LocalDevServerScope) => Promise<LocalDevServersResult> {
  const inflight = new Map<string, Promise<LocalDevServersResult>>();
  const last = new Map<string, { at: number; result: LocalDevServersResult }>();
  return (scope) => {
    const key = [scope.root, ...scope.exclude].join("\0");
    const running = inflight.get(key);
    if (running) return running;
    const cached = last.get(key);
    if (cached && deps.now() - cached.at < RESULT_REUSE_MS)
      return Promise.resolve(cached.result);
    const request = listLocalDevServers(deps, scope)
      .then((result) => {
        last.delete(key);
        last.set(key, { at: deps.now(), result });
        for (const stale of last.keys()) {
          if (last.size <= MAX_CACHED_SCOPES) break;
          last.delete(stale);
        }
        return result;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, request);
    return request;
  };
}

/** Zeros's own listeners: this main process (browser service, tunnels), the
 * engine process and its port blocks for every channel, and the renderer's
 * dev server. Children of the engine (user terminals) are not excluded. */
export function zerosListenerExclusions(input: {
  mainPid: number;
  enginePid: number | null;
  enginePort: number | null;
  engineBase: number;
  rendererDevUrl: string | null;
  vitePort: string | undefined;
}): ExclusionRules {
  const ports = new Set<number>();
  for (const base of [
    input.engineBase,
    ENGINE_BASE_PORT_PROD,
    ENGINE_BASE_PORT_BETA,
    ENGINE_BASE_PORT_ALPHA,
    ENGINE_BASE_PORT_DEV,
  ])
    for (let offset = 0; offset < ENGINE_PORT_SPAN; offset++)
      ports.add(base + offset);
  if (input.enginePort) ports.add(input.enginePort);
  const rendererPort = portFromOrigin(input.rendererDevUrl ?? undefined);
  if (rendererPort) ports.add(rendererPort);
  const vitePort = Number(input.vitePort);
  if (Number.isInteger(vitePort) && vitePort > 0) ports.add(vitePort);
  const pids = new Set<number>([input.mainPid]);
  if (input.enginePid) pids.add(input.enginePid);
  return { ports, pids };
}

export function portFromOrigin(raw: string | undefined): number | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}
