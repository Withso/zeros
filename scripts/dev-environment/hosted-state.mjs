import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { sha256, workspaceIdentity, derivedWorkspaceIdentity, legacyWorkspaceIdentities } from "./state.mjs";

const OWNER = /^[a-f0-9]{24}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const KEY = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 1024 * 1024;
export const LEASE_MS = 120_000;

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;

export function deploymentConfigFingerprint(state, profile) {
  // Digest secret values and explicit secret versions with an independent,
  // generation-stable key. Neither raw values nor unkeyed hashes are public.
  return { version: 1, digest: createHmac("sha256", Buffer.from(state.keys.agent, "hex"))
    .update("zeros-dev:deployment-config:v1\0").update(JSON.stringify(canonical(profile))).digest("hex") };
}

export function hostedName(state) {
  if (!OWNER.test(state.owner) || !UUID.test(state.generation)) throw new Error("Invalid Dev resource identity");
  return `dev-${state.owner}-${state.generation.replaceAll("-", "")}`;
}

export function newHostedGeneration(identity, previous, now = Date.now()) {
  if (!OWNER.test(identity.owner) || (previous && (previous.owner !== identity.owner || previous.status !== "archived"))) {
    throw new Error("Finish the previous Dev archive before starting a fresh generation");
  }
  return {
    version: 2, owner: identity.owner, identity: identity.identity,
    lastUserActivityAt: new Date(now).toISOString(), expiresAt: null,
    generation: randomUUID(), status: "provisioning", createdAt: new Date(now).toISOString(),
    keys: Object.fromEntries(["cookie", "settings", "objects", "provider", "agent"].map(k => [k, randomBytes(32).toString("hex")])),
    resources: {}, steps: {},
    ...(previous ? { previous: { generation: previous.generation, archivedAt: previous.archivedAt },
      pendingBuilderDeletions: globalThis.structuredClone(previous.pendingBuilderDeletions ?? []),
      pendingWorkerDeletions: globalThis.structuredClone(previous.pendingWorkerDeletions ?? []) } : {}),
  };
}

export async function selectHostedOwner(store, owner, generation) {
  if (!OWNER.test(owner ?? "") || !UUID.test(generation ?? "")) throw new Error("Explicit Dev recovery requires --owner and --generation");
  const current = await store.read(owner);
  if (!current || current.state.generation !== generation) throw new Error("Selected Dev generation no longer matches its authenticated registry receipt");
  return { owner, identity: current.state.identity, generation };
}

export async function adoptHostedOwner(store, root, owner, generation, env = process.env) {
  const identity = await selectHostedOwner(store, owner, generation);
  const bound = workspaceIdentity(root, env, { create: false, inspect: true });
  if (bound && bound.owner !== owner) {
    const previous = await store.read(bound.owner);
    if (previous && (previous.state.status !== "archived" || previous.state.lease)) throw new Error("Archive the active bound generation before adopting another owner");
  }
  return workspaceIdentity(root, env, { adopt: identity, replaceOwner: bound?.owner });
}

export async function resolveHostedOwner(store, root, env = process.env, { create = true, readonly = false } = {}) {
  const bound = workspaceIdentity(root, env, { create: false, inspect: readonly });
  const derived = derivedWorkspaceIdentity(root, env);
  const candidates = new Set([...legacyWorkspaceIdentities(root, env).map(value => value.owner), ...(bound?.legacyCandidates ?? []), ...(bound ? [bound.owner] : [])]);
  const records = [];
  for (const owner of candidates) {
    const current = await store.read(owner);
    if (current) records.push(current.state);
  }
  if (bound) {
    if (records.some(state => state.owner !== bound.owner && state.status !== "archived") || !records.some(state => state.owner === bound.owner) && records.length) throw new Error("Another legacy owner is bound to this checkout; use dev:doctor --all and explicit dev:adopt before cleanup");
    return bound;
  }
  if (records.length > 1) throw new Error("Multiple legacy Dev owners exist for this checkout; use dev:doctor --all and explicit dev:adopt");
  if (readonly) return records.length ? { owner: records[0].owner, identity: records[0].identity, repositoryRoot: derived.repositoryRoot } : null;
  return workspaceIdentity(root, env, records.length ? { adopt: records[0] } : { create });
}

