
import { readBoundedUtf8FileSync } from "../files/bounded-read-sync";
import path from "node:path";
import { withoutLocalDevelopment } from "../env/local-development";
import { zerosSkillInstructions } from "../agents/zeros-skills";
import { spawnEnvNameHazard, type SpawnEnvHazard } from "./env-names";
import { opSettingsResolve } from "./ops";
import type { SettingsLayerName } from "./schema";

/** Bound reads so an unusually large env file cannot exhaust engine memory. */
const ENV_FILE_MAX_BYTES = 1024 * 1024;

/** Match the renderer and MCP secret sentinel; the real value arrives separately through the caller. */
const SECRET_SENTINEL = "${zeros.secret}";

const HAZARD_REASON: Record<SpawnEnvHazard, string> = {
  "code-injection": "code-injection guard",
  "credential-redirect":
    "credential-redirect guard — would re-route the agent's API traffic/credentials",
  "secret-shaped":
    "secret-shaped name — keep credentials in the Keychain, not the env table",
};

/** Only user and managed policy may route credential-bearing traffic; team settings are not controlled by the machine owner. */
const CREDENTIAL_REDIRECT_TRUSTED_LAYERS = new Set<SettingsLayerName>([
  "user",
  "managed",
]);

/** Trusted layers can route traffic, but cannot supply code-injection or secret-shaped names here. */
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

/** Dotenv values are literal: no variable expansion or command substitution. */
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
      let acc = rest.slice(1);
      let closed = false;
      for (;;) {
        const end = findUnescapedQuote(acc);
        if (end >= 0) {
          acc = acc.slice(0, end);
          closed = true;
          break;
        }
        if (i + 1 >= lines.length) break;
        acc += "\n" + lines[++i]!;
      }
      out[key] = closed ? unescapeDoubleQuoted(acc) : acc;
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      out[key] = end >= 0 ? rest.slice(1, end) : rest.slice(1);
    } else {
      const hash = rest.indexOf(" #");
      if (hash >= 0) rest = rest.slice(0, hash);
      out[key] = rest.trim();
    }
  }
  return out;
}

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
  env: Record<string, string>;
  warnings: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Settings failures are non-fatal to spawning; return any usable values with warnings. */
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
    // Use the main checkout for inherited repository settings when provided.
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

  // General preferences are instruction text under an engine-owned name; the gateway resolves the target branch from the workspace separately.
  const promptsTable = effective.prompts;
  if (
    isPlainObject(promptsTable) &&
    typeof promptsTable.general === "string" &&
    promptsTable.general.trim()
  ) {
    out.ZEROS_PROMPTS_GENERAL = promptsTable.general;
  }

  try {
    const skills = zerosSkillInstructions(mainRepoRoot ?? cwd);
    if (skills)
      out.ZEROS_PROMPTS_GENERAL = [out.ZEROS_PROMPTS_GENERAL, skills]
        .filter(Boolean)
        .join("\n\n");
  } catch (error) {
    warnings.push(
      `Zeros skills could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const table = effective.env;
  if (isPlainObject(table)) {
    for (const [k, v] of Object.entries(table)) {
      if (typeof v !== "string") continue;
      // Skip the persisted placeholder silently; the caller supplies the real secret.
      if (v === SECRET_SENTINEL) continue;
      const hazard = spawnEnvNameHazard(k);
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
      // Keep reads inside the working directory without following symlinks.
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
      let text: string;
      try {
        text = readBoundedUtf8FileSync(abs, ENV_FILE_MAX_BYTES, { noFollow: true, root: cwdAbs });
      } catch {
        warnings.push(`env_file not found or unreadable: ${f}`);
        continue;
      }
      try {
        for (const [k, v] of Object.entries(parseDotenv(text))) {
          // Unlike the settings table, file content has no trusted-layer exception.
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

/** Caller values override settings; strip the local-development admission flag from any returned environment. */
export function mergeSpawnEnv(
  cwd: string,
  callerEnv: Record<string, string> | undefined,
  mainRepoRoot?: string,
): Record<string, string> | undefined {
  const { env, warnings } = resolveSpawnEnv(cwd, mainRepoRoot);
  for (const w of warnings)
    console.warn(`[agents] settings env (${cwd}): ${w}`);
  if (Object.keys(env).length === 0) return callerEnv ? withoutLocalDevelopment(callerEnv) : callerEnv;
  return withoutLocalDevelopment({ ...env, ...(callerEnv ?? {}) });
}
