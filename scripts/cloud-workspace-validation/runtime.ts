import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  DaytonaConflictError,
  DaytonaNotFoundError,
  type Sandbox,
} from "@daytona/sdk";

import {
  CLOUD_ENGINE_INGRESS_TTL_SECONDS,
  ENGINE_CLOUD_PORT,
  CLOUD_PREVIEW_LINK_TTL_SECONDS,
  CLOUD_PREVIEW_PORTS,
  collectCloudAccountBindingEnv,
  healthUrl,
  imageContractSha256,
  NODE_BASE_IMAGE,
  repositoryUrlSha256,
  saveRuntimeAttestation,
  saveState,
  ZEROS_REPO_REF,
  type CloudSnapshotAttestation,
  type CloudEngineIngressGeneration,
  type CloudEngineIngressState,
  type CloudPreviewGrantState,
  type CloudPreviewGrantGeneration,
  type CloudValidationState,
} from "./config";
import { resolveQualifiedCloudGithubCredential } from "./github-coordinator";
import {
  sanitizeGithubCredential,
  type GithubAuthMethod,
  type GithubCredential,
} from "@zeros/protocol/github-auth";

const INSTALL_PREVIEW_LINKS_COMMAND =
  "/usr/local/bin/node /usr/local/lib/zeros/install-cloud-preview-links.mjs";
const INSTALL_GITHUB_CREDENTIAL_COMMAND =
  "/usr/local/bin/node /usr/local/lib/zeros/install-cloud-github-credential.mjs";
const READ_GITHUB_REFRESH_REQUEST_COMMAND =
  "/usr/local/bin/node /usr/local/lib/zeros/cloud-github-refresh-request.mjs read";
const ACK_GITHUB_REFRESH_REQUEST_COMMAND =
  "/usr/local/bin/node /usr/local/lib/zeros/cloud-github-refresh-request.mjs ack";
const PREVIEW_LINK_MINT_CONCURRENCY = 8;
const PREVIEW_REVOKE_ATTEMPTS = 3;
const MAX_RETIRING_PREVIEW_GENERATIONS = 8;

export interface InstallCloudPreviewLinksOptions {
  readonly ports?: readonly number[];
  readonly expiresInSeconds?: number;
  readonly now?: number;
  readonly generation?: string;
}

export interface RefreshCloudPreviewLinksOptions extends InstallCloudPreviewLinksOptions {
  readonly force?: boolean;
  readonly renewAheadMs?: number;
  readonly persist?: (state: CloudValidationState) => void;
}

export interface InstallCloudEngineIngressOptions {
  readonly expiresInSeconds?: number;
  readonly now?: number;
  readonly generation?: string;
}

export interface RefreshCloudEngineIngressOptions extends InstallCloudEngineIngressOptions {
  readonly force?: boolean;
  readonly renewAheadMs?: number;
  readonly persist?: (state: CloudValidationState) => void;
}

type CloudPreviewCoordinator = Pick<
  Sandbox,
  "expireSignedPreviewUrl" | "getSignedPreviewUrl" | "process"
>;

type CloudEngineIngressCoordinator = Pick<
  Sandbox,
  "expireSignedPreviewUrl" | "getSignedPreviewUrl"
>;

export interface InstallCloudGithubCredentialOptions {
  readonly now?: number;
  readonly expiresInSeconds?: number;
  readonly generation?: string;
}

export interface CloudGithubCredentialInput {
  readonly ownerSubject: string;
  readonly method?: GithubAuthMethod;
  readonly credential: GithubCredential | null;
}

export interface QualifiedCloudGithubRefreshRequest {
  readonly version: 1;
  readonly audience: "zeros-cloud-github-refresh-v1";
  readonly generation: string;
  readonly requestedAt: number;
  readonly ownerSubjectSha256: string;
  readonly method: GithubAuthMethod;
  readonly reason: "credential-invalid";
}

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function exactOwnerHash(candidate: string, ownerSubject: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(candidate)) return false;
  const expected = createHash("sha256").update(ownerSubject, "utf8").digest();
  return timingSafeEqual(Buffer.from(candidate, "hex"), expected);
}

/** Read the worker's root-owned, secret-free invalidation request. This is the
 * external coordinator's immediate rotation signal; no access credential is
 * returned by the helper or retained in cloud validation state. */
