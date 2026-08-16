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
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sanitizeGithubCredential,
  type GithubCredential,
} from "@zeros/protocol/github-auth";
import { parseValidationAutoDeleteMinutes } from "./lib/qualification-gates";

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
export const SNAPSHOT_NAME = optEnv("ZEROS_SNAPSHOT_NAME", "zeros-engine-v1");

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
const configuredRepositoryCommit = process.env.ZEROS_REPO_COMMIT?.trim();
if (
  configuredRepositoryCommit &&
  !/^[a-f0-9]{40,64}$/.test(configuredRepositoryCommit)
) {
  throw new Error("ZEROS_REPO_COMMIT must be a full lowercase commit id");
}
export const ZEROS_REPO_COMMIT = configuredRepositoryCommit || undefined;

/** Node major to pin the base image to. The engine bundle targets node18 but the
 *  natives + agent CLIs want a current Node; 22 matches the dev host ABI family. */
export const NODE_BASE_IMAGE = optEnv(
  "ZEROS_NODE_BASE_IMAGE",
  "node:22.23.1-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37",
);

// ── Ports / tokens ────────────────────────────────────────

/** The port the in-sandbox engine binds on 0.0.0.0 for CloudTransport
 *  (ZEROS_CLOUD_PORT). The preview URL maps the public WSS to this port. Any
 *  1–65535 except 22222 (reserved). */
export function parseCloudValidationPort(raw: string | undefined): number {
  const value = raw?.trim() || "39393";
  if (!/^[1-9][0-9]{0,4}$/.test(value)) {
    throw new Error("ZEROS_CLOUD_PORT is an invalid cloud port");
  }
  const port = Number(value);
  if (port > 65_535 || port === 22_222) {
    throw new Error(
      "ZEROS_CLOUD_PORT is an invalid cloud port (use 1-65535 except 22222)",
    );
  }
  return port;
}

export const ENGINE_CLOUD_PORT = parseCloudValidationPort(
  process.env.ZEROS_CLOUD_PORT,
);

/** Dedicated provider-preview origins used by the authenticated ZSR browser
 * façades. The agent listeners stay inside their private network namespaces;
 * these host ports are bound only by the trusted engine after admission. */
export const CLOUD_PREVIEW_PORTS = Object.freeze(
  Array.from({ length: 64 }, (_value, index) => 41_000 + index),
);
export const CLOUD_PREVIEW_LINK_TTL_SECONDS = 24 * 60 * 60;
/** Browser-facing engine ingress uses Daytona's signed-hostname form. Browser
 * WebSocket cannot attach the ordinary x-daytona-preview-token header. */
export const CLOUD_ENGINE_INGRESS_TTL_SECONDS = (() => {
  const value = Number(
    optEnv("ZEROS_CLOUD_ENGINE_INGRESS_TTL_SECONDS", String(24 * 60 * 60)),
  );
  if (!Number.isInteger(value) || value < 60 || value > 24 * 60 * 60) {
    throw new Error(
      "ZEROS_CLOUD_ENGINE_INGRESS_TTL_SECONDS must be an integer from 60 through 86400",
    );
  }
  return value;
})();

/** Immutable, root-owned engine installation. Agent-controlled bytes must
 * never be loaded from this tree by the privileged coordinator. */
export const SANDBOX_ENGINE_DIR = "/opt/zeros";
/** Writable validation checkout served by the engine. This deliberately
 * differs from SANDBOX_ENGINE_DIR so an agent cannot replace its supervisor. */
export const SANDBOX_REPO_DIR = "/workspace/zeros";
/** Engine database/control state. It is absent from every code boundary. */
export const SANDBOX_DATA_DIR = "/var/lib/zeros";
export const SANDBOX_ENGINE_LOG = "/var/log/zeros/engine.log";
export const SANDBOX_AGENT_UID = 10_001;
export const SANDBOX_AGENT_GID = 10_001;
export const ZSR_CGROUP_PARENT = "/sys/fs/cgroup/zeros-agents";
export const ZSR_CLOUD_AGENT_RESOURCES = Object.freeze({
  memoryBytes: 3 * 1024 * 1024 * 1024,
  cpuQuotaMicros: 200_000,
  cpuPeriodMicros: 100_000,
  processes: 2_048,
});

