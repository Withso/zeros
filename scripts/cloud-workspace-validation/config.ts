// ──────────────────────────────────────────────────────────
// Cloud-workspace validation — shared provider config and helpers
// ──────────────────────────────────────────────────────────
//
// Everything the validation scripts share: how to construct the Daytona client,
// the snapshot/port/resource constants, and a tiny on-disk state file so
// `provision.ts` can hand the sandbox id + connection coords to the
// load-test scripts (`test-client.ts`, `soak-wss.ts`, `lifecycle.ts`,
// `egress.ts`, `ssh-forward.ts`).
//
// Run any script with `pnpm tsx scripts/cloud-workspace-validation/<name>.ts`
// after exporting DAYTONA_API_KEY. See ./README.md for the runbook.
// ──────────────────────────────────────────────────────────

import { Daytona } from "@daytona/sdk";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** Read an env var or die with a clear message (these scripts hit a paid API —
 *  fail loud rather than send a half-formed request). */
export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(
      `\n  ✗ Missing required env: ${name}\n    See scripts/cloud-workspace-validation/README.md\n`,
    );
    process.exit(1);
  }
  return v;
}

export function optEnv(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

// ── Daytona ───────────────────────────────────────────────

/** us | eu (GPU pins us-east-1). There is no Asia-Pacific region today, so a dev
 *  outside those two continents pays a ~100 ms+ RTT on every round trip — which
 *  makes a mirrored working copy preferable to a chatty remote filesystem.
 *  Override with DAYTONA_TARGET. */
export const DAYTONA_TARGET = optEnv("DAYTONA_TARGET", "eu");
export const DAYTONA_API_URL = optEnv(
  "DAYTONA_API_URL",
  "https://app.daytona.io/api",
);

export function makeDaytona(): Daytona {
  return new Daytona({
    apiKey: requireEnv("DAYTONA_API_KEY"),
    apiUrl: DAYTONA_API_URL,
    target: DAYTONA_TARGET,
  });
}

// ── Snapshot / image ──────────────────────────────────────

/** Pin the snapshot name; bump the suffix when the image build spec changes so
 *  warm pools never serve a stale template. */
export const SNAPSHOT_NAME = optEnv("ZEROS_SNAPSHOT_NAME", "zeros-engine-v0");

/** The repo the image clones + builds the engine from. Defaults to the public
 *  GitHub remote's main branch; override to test a fork/ref.
 *  (The image build runs `pnpm install` + `pnpm build:engine` inside the box, so
 *  the linux-x64 natives compile against the box's Node — no electron-rebuild
 *  trap, because there is no Electron in the sandbox.) */
export const ZEROS_REPO_URL = optEnv(
  "ZEROS_REPO_URL",
  "https://github.com/withso/zeros.git",
);
export const ZEROS_REPO_REF = optEnv("ZEROS_REPO_REF", "main");

/** Node major to pin the base image to. The engine bundle targets node18 but the
 *  natives + agent CLIs want a current Node; 22 matches the dev host ABI family. */
export const NODE_BASE_IMAGE = optEnv(
  "ZEROS_NODE_BASE_IMAGE",
  "node:22-bookworm",
);

// ── Ports / tokens ────────────────────────────────────────

/** The port the in-sandbox engine binds on 0.0.0.0 for CloudTransport
 *  (ZEROS_CLOUD_PORT). The preview URL maps the public WSS to this port. Any
 *  1–65535 except 22222 (reserved). */
export const ENGINE_CLOUD_PORT = Number(optEnv("ZEROS_CLOUD_PORT", "39393"));

/** Where the engine serves the project from inside the box. */
export const SANDBOX_REPO_DIR = "/home/daytona/zeros";
/** Engine data dir inside the box (ZEROS_DATA_DIR) — survives stop()/start(). */
export const SANDBOX_DATA_DIR = "/home/daytona/.zeros-data";

// ── Agent credentials (create()-time only) ────────────────

/** The agent CLIs' credentials the in-sandbox engine needs to authenticate.
 *  `agentSpawnOpts` (apps/desktop/src/engine/zeros-engine.ts) DROPS any client-supplied env for a
 *  `kind:"cloud"` peer — a correct trust boundary for an untrusted RELAY device,
 *  but it also means the sandbox agent gets NO keys from the Mac renderer (which
 *  couriers ANTHROPIC_API_KEY / OPENAI_API_KEY / CURSOR_API_KEY via that same
 *  stripped `env`). The only safe channel is create()-time env — image.ts
 *  deliberately keeps these OUT of the baked image so they aren't readable by a
 *  context-injected agent in the box. Pass an ALLOWLIST of known agent-credential
 *  vars from the provisioner's OWN env; never a blanket copy of process.env (that
 *  would leak DAYTONA_API_KEY et al. into the sandbox). Without this the sandbox
 *  agent boots then dies unauthenticated — "AGENT STOPPED → AGENT RESPONSE
 *  FAILURE" on every send. */
export const AGENT_CRED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CURSOR_API_KEY",
] as const;