export async function readQualifiedCloudGithubRefreshRequest(
  sandbox: Pick<Sandbox, "process">,
  ownerSubject: string,
): Promise<QualifiedCloudGithubRefreshRequest | null> {
  if (
    ownerSubject.trim() !== ownerSubject ||
    ownerSubject.length < 1 ||
    ownerSubject.length > 512 ||
    /[\0\r\n]/.test(ownerSubject)
  ) {
    throw new Error("cloud GitHub refresh owner is invalid");
  }
  const response = await sandbox.process.executeCommand(
    READ_GITHUB_REFRESH_REQUEST_COMMAND,
    undefined,
    undefined,
    15,
  );
  const output = response.result || response.artifacts?.stdout || "";
  if (response.exitCode !== 0 || Buffer.byteLength(output, "utf8") > 8 * 1024) {
    throw new Error("cloud GitHub refresh request read failed");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  const value = raw as Record<string, unknown>;
  if (
    !exactObjectKeys(value, [
      "audience",
      "generation",
      "method",
      "ownerSubjectSha256",
      "reason",
      "requestedAt",
      "version",
    ]) ||
    value.version !== 1 ||
    value.audience !== "zeros-cloud-github-refresh-v1" ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(value.generation) ||
    !Number.isSafeInteger(value.requestedAt) ||
    Number(value.requestedAt) <= 0 ||
    typeof value.ownerSubjectSha256 !== "string" ||
    !exactOwnerHash(value.ownerSubjectSha256, ownerSubject) ||
    !["gh-cli", "github-app", "pat"].includes(String(value.method)) ||
    value.reason !== "credential-invalid"
  ) {
    throw new Error("cloud GitHub refresh request is invalid");
  }
  return {
    version: 1,
    audience: "zeros-cloud-github-refresh-v1",
    generation: value.generation,
    requestedAt: Number(value.requestedAt),
    ownerSubjectSha256: value.ownerSubjectSha256,
    method: value.method as GithubAuthMethod,
    reason: "credential-invalid",
  };
}

export async function acknowledgeQualifiedCloudGithubRefreshRequest(
  sandbox: Pick<Sandbox, "process">,
  generation: string,
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(generation)) {
    throw new Error("cloud GitHub refresh generation is invalid");
  }
  const response = await sandbox.process.executeCommand(
    ACK_GITHUB_REFRESH_REQUEST_COMMAND,
    undefined,
    { ZEROS_CLOUD_GITHUB_REFRESH_GENERATION: generation },
    15,
  );
  const output = (response.result || response.artifacts?.stdout || "").trim();
  if (response.exitCode !== 0 || !["acknowledged", "stale"].includes(output)) {
    throw new Error("cloud GitHub refresh acknowledgement failed");
  }
  return output === "acknowledged";
}

/** Publish only a short-lived working credential to the root-only runtime
 * projection. Refresh credentials and account JWTs never enter the worker. */
export async function installQualifiedCloudGithubCredential(
  sandbox: Pick<Sandbox, "process">,
  input: CloudGithubCredentialInput,
  options: InstallCloudGithubCredentialOptions = {},
): Promise<{
  generation: string;
  expiresAt: number;
  method: GithubAuthMethod;
  configured: boolean;
}> {
  const now = options.now ?? Date.now();
  const expiresInSeconds = options.expiresInSeconds ?? 24 * 60 * 60;
  const generation =
    options.generation ?? randomBytes(24).toString("base64url");
  const ownerSubject = input.ownerSubject.trim();
  const credential = sanitizeGithubCredential(input.credential);
  const method = credential?.method ?? input.method ?? "pat";
  if (
    ownerSubject !== input.ownerSubject ||
    ownerSubject.length < 1 ||
    ownerSubject.length > 512 ||
    /[\0\r\n]/.test(ownerSubject) ||
    !["gh-cli", "github-app", "pat"].includes(method) ||
    !Number.isSafeInteger(now) ||
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 60 ||
    expiresInSeconds > 86_400 ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(generation) ||
    (input.credential !== null && !credential) ||
    (credential !== null &&
      (credential.method !== method ||
        credential.gitHost !== "github.com" ||
        credential.gitHttpUsername !== "x-access-token"))
  ) {
    throw new Error("cloud GitHub credential projection input is invalid");
  }
  let expiresAt = now + expiresInSeconds * 1_000;
  if (credential?.method === "github-app") {
    if (!credential.expiresAtMs || credential.expiresAtMs - now < 60_000) {
      throw new Error("cloud GitHub App working credential is too near expiry");
    }
    expiresAt = Math.min(expiresAt, credential.expiresAtMs);
  }
  const projectedCredential =
    credential?.method === "github-app"
      ? {
          method: credential.method,
          accessToken: credential.accessToken,
          gitHost: credential.gitHost,
          gitHttpUsername: credential.gitHttpUsername,
          ...(credential.login ? { login: credential.login } : {}),
          expiresAtMs: credential.expiresAtMs,
          ...(credential.variantKey
            ? { variantKey: credential.variantKey }
            : {}),
        }
      : credential;
  const document = {
    version: 1,
    audience: "zeros-cloud-github-credential-v1",
    generation,
    issuedAt: now,
    expiresAt,
    ownerSubjectSha256: createHash("sha256")
      .update(ownerSubject, "utf8")
      .digest("hex"),
    method,
    credential: projectedCredential,
  };
  const encoded = Buffer.from(JSON.stringify(document)).toString("base64url");
  const result = await sandbox.process.executeCommand(
    INSTALL_GITHUB_CREDENTIAL_COMMAND,
    undefined,
    {
      ZEROS_CLOUD_GITHUB_CREDENTIAL_B64: encoded,
      ZEROS_CLOUD_OWNER_SUB: ownerSubject,
    },
    30,
  );
  if (result.exitCode !== 0) {
    throw new Error("cloud GitHub credential installation failed");
  }
  return {
    generation,
    expiresAt,
    method,
    configured: credential !== null,
  };
}