// ── Agent credentials (create()-time only) ────────────────

/** The agent CLIs' credentials the in-sandbox engine needs to authenticate.
 *  `agentSpawnOpts` (apps/desktop/src/engine/zeros-engine.ts) DROPS any client-supplied env for a
 *  `kind:"cloud"` peer — a correct trust boundary for an untrusted RELAY device,
 *  and it also gives headless validation/restart flows no renderer courier from
 *  which to obtain provider credentials. image.ts deliberately keeps keys OUT
 *  of the baked image. Pass an ALLOWLIST of known agent-credential vars from the
 *  provisioner's OWN env; never a blanket copy of process.env (that would leak
 *  DAYTONA_API_KEY et al. into the sandbox). Interactive authenticated clients
 *  may additionally courier their bounded session/provider env at spawn time. */
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

function boundedEnvValue(
  env: NodeJS.ProcessEnv,
  name: string,
  maxBytes: number,
): string | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (Buffer.byteLength(value, "utf8") > maxBytes || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function secureIdentityUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is invalid`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be a credential-free HTTPS URL`);
  }
  return url.toString();
}

/** Immutable worker-owner and public verifier configuration. The browser's
 * account JWT deliberately stays outside create-time sandbox environment. */
export function collectCloudAccountBindingEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const owner = boundedEnvValue(env, "ZEROS_CLOUD_OWNER_SUB", 512);
  if (!owner) {
    throw new Error(
      "qualified cloud account binding requires ZEROS_CLOUD_OWNER_SUB",
    );
  }
  const jwksRaw = boundedEnvValue(env, "ZEROS_ACCOUNT_JWT_JWKS_URL", 4_096);
  const issuerRaw = boundedEnvValue(env, "ZEROS_ACCOUNT_JWT_ISSUER", 4_096);
  const publicKey = env.ZEROS_ACCOUNT_JWT_PUBLIC_KEY?.trim();
  if (
    publicKey &&
    (Buffer.byteLength(publicKey, "utf8") > 32 * 1024 ||
      !publicKey.includes("BEGIN PUBLIC KEY"))
  ) {
    throw new Error("ZEROS_ACCOUNT_JWT_PUBLIC_KEY is invalid");
  }
  if (!jwksRaw && !issuerRaw && !publicKey) {
    throw new Error(
      "qualified cloud workspaces require asymmetric account binding (JWKS, issuer, or public key)",
    );
  }
  const audience = boundedEnvValue(env, "ZEROS_ACCOUNT_JWT_AUD", 512);
  const acceptedIssuers = boundedEnvValue(env, "ZEROS_ACCOUNT_JWT_ISS", 4_096);
  const skew = boundedEnvValue(env, "ZEROS_ACCOUNT_JWT_SKEW", 16);
  if (skew !== undefined) {
    const parsed = Number(skew);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300) {
      throw new Error("ZEROS_ACCOUNT_JWT_SKEW is invalid");
    }
  }
  return {
    ZEROS_CLOUD_OWNER_SUB: owner,
    ...(jwksRaw
      ? {
          ZEROS_ACCOUNT_JWT_JWKS_URL: secureIdentityUrl(
            jwksRaw,
            "ZEROS_ACCOUNT_JWT_JWKS_URL",
          ),
        }
      : {}),
    ...(issuerRaw
      ? {
          ZEROS_ACCOUNT_JWT_ISSUER: secureIdentityUrl(
            issuerRaw,
            "ZEROS_ACCOUNT_JWT_ISSUER",
          ),
        }
      : {}),
    ...(publicKey ? { ZEROS_ACCOUNT_JWT_PUBLIC_KEY: publicKey } : {}),
    ...(audience ? { ZEROS_ACCOUNT_JWT_AUD: audience } : {}),
    ...(acceptedIssuers ? { ZEROS_ACCOUNT_JWT_ISS: acceptedIssuers } : {}),
    ...(skew ? { ZEROS_ACCOUNT_JWT_SKEW: skew } : {}),
    ZEROS_REQUIRE_ACCOUNT: "1",
  };
}