/** The set agent-credential vars from the provisioner's env — only the present
 *  ones, so an unset key never becomes an empty-string env in the box. */
export function collectAgentCredEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of AGENT_CRED_ENV_VARS) {
    const v = process.env[name]?.trim();
    if (v) out[name] = v;
  }
  return out;
}

// ── Resources (a lean validation box) ──────────────────────────

export const RESOURCES = {
  cpu: Number(optEnv("ZEROS_SANDBOX_CPU", "2")),
  memory: Number(optEnv("ZEROS_SANDBOX_MEMORY", "4")), // GiB
  disk: Number(optEnv("ZEROS_SANDBOX_DISK", "10")), // GiB
};

// ── On-disk validation state (gitignored .context) ─────────────

export interface CloudValidationState {
  sandboxId: string;
  /** The raw preview URL for ENGINE_CLOUD_PORT — `https://{port}-{id}.proxy.daytona.work[s]`. */
  previewUrl: string;
  /** Daytona preview-proxy token (header `x-daytona-preview-token`). Rotates on restart. */
  previewToken: string;
  /** The Zeros CloudTransport connection token (ZEROS_CLOUD_TOKEN) — second layer on /ws. */
  cloudToken: string;
  region: string;
  createdAt: string;
}

const STATE_DIR = path.join(repoRoot, ".context", "cloud-workspace-validation");
const STATE_FILE = path.join(STATE_DIR, "state.json");
const LEGACY_STATE_FILE = path.join(
  repoRoot,
  ".context",
  "cloud-spike",
  "state.json",
);

/** Atomically persist bearer-bearing state with owner-only permissions. */
export function saveState(
  state: CloudValidationState,
  stateFile: string = STATE_FILE,
): void {
  const stateDir = path.dirname(stateFile);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDir, 0o700);

  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, stateFile);
    fs.chmodSync(stateFile, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  console.log(`  ↳ wrote ${path.relative(repoRoot, stateFile)} (owner-only)`);
}

export function clearState(stateFile: string = STATE_FILE): void {
  if (!fs.existsSync(stateFile)) return;
  fs.rmSync(stateFile, { force: true });
  try {
    fs.rmdirSync(path.dirname(stateFile));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "ENOENT") throw error;
  }
  console.log(`  ↳ removed ${path.relative(repoRoot, stateFile)}`);
}

export function loadState(
  stateFile: string = STATE_FILE,
): CloudValidationState {
  if (
    stateFile === STATE_FILE &&
    !fs.existsSync(stateFile) &&
    fs.existsSync(LEGACY_STATE_FILE)
  ) {
    const legacy = JSON.parse(
      fs.readFileSync(LEGACY_STATE_FILE, "utf8"),
    ) as CloudValidationState;
    saveState(legacy, STATE_FILE);
    clearState(LEGACY_STATE_FILE);
  }

  if (!fs.existsSync(stateFile)) {
    console.error(
      `\n  ✗ No validation state at ${path.relative(repoRoot, stateFile)}.\n` +
        `    Run \`pnpm tsx scripts/cloud-workspace-validation/provision.ts\` first.\n`,
    );
    process.exit(1);
  }
  fs.chmodSync(path.dirname(stateFile), 0o700);
  fs.chmodSync(stateFile, 0o600);
  return JSON.parse(fs.readFileSync(stateFile, "utf8")) as CloudValidationState;
}

/** Build the ws(s):// bridge URL from a preview URL.
 *  The Daytona preview proxy auto-upgrades `Upgrade: websocket`, so we just swap
 *  the scheme and append `/ws`. Both bearer tokens ride in headers so request
 *  targets, proxy logs, and copied URLs never contain them. */
export function bridgeWsUrl(previewUrl: string): string {
  const u = new URL(previewUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/ws";
  u.searchParams.delete("token");
  return u.toString();
}

export function healthUrl(previewUrl: string): string {
  const u = new URL(previewUrl);
  u.pathname = "/health";
  return u.toString();
}