function validateSignedPreview(
  raw: Awaited<
    ReturnType<CloudEngineIngressCoordinator["getSignedPreviewUrl"]>
  >,
  port: number,
): { readonly port: number; readonly token: string; readonly url: string } {
  if (
    raw.port !== port ||
    typeof raw.token !== "string" ||
    raw.token.length < 16 ||
    raw.token.length > 4_096 ||
    /[\0\r\n]/.test(raw.token) ||
    typeof raw.url !== "string" ||
    Buffer.byteLength(raw.url, "utf8") > 4_096
  ) {
    throw new Error("provider returned an invalid signed preview link");
  }
  let url: URL;
  try {
    url = new URL(raw.url);
  } catch {
    throw new Error("provider returned an unsafe signed preview link");
  }
  const expectedHostPrefix = `${port}-${raw.token.toLowerCase()}`;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.hash ||
    url.search ||
    (url.hostname !== expectedHostPrefix &&
      !url.hostname.startsWith(`${expectedHostPrefix}.`))
  ) {
    throw new Error("provider returned an unsafe signed preview link");
  }
  return { port, token: raw.token, url: url.toString() };
}

function validateEngineIngressOptions(
  options: InstallCloudEngineIngressOptions,
): {
  readonly expiresInSeconds: number;
  readonly now: number;
  readonly generation: string;
} {
  const expiresInSeconds =
    options.expiresInSeconds ?? CLOUD_ENGINE_INGRESS_TTL_SECONDS;
  const now = options.now ?? Date.now();
  const generation =
    options.generation ?? randomBytes(24).toString("base64url");
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 60 ||
    expiresInSeconds > 86_400 ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(generation)
  ) {
    throw new Error("cloud engine ingress options are invalid");
  }
  return { expiresInSeconds, now, generation };
}

/** Mint the browser form of Daytona ingress. Standard preview links require an
 * x-daytona-preview-token header, which the browser WebSocket API cannot set;
 * a signed preview URL places its revocable capability in the hostname and
 * therefore leaves the request target/query clean. */
export async function installQualifiedCloudEngineIngress(
  sandbox: CloudEngineIngressCoordinator,
  rawOptions: InstallCloudEngineIngressOptions = {},
): Promise<CloudEngineIngressState> {
  const options = validateEngineIngressOptions(rawOptions);
  const signed = validateSignedPreview(
    await sandbox.getSignedPreviewUrl(
      ENGINE_CLOUD_PORT,
      options.expiresInSeconds,
    ),
    ENGINE_CLOUD_PORT,
  );
  return {
    generation: options.generation,
    expiresAt: options.now + options.expiresInSeconds * 1_000,
    port: ENGINE_CLOUD_PORT,
    token: signed.token,
    url: signed.url,
  };
}