/** Read an operator-provided cloud GitHub working copy. It is passed once to
 * the immutable root installer; callers must never merge it into sandbox env
 * or CloudValidationState. */
export function collectCloudGithubCredential(
  env: NodeJS.ProcessEnv = process.env,
): GithubCredential | null {
  const rawToken = env.ZEROS_CLOUD_GITHUB_TOKEN;
  if (rawToken === undefined || rawToken === "") return null;
  if (
    rawToken !== rawToken.trim() ||
    Buffer.byteLength(rawToken, "utf8") > 4_096 ||
    /[\0\r\n]/.test(rawToken)
  ) {
    throw new Error("cloud GitHub credential is invalid");
  }
  const method = env.ZEROS_CLOUD_GITHUB_METHOD?.trim() || "pat";
  const login = boundedEnvValue(env, "ZEROS_CLOUD_GITHUB_LOGIN", 100);
  const expiresRaw = boundedEnvValue(
    env,
    "ZEROS_CLOUD_GITHUB_EXPIRES_AT_MS",
    32,
  );
  const expiresAtMs = expiresRaw ? Number(expiresRaw) : undefined;
  const candidate = sanitizeGithubCredential({
    method,
    accessToken: rawToken,
    gitHost: "github.com",
    gitHttpUsername: "x-access-token",
    ...(login ? { login } : {}),
    ...(method === "github-app"
      ? {
          expiresAtMs,
          variantKey: "github.com",
        }
      : {}),
  });
  if (
    !candidate ||
    candidate.gitHost !== "github.com" ||
    candidate.gitHttpUsername !== "x-access-token" ||
    (candidate.method === "github-app" &&
      (!candidate.expiresAtMs || candidate.expiresAtMs <= Date.now() + 60_000))
  ) {
    throw new Error("cloud GitHub credential is invalid");
  }
  return candidate;
}

// ── Resources (a lean validation box) ──────────────────────────

