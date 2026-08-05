// ──────────────────────────────────────────────────────────
// Agent spawn environment composition from layered settings
// ──────────────────────────────────────────────────────────
//
// Turns the resolved settings for an agent's working directory into the
// extra environment its process spawns with: the TOML `env` table plus any
// `env_files` parsed relative to the cwd. Since the 2026-07-17 repo-file
// slimming, `env`/`env_files` resolve from the USER (and team/managed) layers
// only — repo-scoped settings files carry scripts config, and per-repo env
// vars live in the Keychain env vault (couriered via the caller env). The
// gateway merges this UNDER the caller's env (per-session model/effort knobs
// + keychain secrets always win), so this is purely additive — an agent
// always spawns even if settings are missing or malformed.
//
// SECURITY — the spawned agent holds live keychain credentials and its env is
// NOT scrubbed (a setup script's is). So every NAME is run through
// `spawnEnvNameHazard` and dropped if it could inject code, re-route the
// agent's credential-bearing API traffic (ANTHROPIC_BASE_URL & the other
// gateway/proxy/CA vars), or smells like a secret. The committed-repo
// hostile-clone vector is now closed structurally (the sanitizer drops `env`
// from repo layers wholesale); this per-name filter stays as defense in depth
// for the user's own file and the cloud team layer. The user's couriered
// gateway URL rides the caller env (which `mergeSpawnEnv` never filters) — so
// this filter never breaks the sanctioned config, only the planted one.
//
// Credential-redirect NAMES stay LAYER-AWARE: allowed from the machine
// owner's / MDM layers (user / managed), dropped from the cloud team layer.
// Code-injection + secret-shaped NAMES are dropped from EVERY layer;
// env_files stay strict (all three classes dropped).
// ──────────────────────────────────────────────────────────

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnEnvNameHazard, type SpawnEnvHazard } from "./env-names";
import { opSettingsResolve } from "./ops";
import type { SettingsLayerName } from "./schema";

/** Max bytes read from an env_file (DoS guard — `/dev/zero` or a multi-GB log
 *  must not OOM the engine). A real .env is a few KB. */
const ENV_FILE_MAX_BYTES = 1024 * 1024; // 1 MB

/** The marker a `[env]` VALUE carries when its real value lives in the OS
 *  Keychain, not the settings file (the renderer couriers it into the agent's
 *  process env at spawn — and the caller env wins, so the value lands there).
 *  We skip the placeholder here so the literal never reaches the agent. MUST
 *  match MCP_SECRET_SENTINEL (agents/mcp-registry.ts) + the renderer copies. */
const SECRET_SENTINEL = "${zeros.secret}";

/** Human-readable reason per hazard class, for the spawn warning. */
const HAZARD_REASON: Record<SpawnEnvHazard, string> = {
  "code-injection": "code-injection guard",
  "credential-redirect":
    "credential-redirect guard — would re-route the agent's API traffic/credentials",
  "secret-shaped":
    "secret-shaped name — keep credentials in the Keychain, not the env table",
};

/** Layers trusted to set a credential-redirect env NAME (gateway base-URL,
 *  proxy, CA bundle): the machine owner's own config and MDM policy. Since
 *  the repo-file slimming, repo-scoped layers can't carry `env` at all, so in
 *  practice only `user` and `managed` can reach this allowance. ("default"
 *  never carries env, so its omission is moot.) */
const CREDENTIAL_REDIRECT_TRUSTED_LAYERS = new Set<SettingsLayerName>([
  "user",
  // NOTE: `team` is deliberately NOT here. The team layer is cloud-pushed by
  // whichever team the member's login belongs to — a DIFFERENT party from the
  // machine owner (unlike `managed`, a local MDM file). Letting it set
  // ANTHROPIC_BASE_URL / HTTP_PROXY / NODE_EXTRA_CA_CERTS would let a team
  // reroute a member's credential-bearing agent traffic to a team-controlled
  // host (the member's real keychain API key rides along). Proxy/base-URL must
  // come from the member's OWN user/managed config. (Audit 2026-07-04, engine
  // finding #2.)
  "managed",
]);