async function revokeEngineIngressGenerations(
  sandbox: Pick<Sandbox, "expireSignedPreviewUrl">,
  generations: readonly CloudEngineIngressGeneration[],
): Promise<void> {
  const unique = new Map<string, CloudEngineIngressGeneration>();
  for (const generation of generations) {
    unique.set(`${generation.port}\0${generation.token}`, generation);
  }
  const results = await Promise.allSettled(
    [...unique.values()].map(async ({ port, token }) => {
      for (let attempt = 0; attempt < PREVIEW_REVOKE_ATTEMPTS; attempt += 1) {
        try {
          await sandbox.expireSignedPreviewUrl(port, token);
          return;
        } catch (error) {
          if (error instanceof DaytonaNotFoundError) return;
          if (attempt + 1 === PREVIEW_REVOKE_ATTEMPTS) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 25 * 2 ** attempt),
          );
        }
      }
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "one or more cloud engine ingress grants could not be revoked",
    );
  }
}

export async function revokeCloudEngineIngressState(
  sandbox: Pick<Sandbox, "expireSignedPreviewUrl">,
  state: Pick<
    CloudValidationState,
    "engineIngress" | "engineIngressTransition"
  >,
): Promise<void> {
  const current = state.engineIngress;
  await revokeEngineIngressGenerations(sandbox, [
    ...(current ? [current, ...(current.retiring ?? [])] : []),
    ...(state.engineIngressTransition
      ? [state.engineIngressTransition.replacement]
      : []),
  ]);
}

function engineIngressGeneration(
  state: CloudEngineIngressState,
): CloudEngineIngressGeneration {
  return {
    generation: state.generation,
    expiresAt: state.expiresAt,
    port: state.port,
    token: state.token,
  };
}

/** Crash-safe signed-engine-ingress rotation. The new capability is journaled
 * before publication. The prior generation remains revocable and naturally
 * expires, allowing already-open renderers time to receive the new descriptor. */
export async function refreshQualifiedCloudEngineIngress(
  sandbox: CloudEngineIngressCoordinator,
  inputState: CloudValidationState,
  options: RefreshCloudEngineIngressOptions = {},
): Promise<CloudValidationState> {
  const persist = options.persist ?? saveState;
  const now = options.now ?? Date.now();
  const renewAheadMs = options.renewAheadMs ?? 6 * 60 * 60_000;
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(renewAheadMs) ||
    renewAheadMs < 60_000 ||
    renewAheadMs >= CLOUD_ENGINE_INGRESS_TTL_SECONDS * 1_000
  ) {
    throw new Error("cloud engine ingress renewal options are invalid");
  }

  let state = inputState;
  if (state.engineIngressTransition) {
    await revokeEngineIngressGenerations(sandbox, [
      state.engineIngressTransition.replacement,
    ]);
    state = { ...state, engineIngressTransition: undefined };
    persist(state);
  }
  if (
    !options.force &&
    state.engineIngress &&
    state.engineIngress.expiresAt - now > renewAheadMs
  ) {
    return state;
  }

  const replacement = await installQualifiedCloudEngineIngress(
    sandbox,
    options,
  );
  const transitionState: CloudValidationState = {
    ...state,
    engineIngressTransition: {
      startedAt: now,
      replacement,
    },
  };
  try {
    persist(transitionState);
  } catch (error) {
    await revokeEngineIngressGenerations(sandbox, [replacement]).catch(
      () => undefined,
    );
    throw error;
  }

  try {
    const retiring = [
      ...(state.engineIngress?.retiring ?? []),
      ...(state.engineIngress
        ? [engineIngressGeneration(state.engineIngress)]
        : []),
    ].filter((generation) => generation.expiresAt > now);
    if (retiring.length > MAX_RETIRING_PREVIEW_GENERATIONS) {
      throw new Error("too many cloud engine ingress generations are draining");
    }
    const engineIngress: CloudEngineIngressState = {
      ...replacement,
      ...(retiring.length > 0 ? { retiring } : {}),
    };
    const ready: CloudValidationState = {
      ...state,
      previewUrl: engineIngress.url,
      previewToken: engineIngress.token,
      engineIngress,
      engineIngressTransition: undefined,
    };
    persist(ready);
    return ready;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await revokeEngineIngressGenerations(sandbox, [replacement]);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      persist({ ...state, engineIngressTransition: undefined });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new AggregateError(
      failures,
      "cloud engine ingress rotation failed and was rolled back",
    );
  }
}

export interface QualifiedCloudRuntimeTarget {
  readonly kind: "cloud";
  readonly url: string;
  readonly cloudToken: string;
  readonly expiresAt: number;
}

/** Convert owner-only provider state into the memory-only renderer descriptor.
 * No provider revocation token is copied: signed ingress is already encoded in
 * the hostname and the independent Zeros bearer rides as a WS subprotocol. */
