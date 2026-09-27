import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { sha256 } from "./state.mjs";

const OWNER = /^[a-f0-9]{24}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEY = /^[a-f0-9]{64}$/;
export const LEASE_MS = 120_000;

export function hostedName(state) {
  if (!OWNER.test(state.owner) || !UUID.test(state.generation)) throw new Error("Invalid Dev resource identity");
  return `dev-${state.owner}-${state.generation.replaceAll("-", "")}`;
}

export function newHostedGeneration(identity, previous, now = Date.now()) {
  if (!OWNER.test(identity.owner) || (previous && (previous.owner !== identity.owner || previous.status !== "archived"))) {
    throw new Error("Finish the previous Dev archive before starting a fresh generation");
  }
  return {
    version: 1, owner: identity.owner, identity: identity.identity,
    generation: randomUUID(), status: "provisioning", createdAt: new Date(now).toISOString(),
    keys: Object.fromEntries(["cookie", "settings", "objects", "provider", "agent"].map(k => [k, randomBytes(32).toString("hex")])),
    resources: {}, steps: {},
    ...(previous ? { previous: { generation: previous.generation, archivedAt: previous.archivedAt },
      pendingBuilderDeletions: structuredClone(previous.pendingBuilderDeletions ?? []) } : {}),
  };
}

function validate(record, owner) {
  if (record?.version !== 1 || record.owner !== owner || !UUID.test(record.generation ?? "") ||
      !["provisioning", "ready", "archiving", "archived"].includes(record.status) || !record.resources || !record.steps ||
      (record.status !== "archived" && !["cookie", "settings", "objects", "provider", "agent"].every(k => KEY.test(record.keys?.[k] ?? "")))) {
    throw new Error("Invalid hosted Dev ownership receipt; remote resources were preserved");
  }
  return record;
}