function boundedCloudResource(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = env[name]?.trim() || String(fallback);
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new Error(`${name} must be a canonical positive number`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${name} must be greater than zero and at most ${maximum}`);
  }
  return parsed;
}

/** Bound paid-provider inputs before creating a snapshot. The ceilings are
 * intentionally above the qualification profile while preventing a typo from
 * requesting an unexpectedly expensive machine. */
export function parseCloudValidationResources(
  env: NodeJS.ProcessEnv = process.env,
): { cpu: number; memory: number; disk: number } {
  return {
    cpu: boundedCloudResource(env, "ZEROS_SANDBOX_CPU", 2, 64),
    memory: boundedCloudResource(env, "ZEROS_SANDBOX_MEMORY", 4, 256),
    disk: boundedCloudResource(env, "ZEROS_SANDBOX_DISK", 10, 1_024),
  };
}

export const RESOURCES = Object.freeze(parseCloudValidationResources());

/** Operator sandboxes stay durable by default. Protected CI sets a bounded
 * provider-side deadline so a killed runner cannot orphan paid compute. */
export const VALIDATION_AUTO_DELETE_MINUTES = parseValidationAutoDeleteMinutes(
  process.env.ZEROS_CLOUD_VALIDATION_AUTO_DELETE_MINUTES,
);

// ── On-disk validation state (gitignored .context) ─────────────

export interface CloudValidationState {
  sandboxId: string;
  /** Current browser-compatible signed ingress for ENGINE_CLOUD_PORT. Legacy
   * validation state may still contain the standard preview URL until wake. */
  previewUrl: string;
  /** Provider revocation token for previewUrl. It is not sent as a header when
   * engineIngress is present; signed and standard preview tokens are distinct. */
  previewToken: string;
  /** The Zeros CloudTransport connection token (ZEROS_CLOUD_TOKEN) — second layer on /ws. */
  cloudToken: string;
  region: string;
  createdAt: string;
  snapshotId: string;
  snapshotImageName: string;
  runtimeAttestationSha256: string;
  engineIngress?: CloudEngineIngressState;
  /** Crash journal written after minting but before publishing replacement
   * connection state to the owner-only coordinator file. */
  engineIngressTransition?: CloudEngineIngressTransitionState;
  cloudPreview?: CloudPreviewGrantState;
  /** Crash journal written after minting but before publishing a replacement
   * signed-link document inside the worker. Never omit cleanup for this state. */
  cloudPreviewTransition?: CloudPreviewTransitionState;
}

export interface CloudEngineIngressGeneration {
  readonly generation: string;
  readonly expiresAt: number;
  readonly port: number;
  readonly token: string;
}

export interface CloudEngineIngressState extends CloudEngineIngressGeneration {
  readonly url: string;
  /** Old signed origins remain valid for already-open renderers while the new
   * descriptor propagates. They expire naturally and are all revoked on stop. */
  readonly retiring?: readonly CloudEngineIngressGeneration[];
}

export interface CloudEngineIngressTransitionState {
  readonly startedAt: number;
  readonly replacement: Omit<CloudEngineIngressState, "retiring">;
}

export interface CloudPreviewGrantState {
  readonly generation: string;
  readonly expiresAt: number;
  readonly grants: readonly {
    readonly port: number;
    readonly token: string;
  }[];
  /** Older links remain provider-valid only long enough for live browser frames
   * to re-admit on the replacement origin. Cleanup revokes every generation. */
  readonly retiring?: readonly CloudPreviewGrantGeneration[];
}

export type CloudPreviewGrantGeneration = Omit<
  CloudPreviewGrantState,
  "retiring"
>;

export interface CloudPreviewTransitionState {
  readonly startedAt: number;
  readonly replacement: CloudPreviewGrantGeneration;
}

function boundedString(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function parsePreviewGrantGeneration(
  raw: unknown,
): CloudPreviewGrantGeneration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud validation state has an invalid preview grant");
  }
  const value = raw as Record<string, unknown>;
  if (
    !boundedString(value.generation, 64) ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(value.generation) ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) <= 0 ||
    !Array.isArray(value.grants) ||
    value.grants.length < 1 ||
    value.grants.length > 64
  ) {
    throw new Error("cloud validation state has an invalid preview grant");
  }
  const grants = value.grants.map((rawGrant) => {
    if (!rawGrant || typeof rawGrant !== "object" || Array.isArray(rawGrant)) {
      throw new Error("cloud validation state has an invalid preview grant");
    }
    const grant = rawGrant as Record<string, unknown>;
    if (
      !Number.isInteger(grant.port) ||
      Number(grant.port) < 1 ||
      Number(grant.port) > 65_535 ||
      !boundedString(grant.token, 4_096) ||
      grant.token.length < 16
    ) {
      throw new Error("cloud validation state has an invalid preview grant");
    }
    return { port: Number(grant.port), token: grant.token };
  });
  if (new Set(grants.map((grant) => grant.port)).size !== grants.length) {
    throw new Error("cloud validation state has duplicate preview ports");
  }
  return {
    generation: value.generation,
    expiresAt: Number(value.expiresAt),
    grants,
  };
}

function parsePreviewGrantState(raw: unknown): CloudPreviewGrantState {
  const current = parsePreviewGrantGeneration(raw);
  const value = raw as Record<string, unknown>;
  const retiring = value.retiring;
  if (retiring !== undefined && !Array.isArray(retiring)) {
    throw new Error("cloud validation state has invalid retiring grants");
  }
  const parsedRetiring = (retiring ?? []).map(parsePreviewGrantGeneration);
  if (parsedRetiring.length > 8) {
    throw new Error("cloud validation state has too many retiring grants");
  }
  return {
    ...current,
    ...(parsedRetiring.length > 0 ? { retiring: parsedRetiring } : {}),
  };
}

function parseEngineIngressGeneration(
  raw: unknown,
): CloudEngineIngressGeneration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud validation state has an invalid engine ingress");
  }
  const value = raw as Record<string, unknown>;
  if (
    !boundedString(value.generation, 64) ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(value.generation) ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.expiresAt) <= 0 ||
    value.port !== ENGINE_CLOUD_PORT ||
    !boundedString(value.token, 4_096) ||
    value.token.length < 16 ||
    /[\0\r\n]/.test(value.token)
  ) {
    throw new Error("cloud validation state has an invalid engine ingress");
  }
  return {
    generation: value.generation,
    expiresAt: Number(value.expiresAt),
    port: ENGINE_CLOUD_PORT,
    token: value.token,
  };
}

function parseEngineIngressCurrent(
  raw: unknown,
): Omit<CloudEngineIngressState, "retiring"> {
  const generation = parseEngineIngressGeneration(raw);
  const value = raw as Record<string, unknown>;
  if (!boundedString(value.url, 4_096)) {
    throw new Error("cloud validation state has an invalid engine ingress");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("cloud validation state has an invalid engine ingress");
  }
  const expectedHostPrefix = `${ENGINE_CLOUD_PORT}-${generation.token.toLowerCase()}`;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.hostname !== expectedHostPrefix &&
      !url.hostname.startsWith(`${expectedHostPrefix}.`))
  ) {
    throw new Error("cloud validation state has an invalid engine ingress");
  }
  return { ...generation, url: url.toString() };
}

function parseEngineIngressState(raw: unknown): CloudEngineIngressState {
  const current = parseEngineIngressCurrent(raw);
  const value = raw as Record<string, unknown>;
  const retiring = value.retiring;
  if (retiring !== undefined && !Array.isArray(retiring)) {
    throw new Error("cloud validation state has invalid retiring ingress");
  }
  const parsedRetiring = (retiring ?? []).map(parseEngineIngressGeneration);
  if (parsedRetiring.length > 8) {
    throw new Error(
      "cloud validation state has too many retiring ingress grants",
    );
  }
  return {
    ...current,
    ...(parsedRetiring.length > 0 ? { retiring: parsedRetiring } : {}),
  };
}

export function parseCloudValidationState(raw: unknown): CloudValidationState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud validation state is invalid");
  }
  const value = raw as Record<string, unknown>;
  let previewUrl: URL;
  try {
    previewUrl = new URL(String(value.previewUrl ?? ""));
  } catch {
    throw new Error("cloud validation state is invalid");
  }
  if (
    !boundedString(value.sandboxId, 256) ||
    !boundedString(value.previewUrl, 4_096) ||
    value.previewUrl.trim() !== value.previewUrl ||
    previewUrl.protocol !== "https:" ||
    previewUrl.username ||
    previewUrl.password ||
    !boundedString(value.previewToken, 4_096) ||
    !boundedString(value.cloudToken, 4_096) ||
    !boundedString(value.region, 64) ||
    !boundedString(value.createdAt, 64) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !boundedString(value.snapshotId, 256) ||
    !boundedString(value.snapshotImageName, 256) ||
    typeof value.runtimeAttestationSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.runtimeAttestationSha256)
  ) {
    throw new Error("cloud validation state is invalid");
  }
  const cloudPreview =
    value.cloudPreview === undefined
      ? undefined
      : parsePreviewGrantState(value.cloudPreview);
  const engineIngress =
    value.engineIngress === undefined
      ? undefined
      : parseEngineIngressState(value.engineIngress);
  let engineIngressTransition: CloudEngineIngressTransitionState | undefined;
  if (value.engineIngressTransition !== undefined) {
    if (
      !value.engineIngressTransition ||
      typeof value.engineIngressTransition !== "object" ||
      Array.isArray(value.engineIngressTransition)
    ) {
      throw new Error(
        "cloud validation state has an invalid ingress transition",
      );
    }
    const transition = value.engineIngressTransition as Record<string, unknown>;
    if (!Number.isSafeInteger(transition.startedAt)) {
      throw new Error(
        "cloud validation state has an invalid ingress transition",
      );
    }
    engineIngressTransition = {
      startedAt: Number(transition.startedAt),
      replacement: parseEngineIngressCurrent(transition.replacement),
    };
  }
  let cloudPreviewTransition: CloudPreviewTransitionState | undefined;
  if (value.cloudPreviewTransition !== undefined) {
    if (
      !value.cloudPreviewTransition ||
      typeof value.cloudPreviewTransition !== "object" ||
      Array.isArray(value.cloudPreviewTransition)
    ) {
      throw new Error("cloud validation state has an invalid transition");
    }
    const transition = value.cloudPreviewTransition as Record<string, unknown>;
    if (!Number.isSafeInteger(transition.startedAt)) {
      throw new Error("cloud validation state has an invalid transition");
    }
    cloudPreviewTransition = {
      startedAt: Number(transition.startedAt),
      replacement: parsePreviewGrantGeneration(transition.replacement),
    };
  }
  if (
    engineIngress &&
    (engineIngress.url !== previewUrl.toString() ||
      engineIngress.token !== value.previewToken)
  ) {
    throw new Error("cloud validation state engine ingress is inconsistent");
  }
  return {
    sandboxId: value.sandboxId,
    previewUrl: value.previewUrl,
    previewToken: value.previewToken,
    cloudToken: value.cloudToken,
    region: value.region,
    createdAt: value.createdAt,
    snapshotId: value.snapshotId,
    snapshotImageName: value.snapshotImageName,
    runtimeAttestationSha256: value.runtimeAttestationSha256,
    ...(engineIngress ? { engineIngress } : {}),
    ...(engineIngressTransition ? { engineIngressTransition } : {}),
    ...(cloudPreview ? { cloudPreview } : {}),
    ...(cloudPreviewTransition ? { cloudPreviewTransition } : {}),
  };
}

export interface CloudSnapshotAttestation {
  version: 1;
  snapshotId: string;
  snapshotName: string;
  snapshotImageName: string;
  snapshotState: string;
  baseImage: string;
  repositoryUrlSha256: string;
  repositoryRef: string;
  sourceCommit: string;
  imageContractSha256: string;
  bakedAt: string;
}

const configuredStateDirectory = process.env.ZEROS_CLOUD_VALIDATION_STATE_DIR;
if (configuredStateDirectory && !path.isAbsolute(configuredStateDirectory)) {
  throw new Error(
    "ZEROS_CLOUD_VALIDATION_STATE_DIR must be an absolute engine-private path outside the repository",
  );
}
const STATE_DIR = configuredStateDirectory
  ? path.normalize(configuredStateDirectory)
  : path.join(homedir(), ".zeros", "cloud-workspace-validation");
if (
  !path.isAbsolute(STATE_DIR) ||
  STATE_DIR === repoRoot ||
  STATE_DIR.startsWith(`${repoRoot}${path.sep}`)
) {
  throw new Error(
    "ZEROS_CLOUD_VALIDATION_STATE_DIR must be an absolute engine-private path outside the repository",
  );
}
const STATE_FILE = path.join(STATE_DIR, "state.json");
const SNAPSHOT_ATTESTATION_FILE = path.join(
  STATE_DIR,
  "snapshot-attestation.json",
);
const MUTATION_LOCK_DIR = path.join(STATE_DIR, "coordinator-mutation.lock");
export const RUNTIME_ATTESTATION_FILE = path.join(
  STATE_DIR,
  "runtime-attestation.json",
);

interface CloudMutationLockOptions {
  readonly lockDirectory?: string;
  readonly timeoutMs?: number;
  readonly pollMs?: number;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Serialize provider/root/state mutations across the operator coordinator,
 * reconnect test, and lifecycle harness. The nonce check prevents one process
 * from deleting a successor's lock after stale-owner recovery. */
export async function withCloudValidationMutationLock<T>(
  operation: () => Promise<T>,
  options: CloudMutationLockOptions = {},
): Promise<T> {
  const lockDirectory = options.lockDirectory ?? MUTATION_LOCK_DIR;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const pollMs = options.pollMs ?? 250;
  if (
    !path.isAbsolute(lockDirectory) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 10 ||
    pollMs > 5_000
  ) {
    throw new Error("cloud validation mutation lock options are invalid");
  }
  const parent = path.dirname(lockDirectory);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPrivateStateDirectory(parent);
  fs.chmodSync(parent, 0o700);
  const nonce = randomUUID();
  const ownerFile = path.join(lockDirectory, "owner.json");
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let created = false;
    try {
      fs.mkdirSync(lockDirectory, { mode: 0o700 });
      created = true;
      fs.writeFileSync(
        ownerFile,
        `${JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      break;
    } catch (error) {
      if (created) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.lstatSync(lockDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("cloud validation mutation lock is not a directory");
      }
      let ownerPid = 0;
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as {
          pid?: unknown;
        };
        ownerPid = Number(owner.pid);
      } catch {
        // A creator may be between mkdir and the owner write. Treat it as live
        // for a bounded grace period rather than racing its initialization.
      }
      if (!processIsAlive(ownerPid) && Date.now() - stat.mtimeMs > 30_000) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("cloud validation mutation lock timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    return await operation();
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8")) as {
        nonce?: unknown;
      };
      if (owner.nonce === nonce) {
        fs.rmSync(lockDirectory, { recursive: true, force: true });
      }
    } catch {
      // A missing/replaced lock is left untouched. Its owner or stale recovery
      // path is responsible for cleanup.
    }
  }
}
const LEGACY_STATE_FILES = [
  path.join(repoRoot, ".context", "cloud-workspace-validation", "state.json"),
  path.join(repoRoot, ".context", "cloud-spike", "state.json"),
];
const LEGACY_SNAPSHOT_ATTESTATION_FILES = [
  path.join(
    repoRoot,
    ".context",
    "cloud-workspace-validation",
    "snapshot-attestation.json",
  ),
  path.join(repoRoot, ".context", "cloud-spike", "snapshot-attestation.json"),
];