export function cloudRuntimeTargetFromValidationState(
  state: CloudValidationState,
  now: number = Date.now(),
): QualifiedCloudRuntimeTarget {
  const ingress = state.engineIngress;
  if (
    !ingress ||
    !Number.isSafeInteger(now) ||
    ingress.expiresAt - now < 5_000 ||
    typeof state.cloudToken !== "string" ||
    state.cloudToken.length < 16 ||
    Buffer.byteLength(state.cloudToken, "utf8") > 4_096 ||
    /[\0\r\n]/.test(state.cloudToken)
  ) {
    throw new Error("qualified cloud runtime target is unavailable");
  }
  const url = new URL(ingress.url);
  url.protocol = "wss:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return {
    kind: "cloud",
    url: url.toString(),
    cloudToken: state.cloudToken,
    expiresAt: ingress.expiresAt,
  };
}

function validatePreviewMintOptions(options: InstallCloudPreviewLinksOptions): {
  ports: readonly number[];
  expiresInSeconds: number;
  now: number;
  generation: string;
} {
  const ports = options.ports ?? CLOUD_PREVIEW_PORTS;
  const expiresInSeconds =
    options.expiresInSeconds ?? CLOUD_PREVIEW_LINK_TTL_SECONDS;
  const now = options.now ?? Date.now();
  const generation =
    options.generation ?? randomBytes(24).toString("base64url");
  if (
    ports.length < 1 ||
    ports.length > 64 ||
    new Set(ports).size !== ports.length ||
    ports.some(
      (port) => !Number.isInteger(port) || port < 1 || port > 65_535,
    ) ||
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 60 ||
    expiresInSeconds > 86_400 ||
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(generation)
  ) {
    throw new Error("cloud preview mint options are invalid");
  }
  return { ports, expiresInSeconds, now, generation };
}

export async function revokeCloudPreviewLinks(
  sandbox: CloudPreviewCoordinator,
  grant: CloudPreviewGrantState | undefined,
): Promise<void> {
  if (!grant) return;
  const generations = [grant, ...(grant.retiring ?? [])];
  const unique = new Map<string, { port: number; token: string }>();
  for (const generation of generations) {
    for (const item of generation.grants) {
      unique.set(`${item.port}\0${item.token}`, item);
    }
  }
  const results = await Promise.allSettled(
    [...unique.values()].map(async ({ port, token }) => {
      for (let attempt = 0; attempt < PREVIEW_REVOKE_ATTEMPTS; attempt += 1) {
        try {
          await sandbox.expireSignedPreviewUrl(port, token);
          return;
        } catch (error) {
          // Provider expiry is idempotent from the coordinator's perspective.
          if (error instanceof DaytonaNotFoundError) return;
          if (attempt + 1 === PREVIEW_REVOKE_ATTEMPTS) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 25 * 2 ** attempt),
          );
        }
      }
    }),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error("one or more cloud preview grants could not be revoked");
  }
}

export async function revokeCloudPreviewState(
  sandbox: CloudPreviewCoordinator,
  state: Pick<CloudValidationState, "cloudPreview" | "cloudPreviewTransition">,
): Promise<void> {
  const grants = [
    state.cloudPreview,
    state.cloudPreviewTransition
      ? { ...state.cloudPreviewTransition.replacement }
      : undefined,
  ].filter((grant): grant is CloudPreviewGrantState => Boolean(grant));
  const results = await Promise.allSettled(
    grants.map((grant) => revokeCloudPreviewLinks(sandbox, grant)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "one or more cloud preview generations could not be revoked",
    );
  }
}

function currentGrantGeneration(
  grant: CloudPreviewGrantState,
): CloudPreviewGrantGeneration {
  return {
    generation: grant.generation,
    expiresAt: grant.expiresAt,
    grants: grant.grants,
  };
}

/** Atomically publish a freshly minted root document while retaining provider
 * revocation coordinates for the prior generation. Existing frames can keep
 * using their old signed origin until their scheduled re-admission; the ZSR
 * gateway invalidates its old inner cookie as soon as that re-admission occurs. */