/** Whether a hazardous env NAME may still reach the agent, given which layer
 *  set it. Only credential-redirect is layer-conditional; code-injection and
 *  secret-shaped are always dropped, from every layer. */
function hazardAllowedFromLayer(
  hazard: SpawnEnvHazard,
  source: SettingsLayerName | undefined,
): boolean {
  return (
    hazard === "credential-redirect" &&
    source !== undefined &&
    CREDENTIAL_REDIRECT_TRUSTED_LAYERS.has(source)
  );
}

/** Parse a dotenv file's text into a flat dict. Safe by design: `KEY=VALUE`
 *  per line, `#` comments, optional `export ` (space or tab), single/double
 *  quotes stripped, double-quoted values may span lines (PEM keys) and honor
 *  `\n`/`\"`/`\\` escapes. NO variable expansion or command substitution —
 *  values are literal. Unparseable lines skipped. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const body = /^export\s+/.test(line)
      ? line.replace(/^export\s+/, "")
      : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let rest = body.slice(eq + 1).trimStart();

    if (rest.startsWith('"')) {
      // Double-quoted, possibly multi-line: accumulate until the closing
      // unescaped quote, then unescape.
      let acc = rest.slice(1);
      let closed = false;
      for (;;) {
        const end = findUnescapedQuote(acc);
        if (end >= 0) {
          acc = acc.slice(0, end);
          closed = true;
          break;
        }
        if (i + 1 >= lines.length) break; // unterminated — take what we have
        acc += "\n" + lines[++i]!;
      }
      out[key] = closed ? unescapeDoubleQuoted(acc) : acc;
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1); // single quotes: no escapes, no multiline
      out[key] = end >= 0 ? rest.slice(1, end) : rest.slice(1);
    } else {
      // Unquoted: strip a trailing ` # inline comment`.
      const hash = rest.indexOf(" #");
      if (hash >= 0) rest = rest.slice(0, hash);
      out[key] = rest.trim();
    }
  }
  return out;
}

/** Index of the first `"` not preceded by an odd run of backslashes, or -1. */
function findUnescapedQuote(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue;
    let bs = 0;
    for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) bs++;
    if (bs % 2 === 0) return i;
  }
  return -1;
}

