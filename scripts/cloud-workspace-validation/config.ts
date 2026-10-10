// Shared source identity for Boat image builds and portable OCI publication.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeGithubCredential, type GithubCredential } from "@zeros/protocol/github-auth";
import runtimeLayout from "./sandbox/runtime-layout.json" with { type: "json" };
const here = path.dirname(fileURLToPath(import.meta.url));
function optEnv(name: string, fallback: string): string { return process.env[name]?.trim() || fallback; }

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

export const SANDBOX_ENGINE_DIR = runtimeLayout.engine;
/** Writable validation checkout served by the engine. This deliberately
 * differs from SANDBOX_ENGINE_DIR so an agent cannot replace its supervisor. */
export const SANDBOX_REPO_DIR = runtimeLayout.repository;
/** Engine database/control state. Its0700 VM10003 ownership is shared by same-user agents. */
export const SANDBOX_DATA_DIR = runtimeLayout.data;
export const SANDBOX_ENGINE_LOG = runtimeLayout.log;
export const SANDBOX_AGENT_HOME = runtimeLayout.agentHome;
export const SANDBOX_CAPTURE_HOME = runtimeLayout.captureHome;
export const SANDBOX_AGENT_UID = 10_003;
export const SANDBOX_AGENT_GID = 10_003;


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

/** Read an operator-provided cloud GitHub working copy. It is passed once to
 * the immutable root installer; callers must never merge it into sandbox env
 * or private qualification state. */
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
    "sandbox/runtime-layout.json",
    "sandbox/prepare-cloud-image-files.mjs",
    "sandbox/cgroup-resources.mjs",
    "sandbox/cloud-resource-admission.mjs",
    "sandbox/image-build-contract.mjs",
    "sandbox/cloud-setup-process.mjs",
    "sandbox/cloud-runtime-profile.mjs",
    "sandbox/cloud-engine-cgroup.mjs",
    "sandbox/cloud-engine-view.mjs",
    "sandbox/cloud-engine-launcher.mjs",
    "sandbox/cloud-engine-namespace.c",
    "sandbox/zeros-cloud-engine.apparmor",
    "sandbox/qualify-cloud-engine.mjs",
    "lib/native-qualification-input.ts",
    "sandbox/qualify-cloud-capture.ts",
    "sandbox/qualify-cloud-human-services.ts",
    "sandbox/qualify-cloud-actor-tools.ts",
    "sandbox/write-image-build-metadata.mjs",
    "sandbox/attest-cloud-worker.mjs",
    "sandbox/consume-cloud-admission.mjs",
    "sandbox/install-cloud-preview-links.mjs",
    "sandbox/install-cloud-github-credential.mjs",
    "sandbox/cloud-github-refresh-request.mjs",
    "sandbox/cloud-git-askpass.mjs",
    "sandbox/cloud-worker-supervisor.mjs",
    "sandbox/ensure-cloud-worker-supervisor.mjs",
    "sandbox/setup-cloud-workspace.mjs",
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