export async function rotateQualifiedCloudPreviewLinks(
  sandbox: CloudPreviewCoordinator,
  previous: CloudPreviewGrantState,
  rawOptions: InstallCloudPreviewLinksOptions = {},
): Promise<CloudPreviewGrantState> {
  const now = rawOptions.now ?? Date.now();
  const retiring = [
    ...(previous.retiring ?? []),
    currentGrantGeneration(previous),
  ].filter((generation) => generation.expiresAt > now);
  if (retiring.length > MAX_RETIRING_PREVIEW_GENERATIONS) {
    throw new Error("too many cloud preview generations are still draining");
  }
  const replacement = await installQualifiedCloudPreviewLinks(
    sandbox,
    rawOptions,
  );
  return {
    ...replacement,
    ...(retiring.length > 0 ? { retiring } : {}),
  };
}

interface MintedCloudPreviewLinks {
  readonly grant: CloudPreviewGrantState;
  readonly encodedDocument: string;
}

async function mintQualifiedCloudPreviewLinks(
  sandbox: CloudPreviewCoordinator,
  rawOptions: InstallCloudPreviewLinksOptions = {},
): Promise<MintedCloudPreviewLinks> {
  const options = validatePreviewMintOptions(rawOptions);
  const minted: Array<{
    port: number;
    token: string;
    signedUrl: string;
  }> = [];
  let cursor = 0;
  let failure: unknown;

  const workers = Array.from(
    {
      length: Math.min(PREVIEW_LINK_MINT_CONCURRENCY, options.ports.length),
    },
    async () => {
      for (;;) {
        if (failure) return;
        const index = cursor;
        cursor += 1;
        if (index >= options.ports.length) return;
        const port = options.ports[index];
        try {
          const signed = await sandbox.getSignedPreviewUrl(
            port,
            options.expiresInSeconds,
          );
          const admission = validateSignedPreview(signed, port);
          minted[index] = {
            port,
            token: admission.token,
            signedUrl: admission.url,
          };
        } catch (error) {
          failure ??= error;
        }
      }
    },
  );
  await Promise.all(workers);

  const grant: CloudPreviewGrantState = {
    generation: options.generation,
    expiresAt: options.now + options.expiresInSeconds * 1_000,
    grants: minted.filter(Boolean).map(({ port, token }) => ({ port, token })),
  };
  if (failure || minted.length !== options.ports.length) {
    await revokeCloudPreviewLinks(sandbox, grant).catch(() => undefined);
    throw new Error("cloud preview ingress links could not be minted");
  }

  const document = {
    version: 1,
    audience: "zeros-cloud-preview-v1",
    generation: grant.generation,
    issuedAt: options.now,
    expiresAt: grant.expiresAt,
    links: minted.map(({ port, signedUrl }) => ({
      port,
      signedUrl,
    })),
  };
  return {
    grant,
    encodedDocument: Buffer.from(JSON.stringify(document)).toString(
      "base64url",
    ),
  };
}

async function publishCloudPreviewLinks(
  sandbox: CloudPreviewCoordinator,
  encodedDocument: string,
): Promise<void> {
  const result = await sandbox.process.executeCommand(
    INSTALL_PREVIEW_LINKS_COMMAND,
    undefined,
    { ZEROS_CLOUD_PREVIEW_LINKS_B64: encodedDocument },
    30,
  );
  if (result.exitCode !== 0) {
    throw new Error("root helper rejected cloud preview links");
  }
}

/** Mint provider bearers in the trusted external coordinator, then pass only
 * a bounded signed-link document to an immutable root helper. The Daytona API
 * key never enters the sandbox or engine process. */
export async function installQualifiedCloudPreviewLinks(
  sandbox: CloudPreviewCoordinator,
  rawOptions: InstallCloudPreviewLinksOptions = {},
): Promise<CloudPreviewGrantState> {
  const minted = await mintQualifiedCloudPreviewLinks(sandbox, rawOptions);
  try {
    await publishCloudPreviewLinks(sandbox, minted.encodedDocument);
  } catch {
    await revokeCloudPreviewLinks(sandbox, minted.grant).catch(() => undefined);
    throw new Error("cloud preview ingress installation failed");
  }
  return minted.grant;
}

function withRetiringGeneration(
  replacement: CloudPreviewGrantState,
  previous: CloudPreviewGrantState | undefined,
  now: number,
): CloudPreviewGrantState {
  if (!previous) return replacement;
  const retiring = [
    ...(previous.retiring ?? []),
    currentGrantGeneration(previous),
  ].filter((generation) => generation.expiresAt > now);
  if (retiring.length > MAX_RETIRING_PREVIEW_GENERATIONS) {
    throw new Error("too many cloud preview generations are still draining");
  }
  return {
    ...replacement,
    ...(retiring.length > 0 ? { retiring } : {}),
  };
}