/** Atomically persist bearer-bearing state with owner-only permissions. */
export function saveState(
  state: CloudValidationState,
  stateFile: string = STATE_FILE,
): void {
  const normalized = parseCloudValidationState(state);
  const stateDir = path.dirname(stateFile);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  assertPrivateStateDirectory(stateDir);
  fs.chmodSync(stateDir, 0o700);

  const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, {
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

function assertPrivateStateDirectory(directory: string): void {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (uid !== null && stat.uid !== uid) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    fs.realpathSync(resolved) !== resolved
  ) {
    throw new Error("cloud private state directory is unsafe");
  }
}

function assertPrivateStateFile(file: string): void {
  const resolved = path.resolve(file);
  assertPrivateStateDirectory(path.dirname(resolved));
  const stat = fs.lstatSync(resolved);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (uid !== null && stat.uid !== uid) ||
    (process.platform !== "win32" && (stat.mode & 0o077) !== 0) ||
    fs.realpathSync(resolved) !== resolved
  ) {
    throw new Error("cloud validation state file is unsafe");
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function repositoryUrlSha256(): string {
  return sha256(ZEROS_REPO_URL);
}

export function imageContractSha256(): string {
  const files = [
    "config.ts",
    "image.ts",
    "Dockerfile",
    "sandbox/start-engine.sh",
    "sandbox/egress-probe.sh",
    "sandbox/cloud-worker.json",
    "sandbox/write-image-build-metadata.mjs",
    "sandbox/attest-cloud-worker.mjs",
    "sandbox/prepare-zsr-cgroups.mjs",
    "sandbox/consume-cloud-admission.mjs",
    "sandbox/install-cloud-preview-links.mjs",
    "sandbox/install-cloud-github-credential.mjs",
    "sandbox/cloud-github-refresh-request.mjs",
  ];
  return sha256(
    files
      .map((relative) => {
        const file = path.join(here, relative);
        return `${relative}\0${fs.readFileSync(file)}\0`;
      })
      .join(""),
  );
}

function savePrivateJson(value: unknown, file: string): void {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivateStateDirectory(directory);
  fs.chmodSync(directory, 0o700);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function saveSnapshotAttestation(
  attestation: CloudSnapshotAttestation,
  file: string = SNAPSHOT_ATTESTATION_FILE,
): void {
  savePrivateJson(attestation, file);
  console.log(`  ↳ wrote ${path.relative(repoRoot, file)} (owner-only)`);
}

export function loadSnapshotAttestation(
  file: string = SNAPSHOT_ATTESTATION_FILE,
): CloudSnapshotAttestation {
  if (file === SNAPSHOT_ATTESTATION_FILE && !fs.existsSync(file)) {
    const legacy = LEGACY_SNAPSHOT_ATTESTATION_FILES.find((candidate) =>
      fs.existsSync(candidate),
    );
    if (legacy) {
      const value = JSON.parse(
        fs.readFileSync(legacy, "utf8"),
      ) as CloudSnapshotAttestation;
      saveSnapshotAttestation(value, file);
      fs.rmSync(legacy, { force: true });
    }
  }
  if (!fs.existsSync(file)) {
    throw new Error(
      "snapshot attestation is missing; bake the current snapshot before provisioning",
    );
  }
  assertPrivateStateFile(file);
  fs.chmodSync(path.dirname(file), 0o700);
  fs.chmodSync(file, 0o600);
  return JSON.parse(fs.readFileSync(file, "utf8")) as CloudSnapshotAttestation;
}

export function snapshotAttestationExists(
  file: string = SNAPSHOT_ATTESTATION_FILE,
): boolean {
  return (
    fs.existsSync(file) ||
    (file === SNAPSHOT_ATTESTATION_FILE &&
      LEGACY_SNAPSHOT_ATTESTATION_FILES.some((candidate) =>
        fs.existsSync(candidate),
      ))
  );
}

export function clearSnapshotAttestation(
  file: string = SNAPSHOT_ATTESTATION_FILE,
): void {
  if (!fs.existsSync(file)) return;
  fs.rmSync(file, { force: true });
  try {
    fs.rmdirSync(path.dirname(file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "ENOENT") throw error;
  }
  console.log(`  ↳ removed ${path.relative(repoRoot, file)}`);
}

export function saveRuntimeAttestation(report: unknown): string {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  savePrivateJson(report, RUNTIME_ATTESTATION_FILE);
  console.log(
    `  ↳ wrote ${path.relative(repoRoot, RUNTIME_ATTESTATION_FILE)} (owner-only)`,
  );
  return sha256(serialized);
}

export function clearRuntimeAttestation(): void {
  if (fs.existsSync(RUNTIME_ATTESTATION_FILE)) {
    fs.rmSync(RUNTIME_ATTESTATION_FILE, { force: true });
  }
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
  if (stateFile === STATE_FILE && !fs.existsSync(stateFile)) {
    const legacyStateFile = LEGACY_STATE_FILES.find((file) =>
      fs.existsSync(file),
    );
    if (legacyStateFile) {
      const legacy = JSON.parse(
        fs.readFileSync(legacyStateFile, "utf8"),
      ) as CloudValidationState;
      saveState(legacy, STATE_FILE);
      clearState(legacyStateFile);
    }
  }

  if (!fs.existsSync(stateFile)) {
    console.error(
      `\n  ✗ No validation state at ${path.relative(repoRoot, stateFile)}.\n` +
        `    Run \`pnpm tsx scripts/cloud-workspace-validation/provision.ts\` first.\n`,
    );
    process.exit(1);
  }
  assertPrivateStateFile(stateFile);
  fs.chmodSync(path.dirname(stateFile), 0o700);
  fs.chmodSync(stateFile, 0o600);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    throw new Error("cloud validation state is invalid JSON");
  }
  return parseCloudValidationState(parsed);
}

/** Build the ws(s):// bridge URL from a preview URL.
 *  The Daytona preview proxy auto-upgrades `Upgrade: websocket`, so we swap the
 *  scheme and append `/ws`. Qualified browser ingress is a signed HOSTNAME (the
 *  provider's supported no-header form); the independent Zeros bearer rides as
 *  a WebSocket subprotocol and never enters the query/hash. */
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