function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\([\\"n])/g, (_, c) => (c === "n" ? "\n" : c));
}

export interface SpawnEnvResult {
  /** The settings-derived env: `env` table overlaid by each `env_files` file
   *  in order. Empty when nothing is configured (or on any failure). */
  env: Record<string, string>;
  /** Non-fatal notes (missing/unreadable env file, resolve failure). */
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Compose the settings-derived environment for an agent spawning in `cwd`.
 *  NEVER throws — every failure degrades to a warning + a partial/empty dict
 *  so an agent can always spawn. */
export function resolveSpawnEnv(
  cwd: string,
  mainRepoRoot?: string,
): SpawnEnvResult {
  const warnings: string[] = [];
  const out: Record<string, string> = {};
  if (!cwd) return { env: out, warnings };

  let effective: Record<string, unknown>;
  let sources: Record<string, SettingsLayerName>;
  try {
    // mainRepoRoot lets a worktree agent inherit the main checkout's repo-local
    // (machine-wide repo override) plus its own worktree workspace-local.
    const resolved = opSettingsResolve(cwd, mainRepoRoot);
    effective = resolved.effective;
    sources = resolved.sources;
  } catch (err) {
    return {
      env: out,
      warnings: [
        `settings resolve failed: ${String((err as Error)?.message ?? err)}`,
      ],
    };
  }

  // First-turn system-instruction input for the gateway's withSystemInstruction:
  // the repo's "General preferences" (Settings → Repo → Actions → `[prompts]
  // general`). NOT a user [env] var — it carries orientation TEXT the gateway
  // wraps in <system_instruction> (never executed), so it's added directly to
  // `out` and skips the [env] hazard filter (the NAME is ours). `prompts` has no
  // default, so this only appears when the repo/user actually sets it.
  // (The PR target branch isn't emitted HERE: settings only know the repo-wide
  // default, which would mislabel workspaces whose base was changed. The
  // gateway stamps ZEROS_TARGET_BRANCH from the workspace row at spawn —
  // see withTargetBranchEnv in agents/gateway.ts.)
  const promptsTable = effective.prompts;
  if (
    isPlainObject(promptsTable) &&
    typeof promptsTable.general === "string" &&
    promptsTable.general.trim()
  ) {
    out.ZEROS_PROMPTS_GENERAL = promptsTable.general;
  }

  const table = effective.env;
  if (isPlainObject(table)) {
    for (const [k, v] of Object.entries(table)) {
      if (typeof v !== "string") continue;
      // A Keychain-backed secret env var (🔒 in the Environment UI): its real
      // value is couriered into the caller env (which wins), so skip the sentinel
      // silently — never inject the literal, and don't warn (it's intentional,
      // not an unsafe name). This lets `[env]` hold secrets WITHOUT plaintext.
      if (v === SECRET_SENTINEL) continue;
      const hazard = spawnEnvNameHazard(k);
      // Credential-redirect names are honored from the machine-owner/MDM
      // layers (user/managed) but blocked from the cloud team layer;
      // code-injection and secret-shaped are always dropped. (env_files stay
      // strict — see below.)
      if (hazard && !hazardAllowedFromLayer(hazard, sources[`env.${k}`])) {
        warnings.push(
          `env: ignored unsafe variable name "${k}" (${HAZARD_REASON[hazard]})`,
        );
        continue;
      }
      out[k] = v;
    }
  }

  const files = effective.env_files;
  if (Array.isArray(files)) {
    const cwdAbs = path.resolve(cwd);
    for (const f of files) {
      if (typeof f !== "string" || !f.trim()) continue;
      // SECURITY: confine to the cwd subtree — reject absolute paths and `..`
      // traversal so a repo can't read /etc/shadow, ~/.aws/credentials, etc.
      // into the agent env (mirrors setup-hooks' resolveContainedPaths).
      if (path.isAbsolute(f) || f.split(/[\\/]/).includes("..")) {
        warnings.push(
          `env_file rejected (must be a relative path inside the repo): ${f}`,
        );
        continue;
      }
      const abs = path.resolve(cwdAbs, f);
      if (abs !== cwdAbs && !abs.startsWith(cwdAbs + path.sep)) {
        warnings.push(`env_file rejected (escapes the repo): ${f}`);
        continue;
      }
      try {
        const st = statSync(abs);
        if (!st.isFile()) {
          warnings.push(`env_file is not a regular file: ${f}`);
          continue;
        }
        if (st.size > ENV_FILE_MAX_BYTES) {
          warnings.push(
            `env_file too large (> ${ENV_FILE_MAX_BYTES} bytes), skipped: ${f}`,
          );
          continue;
        }
      } catch {
        warnings.push(`env_file not found or unreadable: ${f}`);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        warnings.push(`env_file not found or unreadable: ${f}`);
        continue;
      }
      try {
        for (const [k, v] of Object.entries(parseDotenv(text))) {
          const hazard = spawnEnvNameHazard(k);
          if (hazard) {
            warnings.push(
              `env_file "${f}": ignored unsafe variable name "${k}" (${HAZARD_REASON[hazard]})`,
            );
            continue;
          }
          out[k] = v;
        }
      } catch {
        warnings.push(`env_file could not be parsed: ${f}`);
      }
    }
  }

  return { env: out, warnings };
}

/** Merge settings-derived env UNDER `callerEnv` (caller wins). Returns
 *  `callerEnv` unchanged (possibly undefined) when settings add nothing, so
 *  the no-settings path is byte-identical to before this feature. */
export function mergeSpawnEnv(
  cwd: string,
  callerEnv: Record<string, string> | undefined,
  mainRepoRoot?: string,
): Record<string, string> | undefined {
  const { env, warnings } = resolveSpawnEnv(cwd, mainRepoRoot);
  for (const w of warnings)
    console.warn(`[agents] settings env (${cwd}): ${w}`);
  if (Object.keys(env).length === 0) return callerEnv;
  return { ...env, ...(callerEnv ?? {}) };
}