/** Crash-safe long-running coordinator step. A bearer-bearing transition is
 * owner-only journaled before the root document changes. On restart an
 * interrupted replacement is revoked first, so no untracked signed origin is
 * left behind even if the process died between remote install and local save. */
export async function refreshQualifiedCloudPreviewLinks(
  sandbox: CloudPreviewCoordinator,
  inputState: CloudValidationState,
  options: RefreshCloudPreviewLinksOptions = {},
): Promise<CloudValidationState> {
  const persist = options.persist ?? saveState;
  const now = options.now ?? Date.now();
  const renewAheadMs = options.renewAheadMs ?? 6 * 60 * 60_000;
  if (
    !Number.isSafeInteger(now) ||
    now <= 0 ||
    !Number.isSafeInteger(renewAheadMs) ||
    renewAheadMs < 60_000 ||
    renewAheadMs >= CLOUD_PREVIEW_LINK_TTL_SECONDS * 1_000
  ) {
    throw new Error("cloud preview renewal options are invalid");
  }

  let state = inputState;
  if (state.cloudPreviewTransition) {
    await revokeCloudPreviewLinks(sandbox, {
      ...state.cloudPreviewTransition.replacement,
    });
    state = { ...state, cloudPreviewTransition: undefined };
    persist(state);
  }
  if (
    !options.force &&
    state.cloudPreview &&
    state.cloudPreview.expiresAt - now > renewAheadMs
  ) {
    return state;
  }

  const minted = await mintQualifiedCloudPreviewLinks(sandbox, options);
  const transitionState: CloudValidationState = {
    ...state,
    cloudPreviewTransition: {
      startedAt: now,
      replacement: currentGrantGeneration(minted.grant),
    },
  };
  try {
    persist(transitionState);
  } catch (error) {
    await revokeCloudPreviewLinks(sandbox, minted.grant).catch(() => undefined);
    throw error;
  }

  try {
    await publishCloudPreviewLinks(sandbox, minted.encodedDocument);
    const cloudPreview = withRetiringGeneration(
      minted.grant,
      state.cloudPreview,
      now,
    );
    const ready: CloudValidationState = {
      ...state,
      cloudPreview,
      cloudPreviewTransition: undefined,
    };
    persist(ready);
    return ready;
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await revokeCloudPreviewLinks(sandbox, minted.grant);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      persist({ ...state, cloudPreviewTransition: undefined });
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new AggregateError(
      failures,
      "cloud preview rotation failed and was rolled back",
    );
  }
}

export interface RuntimeAttestation {
  readonly version?: number;
  readonly qualified?: boolean;
  readonly profile?: string;
  readonly metadata?: {
    readonly build?: {
      readonly baseImage?: string;
      readonly imageContractSha256?: string;
      readonly source?: {
        readonly repositoryUrlSha256?: string;
        readonly ref?: string;
        readonly commit?: string;
      };
    };
  };
  readonly resources?: {
    readonly finite?: boolean;
  };
  readonly qualification?: { readonly secure?: boolean };
}

export function assertCloudStateMatchesSnapshot(
  state: CloudValidationState,
  snapshot: CloudSnapshotAttestation,
): void {
  if (
    snapshot.version !== 1 ||
    state.snapshotId !== snapshot.snapshotId ||
    state.snapshotImageName !== snapshot.snapshotImageName
  ) {
    throw new Error(
      "cloud validation state has a stale snapshot identity; reprovision it",
    );
  }
}

export function verifyCloudRuntimeAttestation(
  report: RuntimeAttestation,
  expectedSourceCommit: string,
  exitCode: number,
): void {
  if (
    exitCode !== 0 ||
    report.version !== 1 ||
    report.qualified !== true ||
    report.profile !== "zeros-cloud-worker-v1" ||
    report.metadata?.build?.baseImage !== NODE_BASE_IMAGE ||
    report.metadata.build.imageContractSha256 !== imageContractSha256() ||
    report.metadata.build.source?.repositoryUrlSha256 !==
      repositoryUrlSha256() ||
    report.metadata.build.source.ref !== ZEROS_REPO_REF ||
    report.metadata.build.source.commit !== expectedSourceCommit ||
    report.resources?.finite !== true ||
    report.qualification?.secure !== true
  ) {
    throw new Error("cloud worker failed image/runtime qualification");
  }
}