function validate(record, owner) {
  if (![1, 2].includes(record?.version) || record.owner !== owner || !UUID.test(record.generation ?? "") ||
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
  const sealed = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
  // A receipt that cannot be read must never replace the last known cleanup
  // authority. Bound the encrypted representation, including base64 overhead.
  if (Buffer.byteLength(sealed) > MAX_RECEIPT_BYTES) throw new Error("Hosted Dev receipt exceeds its size limit; retain the existing generation for cleanup");
  return sealed;
}

function openDocument(body, key, owner) {
  try {
    if (!KEY.test(key ?? "") || Buffer.byteLength(body) > MAX_RECEIPT_BYTES) throw new Error();
    const blob = JSON.parse(body);
    if (blob.version !== 1) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(blob.iv, "base64"));
    decipher.setAAD(Buffer.from(`zeros-dev:v1:${owner}`));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(blob.data, "base64")), decipher.final()]).toString());
  } catch { throw new Error("Could not authenticate the hosted Dev receipt; check the registry key and owner"); }
}

export function openReceipt(body, key, owner) { return validate(openDocument(body, key, owner), owner); }

export function recordArchiveIntent(state, profile, now = Date.now()) {
  if (state.archiveIntent) return;
  const at = state.archiveRequestedAt ?? new Date(now).toISOString();
  const key = profile.registry.encryptionKey;
  state.archiveRequestedAt = at;
  if (!KEY.test(key ?? "")) return; // Synthetic adapters; real profiles require this key.
  state.archiveIntent = { version: 1, at, signature: createHmac("sha256", Buffer.from(key, "hex"))
    .update(`zeros-dev:archive:v1:${state.owner}:${state.generation}:${at}`).digest("hex") };
}

export function bindHostedLifetime(state, profile, now = Date.now()) {
  if (state.version !== 2 || state.lifetimePolicy || !profile.lifecycle?.maxLifetimeHours) return;
  const hours = profile.lifecycle.maxLifetimeHours, grace = profile.lifecycle.activityGraceHours ?? 24, warning = profile.lifecycle.warningHours ?? 24;
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30 || !Number.isFinite(grace) || grace < 0 || grace > 168 || !Number.isFinite(warning) || warning < 0 || warning > 168) throw new Error("Invalid Dev lifetime policy");
  state.lifetimePolicy = { version: 1, maxLifetimeHours: hours, activityGraceHours: grace, warningHours: warning,
    adoptedAt: new Date(now).toISOString() };
  state.expiresAt = new Date(Date.parse(state.createdAt) + hours * 3600_000).toISOString();
}

