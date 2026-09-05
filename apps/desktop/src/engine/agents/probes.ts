// ──────────────────────────────────────────────────────────
// CLI install + auth probes
// ──────────────────────────────────────────────────────────
//
// Centralizes the former Electron IPC existence checks and the PATH probes from
// the agent registry. Everything here is:
//   1. Does the user have `<binary>` on PATH?
//   2. Does the credential file / keychain entry / command-line
//      verifier say the user is authenticated?
//
// Token-handling policy: probes never return, log, or transmit
// credential contents. The `file-with-expiry` probe DOES open the
// credential file to read a single expiry timestamp — but only that
// field is extracted and the parsed object is discarded inside the
// probe function. The boolean is the only thing that crosses this
// boundary.
//
// ──────────────────────────────────────────────────────────

import * as fsp from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AuthProbe } from "./registry";

const execFileP = promisify(execFile);

// ── PATH lookup ──────────────────────────────────────────

function pathExtensions(): string[] {
  if (process.platform !== "win32") return [""];
  const raw = process.env.PATHEXT ?? ".EXE;.BAT;.CMD";
  return raw.split(";").map((x) => x.toLowerCase());
}

async function isFileExecutable(full: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(full);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") {
      await fsp.access(full, fsConstants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Is `binary` on PATH on this machine? Does not execute it. */
export async function isOnPath(binary: string): Promise<boolean> {
  if (path.isAbsolute(binary)) return isFileExecutable(binary);
  if (binary.includes("/") || binary.includes("\\") || binary.includes("\0")) {
    return false;
  }
  const paths = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = pathExtensions();
  for (const dir of paths) {
    for (const ext of exts) {
      const candidate = path.join(dir, binary + ext);
      if (await isFileExecutable(candidate)) return true;
    }
  }
  return false;
}

/** Probe several binaries in parallel; returns the set present. */
export async function probeCliInstalled(
  binaries: string[],
): Promise<Set<string>> {
  const results = await Promise.all(
    binaries.map(async (b) => [b, await isOnPath(b)] as const),
  );
  return new Set(results.filter(([, ok]) => ok).map(([b]) => b));
}

// ── Version probing ──────────────────────────────────────
//
// `<bin> --version` is the near-universal convention. Three hard-won
// defaults below:
//
//   1. `killSignal: 'SIGKILL'`. Heavy Node-based CLIs (Cursor
//      Agent) take 5–15s on first run because they eagerly
//      import their full runtime even for `--version`. The
//      previous SIGTERM was being IGNORED during the Node import
//      phase — the Promise rejected on timeout but the child kept
//      running for 15+ seconds. With listAgents getting called every
//      few seconds, those orphaned children piled up to 200+ live
//      processes consuming ~10GB of RAM. SIGKILL can't be ignored.
//
//   2. 8s timeout (was 2s). Even with SIGKILL, a 2s budget made the
//      probe return null for any CLI that legitimately needs longer
//      to print its version. 8s is the observed worst case for these
//      CLIs on a cold disk + heavy concurrent IDE workload.
//
//   3. In-process result cache (5min TTL). Versions don't change
//      mid-session, and `listAgents` fires often (Settings auto-poll,
//      composer agent picker, every chat-thread mount). Without a
//      cache, every call re-spawns 5+ subprocesses per agent.

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const VERSION_CACHE_TTL_MS = 5 * 60_000;

interface VersionCacheEntry {
  value: string | null;
  at: number;
  inFlight?: Promise<string | null>;
}
const versionCache = new Map<string, VersionCacheEntry>();

/** Process-execution seam for provider-owned discovery commands. Production
 * supplies a selected-boundary runner; direct execution remains only as a
 * compatibility fallback for isolated tests and non-engine consumers. */
export interface ProbeCommandRunner {
  /** Distinguishes contained/runtime contexts in the version cache. */
  cacheKey: string;
  run(
    binary: string,
    args: string[],
    options: { timeoutMs: number },
  ): Promise<{ exitCode: number | null; stdout: string }>;
}

/** Run `<bin> --version` and return the first semver-ish substring.
 *  Returns null on timeout, non-zero exit, or unparseable output.
 *  Cached for 5min and de-duped across concurrent callers. */
export async function probeCliVersion(
  binary: string,
  runner?: ProbeCommandRunner,
): Promise<string | null> {
  const now = Date.now();
  const cacheKey = `${runner?.cacheKey ?? "host-fallback"}\0${binary}`;
  const cached = versionCache.get(cacheKey);
  if (cached && now - cached.at < VERSION_CACHE_TTL_MS && !cached.inFlight) {
    return cached.value;
  }
  if (cached?.inFlight) return cached.inFlight;

  const inFlight = (async () => {
    try {
      const { stdout, exitCode } = runner
        ? await runner.run(binary, ["--version"], {
            timeoutMs: VERSION_PROBE_TIMEOUT_MS,
          })
        : {
            ...(await execFileP(binary, ["--version"], {
              timeout: VERSION_PROBE_TIMEOUT_MS,
              killSignal: "SIGKILL",
            })),
            exitCode: 0,
          };
      if (exitCode !== 0) throw new Error("version probe exited non-zero");
      const trimmed = stdout.trim();
      const match = trimmed.match(/\b\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?\b/);
      const value = match?.[0] ?? (trimmed || null);
      versionCache.set(cacheKey, { value, at: Date.now() });
      return value;
    } catch {
      // Cache the failure too — repeating it spawns more processes
      // on every listAgents call. 5 min is short enough that an
      // upgrade gets picked up reasonably soon.
      versionCache.set(cacheKey, { value: null, at: Date.now() });
      return null;
    }
  })();
  versionCache.set(cacheKey, {
    value: cached?.value ?? null,
    at: cached?.at ?? 0,
    inFlight,
  });
  return inFlight;
}

/** Drop all cached `<bin> --version` results so the next probe re-runs. Called
 *  by the gateway's force-refresh (Providers → Refresh) so a just-updated CLI
 *  shows its new version immediately instead of waiting out the 5-min TTL. */
export function clearVersionCache(): void {
  versionCache.clear();
}

/** Compare two semver-ish strings. Returns -1/0/1. Non-numeric tails
 *  are ignored beyond major.minor.patch (pre-release precedence is
 *  NOT SemVer-accurate — we don't need it; compatibility decisions
 *  are major.minor only). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const core = v.replace(/-.*$/, ""); // strip pre-release tail
    return core
      .split(".")
      .slice(0, 3)
      .map((n) => {
        const x = Number.parseInt(n, 10);
        return Number.isFinite(x) ? x : 0;
      });
  };
  const [aa, bb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

export interface VersionCompatibility {
  /** Raw version string we got from `<bin> --version`. */
  version: string | null;
  /** True when the installed version falls inside [min, max]. Null
   *  means we couldn't probe — default to allowing the user to try,
   *  the adapter's parser will raise if the schema has
   *  moved and the translator can't follow. */
  compatible: boolean | null;
}

/** Check the installed version against a compatibility range. Either
 *  bound is optional. */
export async function probeCliCompatibility(
  args: {
    binary: string;
    minVersion?: string;
    maxVersion?: string;
  },
  runner?: ProbeCommandRunner,
): Promise<VersionCompatibility> {
  const version = await probeCliVersion(args.binary, runner);
  if (!version) return { version: null, compatible: null };
  if (args.minVersion && compareVersions(version, args.minVersion) < 0) {
    return { version, compatible: false };
  }
  if (args.maxVersion && compareVersions(version, args.maxVersion) > 0) {
    return { version, compatible: false };
  }
  return { version, compatible: true };
}

// ── Auth probes ──────────────────────────────────────────

function expandHome(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return p;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Env var carrying the path to the app's encrypted secret store
 *  (`<userData>/secrets.json`). Set by the Electron shell when it spawns
 *  the engine (apps/desktop/electron/sidecar.ts). Unset when the engine runs standalone
 *  (dev CLI, tests), in which case `secret-account` probes return false. */
const SECRETS_FILE_ENV = "ZEROS_SECRETS_FILE";

/** Exists-only check that the secret store holds a non-empty entry under
 *  `account`. Reads the JSON map written by Electron safeStorage but NEVER
 *  decrypts or returns the value — only key-presence escapes, so this
 *  honours the token-handling policy more strictly than `file-with-field`
 *  (which reads a field value to test non-empty). The stored value is an
 *  opaque base64 blob we never even look at. Returns false when the env var
 *  is unset (engine outside Electron) or on any read/parse error. */
async function secretAccountExists(account: string): Promise<boolean> {
  const file = process.env[SECRETS_FILE_ENV];
  if (!file) return false;
  try {
    const text = await fsp.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return false;
    const value = (parsed as Record<string, unknown>)[account];
    return typeof value === "string" && value.length > 0;
  } catch {
    return false;
  }
}

/** Opaque per-account CHANGE signal for `secret-account` probes: the stored
 *  (safeStorage-ENCRYPTED) blob for the account, "" when the entry is absent,
 *  null when the probe kind has no such signal or the store is unreadable.
 *  NEVER decrypts — the ciphertext is only compared for equality, so "the
 *  user re-saved this key" is detectable without the value escaping. This is
 *  the secret-store counterpart of latestAuthFileMtimeMs (which returns 0
 *  for secret-account: the shared secrets.json mtime isn't per-account) —
 *  without it, one auth-required failure pins the agent "Sign in required"
 *  for the full 30-minute TTL even after the user pastes a fresh key. */
export async function secretAccountFingerprint(
  probe: AuthProbe,
): Promise<string | null> {
  if (probe.kind !== "secret-account") return null;
  const file = process.env[SECRETS_FILE_ENV];
  if (!file) return null;
  try {
    const text = await fsp.readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return null;
    const value = (parsed as Record<string, unknown>)[probe.account];
    return typeof value === "string" ? value : "";
  } catch {
    return null;
  }
}

/** macOS keychain probe. `security find-generic-password` returns 0 if
 *  the entry exists, non-zero otherwise. We don't pass `-w` (which
 *  would print the secret); we only care about the exit code. */
async function keychainEntryExists(service: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    await execFileP("security", ["find-generic-password", "-s", service], {
      timeout: 1500,
      // SIGKILL (not the default SIGTERM) so a wedged `security` child is
      // actually reaped on timeout instead of lingering past the budget.
      killSignal: "SIGKILL",
    });
    return true;
  } catch {
    return false;
  }
}

async function commandExitsZero(
  binary: string,
  args: string[],
  runner?: ProbeCommandRunner,
): Promise<boolean> {
  // A boundary runner reports a normal provider rejection as a non-zero exit
  // code. A rejected Promise means the execution prerequisite itself failed
  // and must propagate so callers can render "check unavailable" truthfully.
  if (runner) {
    const result = await runner.run(binary, args, {
      timeoutMs: 5_000,
    });
    return result.exitCode === 0;
  }
  try {
    // SIGKILL on timeout — heavy Node-based CLIs ignore SIGTERM during
    // startup and would otherwise outlive the probe budget.
    await execFileP(binary, args, { timeout: 5_000, killSignal: "SIGKILL" });
    return true;
  } catch {
    return false;
  }
}

/** Walk a nested-object path, returning the value at the leaf or
 *  `undefined` if any intermediate key is missing / not an object.
 *  Used by the file-with-expiry probe to extract a single timestamp
 *  from a JSON credentials blob without exposing the rest. */
function getByPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Reads a JSON credentials file, walks `expiryFieldPath` to find a
 *  Unix timestamp, and returns false when the timestamp is in the
 *  past. False on every other failure mode (missing file, bad JSON,
 *  missing field, unparseable timestamp) so the caller defaults to
 *  "not authenticated" rather than silently accepting a broken
 *  credentials file. The parsed object is discarded inside this
 *  function — only the boolean escapes. */
async function fileHasUnexpiredCredential(
  rawPath: string,
  expiryFieldPath: string[],
  expiryUnit: "ms" | "s",
): Promise<boolean> {
  const full = expandHome(rawPath);
  try {
    const text = await fsp.readFile(full, "utf8");
    const parsed: unknown = JSON.parse(text);
    const raw = getByPath(parsed, expiryFieldPath);
    if (typeof raw !== "number" || !Number.isFinite(raw)) return false;
    const expiryMs = expiryUnit === "s" ? raw * 1000 : raw;
    return expiryMs > Date.now();
  } catch {
    return false;
  }
}

/** Reads a JSON credentials file, walks `fieldPath`, and returns true
 *  iff the leaf is a non-empty string. False on every other failure
 *  mode (missing file, bad JSON, missing/empty field). Used for OAuth
 *  credential files where the presence of a long-lived refresh token is
 *  the real "signed in" signal — the short-lived access-token
 *  `expiry_date` is not, because the CLI silently refreshes it. The
 *  field value is read but never escapes this function — only the
 *  boolean does. */
async function fileHasNonEmptyField(
  rawPath: string,
  fieldPath: string[],
): Promise<boolean> {
  const full = expandHome(rawPath);
  try {
    const text = await fsp.readFile(full, "utf8");
    const parsed: unknown = JSON.parse(text);
    const raw = getByPath(parsed, fieldPath);
    return typeof raw === "string" && raw.length > 0;
  } catch {
    return false;
  }
}

/** Most-recent mtime across every credential file referenced by a probe.
 *  Used by the gateway to decide whether a runtime "auth-failed" marker
 *  is still relevant: if the user re-signed-in via Terminal.app, the
 *  credentials file gets re-written and its mtime jumps past the failure
 *  time, so we can confidently re-probe. Returns 0 for keychain/command
 *  probes (no fs signal available), so the marker still expires via the
 *  30 min TTL there. */
export async function latestAuthFileMtimeMs(probe: AuthProbe): Promise<number> {
  switch (probe.kind) {
    case "file": {
      let max = 0;
      for (const raw of probe.paths) {
        try {
          const stat = await fsp.stat(expandHome(raw));
          if (stat.mtimeMs > max) max = stat.mtimeMs;
        } catch {
          /* missing file — ignore */
        }
      }
      return max;
    }
    case "file-with-expiry":
    case "file-with-field": {
      try {
        const stat = await fsp.stat(expandHome(probe.path));
        return stat.mtimeMs;
      } catch {
        return 0;
      }
    }
    case "any-of": {
      let max = 0;
      for (const inner of probe.probes) {
        const m = await latestAuthFileMtimeMs(inner);
        if (m > max) max = m;
      }
      return max;
    }
    case "keychain":
    case "command":
      return 0;
    case "secret-account":
      // secrets.json is shared across every account, so its mtime isn't a
      // per-account signal — return 0 (TTL-only runtime invalidation),
      // matching keychain/command.
      return 0;
  }
}

/** Evaluate a single probe spec. See the file-top doc for the
 *  token-handling policy that constrains what each kind can read. */
export async function evaluateAuthProbe(
  probe: AuthProbe,
  runner?: ProbeCommandRunner,
): Promise<boolean> {
  switch (probe.kind) {
    case "file": {
      for (const raw of probe.paths) {
        if (await exists(expandHome(raw))) return true;
      }
      return false;
    }
    case "file-with-expiry":
      return fileHasUnexpiredCredential(
        probe.path,
        probe.expiryFieldPath,
        probe.expiryUnit ?? "ms",
      );
    case "file-with-field":
      return fileHasNonEmptyField(probe.path, probe.fieldPath);
    case "secret-account":
      return secretAccountExists(probe.account);
    case "keychain":
      return keychainEntryExists(probe.service);
    case "command":
      return commandExitsZero(probe.binary, probe.args, runner);
    case "any-of": {
      for (const inner of probe.probes) {
        if (await evaluateAuthProbe(inner, runner)) return true;
      }
      return false;
    }
  }
}