/** Re-run the in-image attack harness and bind the report to the exact source
 * snapshot. Call this after every cold start before relaunching the privileged
 * coordinator; RAM loss invalidates the prior live-canary evidence. */
export async function attestCloudWorker(
  sandbox: Pick<Sandbox, "process">,
  expectedSourceCommit: string,
): Promise<{ report: RuntimeAttestation; sha256: string }> {
  const response = await sandbox.process.executeCommand(
    "/usr/local/bin/node /usr/local/lib/zeros/attest-cloud-worker.mjs",
    undefined,
    undefined,
    // The in-image harness has its own 180s qualification timeout plus image
    // trust checks. The provider RPC must not race that inner bound.
    360,
  );
  const output = response.result || response.artifacts?.stdout || "";
  let report: RuntimeAttestation;
  try {
    report = JSON.parse(output) as RuntimeAttestation;
  } catch {
    throw new Error("cloud worker returned malformed attestation output");
  }
  verifyCloudRuntimeAttestation(
    report,
    expectedSourceCommit,
    response.exitCode,
  );
  return { report, sha256: saveRuntimeAttestation(report) };
}

export async function waitForCloudHealth(
  previewUrl: string,
  previewToken?: string,
  tries = 40,
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    try {
      const response = await fetch(healthUrl(previewUrl), {
        ...(previewToken
          ? { headers: { "x-daytona-preview-token": previewToken } }
          : {}),
      });
      if (
        response.ok &&
        ((await response.json()) as { status?: string }).status === "ok"
      ) {
        return true;
      }
    } catch {
      // The engine or provider preview route is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return false;
}

async function ensureEngineSession(sandbox: Pick<Sandbox, "process">) {
  try {
    await sandbox.process.createSession("zeros-engine");
  } catch (error) {
    if (!(error instanceof DaytonaConflictError)) throw error;
    // A provider session record may survive a stopped/archived transition even
    // though its process did not. Prove the record exists before reusing it.
    await sandbox.process.getSession("zeros-engine");
  }
}

/** Secure cold-start controller used by every validation restart path. It
 * attests first, launches the immutable coordinator second, rotates preview
 * coordinates, waits for health, and only then publishes connection state. */
export async function relaunchQualifiedCloudEngine(
  sandbox: Pick<
    Sandbox,
    "expireSignedPreviewUrl" | "getSignedPreviewUrl" | "process"
  >,
  state: CloudValidationState,
  snapshot: CloudSnapshotAttestation,
): Promise<CloudValidationState> {
  assertCloudStateMatchesSnapshot(state, snapshot);
  const runtimeAttestation = await attestCloudWorker(
    sandbox,
    snapshot.sourceCommit,
  );
  const accountBinding = collectCloudAccountBindingEnv();
  const githubCredential = await resolveQualifiedCloudGithubCredential();
  await installQualifiedCloudGithubCredential(sandbox, {
    ownerSubject: accountBinding.ZEROS_CLOUD_OWNER_SUB,
    credential: githubCredential,
    method: githubCredential?.method ?? "pat",
  });
  // A stopped/archived worker has no live preview façade. Revoke the prior
  // provider grants before installing a fresh root document, so stale signed
  // URLs never regain reachability when the fixed ingress ports bind again.
  await Promise.all([
    revokeCloudPreviewState(sandbox, state),
    revokeCloudEngineIngressState(sandbox, state),
  ]);
  const cloudPreview = await installQualifiedCloudPreviewLinks(sandbox);
  const engineIngress = await installQualifiedCloudEngineIngress(sandbox);
  await ensureEngineSession(sandbox);
  try {
    await sandbox.process.executeSessionCommand("zeros-engine", {
      command: "/usr/local/bin/start-engine.sh",
      runAsync: true,
    });
    if (!(await waitForCloudHealth(engineIngress.url))) {
      throw new Error(
        "qualified cloud engine did not become healthy after wake",
      );
    }
  } catch (error) {
    await Promise.all([
      revokeCloudPreviewLinks(sandbox, cloudPreview).catch(() => undefined),
      revokeCloudEngineIngressState(sandbox, { engineIngress }).catch(
        () => undefined,
      ),
    ]);
    throw error;
  }
  const refreshed: CloudValidationState = {
    ...state,
    previewUrl: engineIngress.url,
    previewToken: engineIngress.token,
    runtimeAttestationSha256: runtimeAttestation.sha256,
    engineIngress,
    engineIngressTransition: undefined,
    cloudPreview,
  };
  saveState(refreshed);
  return refreshed;
}