export function sealReceipt(record, key) {
  if (!KEY.test(key ?? "")) throw new Error("registry.encryptionKey must contain 32 random bytes as hex");
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from(`zeros-dev:v1:${record.owner}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export function openReceipt(body, key, owner) {
  try {
    if (!KEY.test(key ?? "") || body.length > 1024 * 1024) throw new Error();
    const blob = JSON.parse(body);
    if (blob.version !== 1) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(blob.iv, "base64"));
    decipher.setAAD(Buffer.from(`zeros-dev:v1:${owner}`));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    return validate(JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]).toString()), owner);
  } catch { throw new Error("Could not authenticate the hosted Dev receipt; check the registry key and owner"); }
}

/** The registry lives outside both checkout copies. Conditional writes prevent
 * the Mac and cloud archive hook from owning one generation concurrently. */
export function r2Registry(config, dependencies) {
  const require = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url));
  const sdk = dependencies?.sdk ?? require("@aws-sdk/client-s3");
  if (!/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(config?.endpoint ?? "") ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? "") || !config.bucket.includes("dev") ||
      !KEY.test(config.encryptionKey ?? "") || !config.accessKeyId || !config.secretAccessKey) {
    throw new Error("Configure a dedicated Dev R2 registry bucket, credentials and encryption key");
  }
  const client = dependencies?.client ?? new sdk.S3Client({ region: "auto", endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey }, maxAttempts: 2 });
  const object = owner => {
    if (!OWNER.test(owner)) throw new Error("Invalid Dev registry owner");
    return { Bucket: config.bucket, Key: `environments/v1/${owner}.json` };
  };
  return {
    async read(owner) {
      try {
        const value = await client.send(new sdk.GetObjectCommand(object(owner)), { abortSignal: AbortSignal.timeout(15_000) });
        if (!value.ETag || value.ContentLength > 1024 * 1024) throw new Error();
        return { state: openReceipt(await value.Body.transformToString(), config.encryptionKey, owner), etag: value.ETag };
      } catch (error) {
        if (error?.name === "NoSuchKey") return null;
        throw new Error("Dev registry read failed; no resource ownership was assumed");
      }
    },
    async write(owner, state, etag) {
      validate(state, owner);
      try {
        const response = await client.send(new sdk.PutObjectCommand({ ...object(owner),
          ContentType: "application/json", Body: sealReceipt(state, config.encryptionKey),
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
        }), { abortSignal: AbortSignal.timeout(15_000) });
        if (!response.ETag) throw new Error();
        return response.ETag;
      } catch { throw new Error("Dev registry update failed or another process took ownership; retry after reconciling the receipt"); }
    },
    close() { client.destroy(); },
  };
}

export async function withHostedLease(store, identity, operation, { create = false, now = Date.now, heartbeat = true, signal } = {}) {
  signal?.throwIfAborted();
  const current = await store.read(identity.owner);
  if (!current && !create) return { absent: true };
  const state = current?.state ?? newHostedGeneration(identity, undefined, now());
  validate(state, identity.owner);
  if (state.identity !== identity.identity) throw new Error("Dev workspace identity changed");
  if (state.lease && (!Number.isFinite(state.lease.expiresAt) || state.lease.expiresAt > now())) {
    throw Object.assign(new Error("Another process is provisioning or archiving this Dev workspace; retry after it finishes"), { code: "DEV_LEASE_BUSY" });
  }
  const token = randomUUID();
  state.lease = { token, expiresAt: now() + LEASE_MS };
  let etag = await store.write(identity.owner, state, current?.etag), lost = false, queue = Promise.resolve();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const lease = {
    state, signal: controller.signal,
    async save() {
      const commit = async () => {
        if (lost || state.lease?.token !== token || state.lease.expiresAt <= now()) throw new Error("Dev operation lost its registry lease");
        state.lease.expiresAt = now() + LEASE_MS;
        try { etag = await store.write(identity.owner, structuredClone(state), etag); }
        catch (error) { lost = true; controller.abort(error); throw error; }
      };
      const next = queue.then(commit); queue = next.catch(() => {}); return next;
    },
    async fence() {
      const check = async () => {
        controller.signal.throwIfAborted();
        const live = await store.read(identity.owner);
        if (!live || live.etag !== etag || live.state.lease?.token !== token || state.lease.expiresAt <= now()) {
          lost = true; const error = new Error("Dev operation no longer owns this generation"); controller.abort(error); throw error;
        }
      };
      const next = queue.then(check); queue = next.catch(() => {}); return next;
    },
  };
  const timer = heartbeat ? setInterval(() => { void lease.save().catch(() => {}); }, LEASE_MS / 3) : undefined;
  timer?.unref();
  try { return await operation(lease); }
  finally {
    signal?.removeEventListener("abort", abort);
    clearInterval(timer); await queue;
    if (!lost) {
      delete state.lease;
      await store.write(identity.owner, state, etag);
    }
  }
}

/** Pin non-secret provider containers for a generation. Rotating a credential
 * is allowed; silently moving an existing receipt to another account is not. */
export function bindHostedProfile(state, profile) {
  const target = { railwayProject: profile.railway.projectId, railwayService: profile.railway.serviceId,
    planetScaleOrganization: profile.planetscale.organization, planetScaleDatabase: profile.planetscale.database,
    protectedBranch: profile.planetscale.protectedBranch, account: profile.cloudflare.accountId,
    zone: profile.cloudflare.zoneId, domain: profile.cloudflare.domain, registryBucket: profile.registry.bucket,
    registryEndpoint: profile.registry.endpoint, objectsBucket: profile.storage.bucket, objectsEndpoint: profile.storage.endpoint,
    protectedEnvironments: [...profile.railway.protectedEnvironmentIds].sort(),
    boatScope: profile.boat?.accountScope, boatBillingOrg: profile.boat?.billingOrg,
    webClientId: profile.workos?.webClientId, desktopClientId: profile.workos?.desktopClientId, githubAppId: profile.github?.appId };
  const digest = sha256(JSON.stringify(target));
  if (state.profileDigest && state.profileDigest !== digest) throw new Error("Archive the existing Dev generation before changing provider containers");
  state.profileDigest = digest; state.targets = target;
}