export function hostedGcEligibility(state, profile, now = Date.now()) {
  if (state.investigationPin && (!Number.isFinite(Date.parse(state.investigationPin.expiresAt)) || Date.parse(state.investigationPin.expiresAt) > now)) return { eligible: false, reason: "investigation-pin" };
  const intent = state.archiveIntent;
  if (intent?.version === 1 && KEY.test(intent.signature ?? "") && KEY.test(profile.registry.encryptionKey ?? "")) {
    const expected = createHmac("sha256", Buffer.from(profile.registry.encryptionKey, "hex"))
      .update(`zeros-dev:archive:v1:${state.owner}:${state.generation}:${intent.at}`).digest();
    if (timingSafeEqual(Buffer.from(intent.signature, "hex"), expected)) return { eligible: true, reason: "signed-archive-intent" };
  }
  const policy = state.lifetimePolicy, expiry = Date.parse(state.expiresAt), activity = Date.parse(state.lastUserActivityAt);
  if (state.version === 2 && policy?.version === 1 && Number.isFinite(expiry) && Number.isFinite(activity) &&
      Number.isFinite(policy.activityGraceHours) && policy.activityGraceHours >= 0 && Number.isFinite(policy.maxLifetimeHours) && policy.maxLifetimeHours > 0) {
    return { eligible: expiry <= now && activity + policy.activityGraceHours * 3600_000 <= now, reason: "maximum-lifetime",
      warning: expiry - now <= (policy.warningHours ?? 24) * 3600_000 ? "Dev maximum lifetime is approaching or expired; archive and relaunch a fresh generation." : undefined };
  }
  return { eligible: false, reason: "unenrolled-or-active" };
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
    async list({ history = false } = {}) {
      const records = [], quarantine = [], tokens = new Set();
      let token, pages = 0;
      do {
        if (++pages > 100) throw new Error("Dev registry pagination exceeded its page budget");
        const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: config.bucket, Prefix: "environments/v1/", MaxKeys: 1000,
          ...(token ? { ContinuationToken: token } : {}) }), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
        if (!Array.isArray(page.Contents ?? []) || typeof page.IsTruncated !== "boolean") throw new Error("Dev registry inventory is incomplete");
        for (const item of page.Contents ?? []) {
          const owner = /^environments\/v1\/([a-f0-9]{24})\.json$/.exec(item.Key ?? "")?.[1];
          if (!owner) { quarantine.push({ reason: "unknown-registry-key" }); continue; }
          try {
            const record = await this.read(owner);
            if (!record) throw new Error();
            records.push(record);
          } catch { quarantine.push({ owner, reason: "unconfirmed-registry-receipt" }); }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!token || tokens.has(token))) throw new Error("Dev registry pagination is incomplete");
        if (token) tokens.add(token);
      } while (token);
      if (history) {
        const seen = new Set(records.map(r => `${r.state.owner}/${r.state.generation}`));
        let cursor, historyPages = 0; const cursors = new Set();
        do {
          if (++historyPages > 100) throw new Error("Dev history pagination exceeded its page budget");
          const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: config.bucket, Prefix: "environments/v2/", MaxKeys: 1000,
            ...(cursor ? { ContinuationToken: cursor } : {}) }), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
          if (!Array.isArray(page.Contents ?? []) || typeof page.IsTruncated !== "boolean") throw new Error("Dev history inventory is incomplete");
          for (const entry of page.Contents ?? []) {
            const match = /^environments\/v2\/([a-f0-9]{24})\/([a-f0-9-]{36})\.json$/.exec(entry.Key ?? "");
            if (!match || !UUID.test(match[2])) { quarantine.push({ reason: "unknown-history-key" }); continue; }
            if (seen.has(`${match[1]}/${match[2]}`)) continue;
            try {
              const record = await this.readHistory(match[1], match[2]);
              if (!record) throw new Error();
              records.push({ ...record, historical: true });
            } catch { quarantine.push({ owner: match[1], generation: match[2], reason: "unconfirmed-history-receipt" }); }
          }
          cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && (!cursor || cursors.has(cursor))) throw new Error("Dev history pagination is incomplete");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      return { records, quarantine };
    },
    async read(owner) {
      try {
        const value = await client.send(new sdk.GetObjectCommand(object(owner)), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
        if (!value.ETag || value.ContentLength > MAX_RECEIPT_BYTES) throw new Error();
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
        }), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
        if (!response.ETag) throw new Error();
        return response.ETag;
      } catch (error) {
        // An expected conditional-write race is different from denied access
        // or an outage. Never infer a conflict from an arbitrary provider body.
        if (error?.$metadata?.httpStatusCode === 412) throw Object.assign(
          new Error("Another Dev process updated the ownership receipt"), { code: "DEV_REGISTRY_CONFLICT" });
        throw new Error("Dev registry update failed; retry after reconciling the receipt");
      }
    },
    async readHistory(owner, generation) {
      if (!OWNER.test(owner) || !UUID.test(generation)) throw new Error("Invalid Dev history identity");
      return this.readDocument(`environments/v2/${owner}/${generation}.json`, owner, value => {
        validate(value, owner); if (value.generation !== generation || value.status !== "archived") throw new Error("Invalid archived history"); return value;
      });
    },
    async writeHistory(state, etag) {
      validate(state, state.owner);
      if (state.status !== "archived") throw new Error("Only archived generation history may be preserved");
      return this.writeDocument(`environments/v2/${state.owner}/${state.generation}.json`, state, etag);
    },
    async readAdmission() { return this.readDocument("admission/v1/account.json", "account-admission", value => {
      if (value.owner !== "account-admission" || value.version !== 1 || !Array.isArray(value.reservations)) throw new Error("Invalid account admission ledger"); return value;
    }); },
    async writeAdmission(value, etag) { return this.writeDocument("admission/v1/account.json", value, etag); },
    async readDocument(Key, owner, validateDocument) {
      try {
        const value = await client.send(new sdk.GetObjectCommand({ Bucket: config.bucket, Key }), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
        if (!value.ETag || value.ContentLength > MAX_RECEIPT_BYTES) throw new Error();
        return { state: validateDocument(openDocument(await value.Body.transformToString(), config.encryptionKey, owner)), etag: value.ETag };
      } catch (error) { if (error?.name === "NoSuchKey") return null; throw new Error("Dev registry document cannot be authenticated"); }
    },
    async writeDocument(Key, state, etag) {
      try {
        const response = await client.send(new sdk.PutObjectCommand({ Bucket: config.bucket, Key, Body: sealReceipt(state, config.encryptionKey),
          ContentType: "application/json", ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }) }), { abortSignal: globalThis.AbortSignal.timeout(15_000) });
        if (!response.ETag) throw new Error(); return response.ETag;
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 412) throw Object.assign(new Error("Dev registry compare-and-swap conflict"), { code: "DEV_REGISTRY_CONFLICT" });
        throw new Error("Dev registry document update is unconfirmed");
      }
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
  if (identity.generation && state.generation !== identity.generation) throw new Error("Selected Dev generation changed; no mutation was dispatched");
  if (state.identity !== identity.identity) throw new Error("Dev workspace identity changed");
  if (state.lease && (!Number.isFinite(state.lease.expiresAt) || state.lease.expiresAt > now())) {
    throw Object.assign(new Error("Another process is provisioning or archiving this Dev workspace; retry after it finishes"), { code: "DEV_LEASE_BUSY" });
  }
  const token = randomUUID();
  state.lease = { token, expiresAt: now() + LEASE_MS };
  let etag;
  try { etag = await store.write(identity.owner, state, current?.etag); }
  catch (error) {
    // Both contenders may have read an unlocked receipt before either wrote
    // it. Only the winning CAS owns a lease; the loser must retry acquisition.
    if (error?.code === "DEV_REGISTRY_CONFLICT") throw Object.assign(
      new Error("Another process acquired this Dev workspace; retry after it finishes"), { code: "DEV_LEASE_BUSY" });
    throw error;
  }
  let lost = false, queue = Promise.resolve();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const lease = {
    state, signal: controller.signal,
    async preserveGeneration() {
      if (!store.writeHistory) return;
      await this.fence();
      const existing = await store.readHistory(state.owner, state.generation);
      const history = globalThis.structuredClone(state); delete history.lease;
      await store.writeHistory(history, existing?.etag);
    },
    async save() {
      const commit = async () => {
        if (lost || state.lease?.token !== token || state.lease.expiresAt <= now()) throw new Error("Dev operation lost its registry lease");
        state.lease.expiresAt = now() + LEASE_MS;
        try { etag = await store.write(identity.owner, globalThis.structuredClone(state), etag); }
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
