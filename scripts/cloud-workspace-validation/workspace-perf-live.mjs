import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../packages/protocol/src/version.ts";
import { createCloudReplicaDeviceCredential, CloudReplicaDeviceSigner } from "../../apps/desktop/src/engine/cloud-replica-device.ts";
import { BoatApiClient, BOAT_BILLING_ORG_PATTERN } from "../../apps/control-plane/src/cloud-workspaces/boat-client.ts";
import { templateForkLiveConfig, templateForkEvidenceReader } from "./template-fork-live-check.mjs";
import { privateFile } from "./template-setup-repro.mjs";
import { PERF_UUID, PERF_RESOURCE, perfCheck, perfDatabaseConfig, perfPool, perfRead, readPerfEnvironment, readPerfTimeline } from "./workspace-perf-timeline.mjs";

const ORIGIN = "https://api-alpha.zeros.build";
const root = fileURLToPath(new URL("../../", import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = (journal, operation) => `${journal.name}.${operation}`;
const workspacePath = journal => `/v1/organizations/${journal.organizationId}/cloud-workspaces`;

export function perfLiveConfig(values) {
  const c5 = Object.fromEntries(Object.entries(values).filter(([name]) => name.startsWith("ZEROS_PERF_ALPHA_"))
    .map(([name, value]) => [name.replace("ZEROS_PERF_ALPHA_", "ZEROS_C5_ALPHA_"), value]));
  const config = templateForkLiveConfig({ ...c5, ZEROS_PLANETSCALE_ALPHA_DATABASE: values.ZEROS_PLANETSCALE_ALPHA_DATABASE });
  perfCheck(PERF_UUID.test(values.ZEROS_PERF_ALPHA_TEST_USER_ID ?? "") && BOAT_BILLING_ORG_PATTERN.test(values.BOAT_BILLING_ORG ?? "") &&
    /^[\x21-\x7e]{16,4096}$/.test(values.BOAT_API_KEY ?? ""), "input_invalid");
  return { ...config, ...perfDatabaseConfig(values), testUserId: values.ZEROS_PERF_ALPHA_TEST_USER_ID,
    apiKey: values.BOAT_API_KEY, billingOrg: values.BOAT_BILLING_ORG };
}

export function newPerfJournal(config, label, id = randomUUID()) {
  perfCheck(PERF_UUID.test(id) && ["before", "after"].includes(label), "input_invalid");
  return { schema: "zeros.workspace-perf-live/v1", id, label, name: `zeros-v2-test-perf-${id}`,
    organizationId: config.organizationId, testUserId: config.testUserId, createdAt: new Date().toISOString(),
    createAttempted: false, createRejected: false, deviceAttempted: false, deviceRejected: false,
    workspaceId: null, deviceId: null, providerResourceIds: [], cleanup: "pending", deviceCleanup: "pending",
    samples: [], timeline: null, failedChecks: [] };
}

export function validatePerfJournal(journal, config, id) {
  perfCheck(journal?.schema === "zeros.workspace-perf-live/v1" && journal.id === id && PERF_UUID.test(id) &&
    journal.name === `zeros-v2-test-perf-${id}` && journal.organizationId === config.organizationId &&
    journal.testUserId === config.testUserId && (journal.workspaceId === null || PERF_UUID.test(journal.workspaceId)) &&
    (journal.deviceId === null || PERF_UUID.test(journal.deviceId)) && Array.isArray(journal.providerResourceIds) &&
    journal.providerResourceIds.length <= 32 && journal.providerResourceIds.every(id => PERF_RESOURCE.test(id)), "journal_invalid");
  perfCheck(["before", "after"].includes(journal.label) && Array.isArray(journal.samples) && journal.samples.length <= 32 &&
    ["pending", "verified", "not_created"].includes(journal.cleanup) &&
    ["pending", "revoked", "not_created"].includes(journal.deviceCleanup) &&
    Array.isArray(journal.failedChecks) && journal.failedChecks.every(code => ["measurement_failed", "cleanup_pending"].includes(code)) &&
    ["createAttempted", "createRejected", "deviceAttempted", "deviceRejected"].every(name => typeof journal[name] === "boolean"), "journal_invalid");
}

export function ownPerfWorkspace(journal, row) {
  perfCheck(row && PERF_UUID.test(row.workspace_id) && row.org_id === journal.organizationId &&
    row.owner_user_id === journal.testUserId && row.display_name === journal.name &&
    (!journal.workspaceId || journal.workspaceId === row.workspace_id) && Array.isArray(row.operations) &&
    row.operations.every(op => op.resource_id === null || PERF_RESOURCE.test(op.resource_id) && op.resource_id !== row.template_sandbox_id), "ownership_mismatch");
  journal.workspaceId = row.workspace_id;
  journal.providerResourceIds = [...new Set(row.operations.flatMap(op => op.resource_id ? [op.resource_id] : []))];
}

export function perfLiveDatabase(pool) {
  const reader = templateForkEvidenceReader(pool);
  return {
    active: reader.active,
    accepted: async journal => {
      const row = await reader.accepted(journal.organizationId, key(journal, "create"));
      if (!row) return null;
      const owner = await perfRead(pool, async client => (await client.query("SELECT owner_user_id FROM cloud_workspaces WHERE id=$1", [row.workspace_id])).rows[0]);
      return { ...row, owner_user_id: owner?.owner_user_id };
    },
    device: journal => perfRead(pool, async client => (await client.query(`SELECT id,user_id,label,revoked_at FROM devices
      WHERE user_id=$1 AND registration_idempotency_key=$2`, [journal.testUserId, key(journal, "device")])).rows[0] ?? null),
    timeline: workspaceId => readPerfTimeline(pool, workspaceId),
  };
}

export function perfAlphaRequest(config, fetcher = fetch) {
  return async (method, pathname, body, idempotencyKey, headers = {}) => {
    const base = `/v1/organizations/${config.organizationId}/cloud-workspaces`;
    const [workspace, ...suffix] = pathname.startsWith(`${base}/`) ? pathname.slice(base.length + 1).split("/") : [];
    const action = suffix.join("/");
    perfCheck(
      method === "GET" && pathname === "/v1/me" || method === "POST" && pathname === "/v1/devices" ||
      method === "DELETE" && pathname.startsWith("/v1/devices/") && PERF_UUID.test(pathname.slice(12)) ||
      method === "POST" && pathname === base || PERF_UUID.test(workspace ?? "") && (
        !action && ["GET", "DELETE"].includes(method) ||
        method === "POST" && ["stop", "wake", "runtime/admission"].includes(action) ||
        method === "DELETE" && action === "runtime/admission"), "request_invalid");
    const response = await fetcher(`${ORIGIN}${pathname}`, { method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${config.accessToken}`, "content-type": "application/json", ...headers,
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const chunks = []; let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength; perfCheck(bytes <= 1024 * 1024, "response_invalid"); chunks.push(chunk.value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    return { status: response.status, body: bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null };
  };
}

export async function verifyPerfPrincipal(config, request) {
  const me = await request("GET", "/v1/me");
  perfCheck(me.status === 200 && me.body?.user?.id === config.testUserId &&
    ["platform_owner", "developer"].includes(me.body?.user?.staffRole), "test_identity_invalid");
}

/** Use the #330 gate: an upgrade or ENGINE_READY is not authenticated success.
 * Send CONNECTED first, then require the correlated workspace.list response.
 * No reusable account bearer enters the VM and no agent turn is started. */
export async function perfHandshake(admission, Socket = WebSocket) {
  perfCheck(admission.bridgeUrl === "wss://api-alpha.zeros.build/v1/cloud-workspaces/bridge" &&
    /^zwa_[A-Za-z0-9_-]{43}$/.test(admission.grantToken ?? ""), "admission_invalid");
  const started = performance.now(), id = randomUUID();
  return new Promise((resolve, reject) => {
    let done = false, opened = null;
    const socket = new Socket(admission.bridgeUrl, { headers: { "x-zeros-cloud-token": admission.grantToken },
      handshakeTimeout: 15_000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    const finish = ok => {
      if (done) return; done = true; clearTimeout(timer); socket.terminate();
      if (ok && opened !== null) resolve({ upgradeMs: Math.round(opened - started), connectedProbeMs: Math.round(performance.now() - opened) });
      else reject(new Error("handshake_failed"));
    };
    const timer = setTimeout(() => finish(false), 15_000);
    socket.on("open", () => {
      opened = performance.now();
      socket.send(JSON.stringify({ id: randomUUID(), type: "CONNECTED", source: "browser", timestamp: Date.now(),
        capabilities: [], protocolVersion: PROTOCOL_VERSION }));
      socket.send(JSON.stringify({ id, type: "WORKSPACE_REQUEST", source: "browser", timestamp: Date.now(), op: "workspace.list", params: {} }));
    });
    socket.on("message", data => {
      let value; try { value = JSON.parse(data.toString()); } catch { return; }
      if (value.type === "CONNECTION_REJECTED") finish(false);
      if (value.requestId === id && ["WORKSPACE_RESPONSE", "WORKSPACE_ERROR"].includes(value.type)) finish(value.type === "WORKSPACE_RESPONSE");
    });
    socket.on("error", () => finish(false)); socket.on("close", () => finish(false));
  });
}

export async function cleanupPerfRun(journal, deps) {
  const { request, database, save, pause = wait, cleanupAttempts = 120 } = deps;
  // Each resource is recovered by a pre-recorded idempotency key, never by an
  // arbitrary supplied workspace/device id. Unknown dispatch stays pending.
  if (!journal.deviceAttempted) journal.deviceCleanup = "not_created";
  if (!journal.createAttempted) journal.cleanup = "not_created";
  for (let attempt = 0; attempt < cleanupAttempts; attempt++) {
    try {
      if (journal.deviceAttempted && !["revoked", "not_created"].includes(journal.deviceCleanup)) {
        const device = await database.device(journal);
        if (!device && journal.deviceRejected) journal.deviceCleanup = "not_created";
        if (device) {
          perfCheck(PERF_UUID.test(device.id) && device.user_id === journal.testUserId && device.label === journal.name &&
            (!journal.deviceId || device.id === journal.deviceId), "ownership_mismatch");
          journal.deviceId = device.id; save(journal);
          if (device.revoked_at) journal.deviceCleanup = "revoked";
          else await request("DELETE", `/v1/devices/${device.id}`);
        }
      }
      if (journal.createAttempted && !["verified", "not_created"].includes(journal.cleanup)) {
        const row = await database.accepted(journal);
        if (!row && journal.createRejected && !journal.workspaceId) journal.cleanup = "not_created";
        if (row) {
          ownPerfWorkspace(journal, row); save(journal);
          if (row.deleted_at && row.deletion_state === "succeeded" && row.operations.every(op => op.resource_id ? op.deleted_at : op.create_closed_at)) {
            journal.cleanup = "verified";
          } else {
            const response = await request("DELETE", `${workspacePath(journal)}/${journal.workspaceId}`, { discardUncheckpointed: true }, key(journal, "delete"));
            perfCheck([200, 202].includes(response.status), "cleanup_pending");
          }
        }
      }
    } catch { /* Retry closed, bounded cleanup; never print an error/body. */ }
    save(journal);
    if (["verified", "not_created"].includes(journal.cleanup) && ["revoked", "not_created"].includes(journal.deviceCleanup)) return;
    await pause(5_000);
  }
  throw new Error("cleanup_pending");
}

export async function runPerfLive(config, journal, deps) {
  const { request, database, save, pause = wait, now = performance.now.bind(performance), handshake = perfHandshake } = deps;
  const actorTokens = [];
  const revokeActors = async () => {
    while (actorTokens.length) {
      const token = actorTokens.pop();
      try { await request("DELETE", `${workspacePath(journal)}/${journal.workspaceId}/runtime/admission`, undefined, undefined, { "x-zeros-runtime-admission": token }); }
      catch { /* Device revocation and workspace deletion independently retire actors. */ }
    }
  };
  const measure = async (phase, fn) => {
    const start = now(); let ok = false;
    try { const result = await fn(); ok = true; return result; }
    finally { journal.samples.push({ phase, durationMs: Math.round(now() - start), ok }); save(journal); }
  };
  const accepted = async () => { const row = await database.accepted(journal); ownPerfWorkspace(journal, row); save(journal); return row; };
  const ready = async target => {
    const deadline = now() + 600_000;
    while (now() < deadline) {
      const response = await request("GET", `${workspacePath(journal)}/${journal.workspaceId}`);
      perfCheck(response.status === 200 && response.body?.workspace?.id === journal.workspaceId, "readiness_failed");
      const workspace = response.body.workspace;
      perfCheck(!["failed", "archived", "deleted"].includes(workspace.status), "readiness_failed");
      if (workspace.status === target) return workspace;
      await pause(250);
    }
    throw new Error("readiness_timeout");
  };
  save(journal);
  try {
    await verifyPerfPrincipal(config, request);
    const active = await database.active(config.organizationId);
    perfCheck(PERF_UUID.test(active?.build_id ?? ""), "template_unavailable");
    const credential = createCloudReplicaDeviceCredential(config.testUserId);
    journal.deviceAttempted = true; save(journal);
    const registered = await request("POST", "/v1/devices", { label: journal.name, platform: "linux", publicKey: credential.publicKey }, key(journal, "device"));
    journal.deviceRejected = [400, 401, 403, 404, 422, 429].includes(registered.status); save(journal);
    perfCheck([200, 201].includes(registered.status) && PERF_UUID.test(registered.body?.device?.id ?? ""), "device_failed");
    journal.deviceId = registered.body.device.id; save(journal);
    const signer = new CloudReplicaDeviceSigner({ ...credential, deviceId: journal.deviceId });
    const attach = async (phase, workspace) => {
      const proof = signer.proof("engine.connect", { organizationId: journal.organizationId, workspaceId: journal.workspaceId });
      const response = await measure(`${phase}_admission`, () => request("POST", `${workspacePath(journal)}/${journal.workspaceId}/runtime/admission`, { actorProtocolVersion: 2 }, undefined,
        Object.fromEntries(Object.entries({ id: proof.deviceId, "key-version": proof.keyVersion, timestamp: proof.timestampMs, nonce: proof.nonce, signature: proof.signature })
          .map(([name, value]) => [`x-zeros-device-${name}`, String(value)]))));
      const admission = response.body;
      perfCheck(response.status === 201 && admission?.version === 2 && admission.workspaceId === journal.workspaceId &&
        admission.organizationId === journal.organizationId && admission.generation === workspace.generation.number, "admission_invalid");
      actorTokens.push(admission.grantToken);
      const socket = await measure(`${phase}_bridge_connected`, () => handshake(admission));
      for (const [name, durationMs] of Object.entries(socket)) {
        if (["upgradeMs", "connectedProbeMs"].includes(name) && Number.isSafeInteger(durationMs) && durationMs >= 0)
          journal.samples.push({ phase: `${phase}_${name}`, durationMs, ok: true });
      }
    };
    await measure("create_to_connected_with_operator_checks", async () => {
      journal.createAttempted = true; save(journal);
      const response = await measure("create_api", () => request("POST", workspacePath(journal), { name: journal.name, repository: config.repository }, key(journal, "create")));
      journal.createRejected = [400, 401, 403, 404, 409, 422, 429].includes(response.status); save(journal);
      perfCheck(response.status === 202 && PERF_UUID.test(response.body?.workspace?.id ?? ""), "create_failed");
      journal.workspaceId = response.body.workspace.id; save(journal);
      const row = await measure("create_operator_ownership_read", accepted);
      perfCheck(row.build_id === active.build_id && row.repository_revision === config.expectedSha, "source_mismatch");
      const workspace = await measure("create_wait_ready", () => ready("ready"));
      await attach("create", workspace);
    });
    await revokeActors();
    const row = await accepted();
    // Rename only this run's recorded child, after the timed create path.
    await deps.nameResources(journal, row);
    const stopped = await request("POST", `${workspacePath(journal)}/${journal.workspaceId}/stop`, {}, key(journal, "stop"));
    perfCheck([200, 202].includes(stopped.status), "stop_failed");
    await measure("stop_wait_stopped", () => ready("stopped"));
    await measure("wake_to_connected", async () => {
      const response = await measure("wake_api", () => request("POST", `${workspacePath(journal)}/${journal.workspaceId}/wake`, {}, key(journal, "wake")));
      perfCheck([200, 202].includes(response.status), "wake_failed");
      const workspace = await measure("wake_wait_ready", () => ready("ready"));
      await attach("wake", workspace);
    });
  } catch { journal.failedChecks.push("measurement_failed"); }
  finally {
    await revokeActors();
    if (journal.workspaceId) try { journal.timeline = await database.timeline(journal.workspaceId); } catch { /* explicitly absent */ }
    try { await cleanupPerfRun(journal, deps); } catch { journal.failedChecks.push("cleanup_pending"); }
    save(journal);
  }
}

async function main() {
  const args = process.argv.slice(2), cleanup = args[0] === "--cleanup";
  perfCheck(args.length === 2 && (cleanup ? PERF_UUID.test(args[1]) : args[0] === "--run" && ["before", "after"].includes(args[1])), "input_invalid");
  const config = perfLiveConfig(readPerfEnvironment()), pool = perfPool(config);
  const directory = path.join(root, ".context", "zeros-v2-test-perf"); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = cleanup ? args[1] : randomUUID(), file = path.join(directory, `${id}.json`);
  const journal = cleanup ? JSON.parse(privateFile(file)) : newPerfJournal(config, args[1], id);
  validatePerfJournal(journal, config, id);
  const save = value => {
    const temp = `${file}.${randomUUID()}.tmp`, fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  };
  const boat = new BoatApiClient({ apiKey: config.apiKey, billingOrg: config.billingOrg, timeoutMs: 30_000, diagnostics: () => {} });
  const dependencies = { save, request: perfAlphaRequest(config), database: perfLiveDatabase(pool),
    nameResources: async (journal, row) => {
      ownPerfWorkspace(journal, row);
      for (const id of journal.providerResourceIds) {
        const { sandbox } = await boat.request(`/sandboxes/${id}`);
        perfCheck(sandbox?.id === id && sandbox.team?.id?.toLowerCase() === config.billingOrg.toLowerCase(), "provider_scope_mismatch");
        await boat.request(`/sandboxes/${id}`, { method: "PATCH", body: { name: journal.name } });
      }
    },
  };
  try {
    if (cleanup) {
      await verifyPerfPrincipal(config, dependencies.request);
      await cleanupPerfRun(journal, dependencies);
    }
    else await runPerfLive(config, journal, dependencies);
    process.stdout.write(JSON.stringify({ schema: journal.schema, runId: id, label: journal.label, workspaceId: journal.workspaceId,
      deviceId: journal.deviceId, providerResourceIds: journal.providerResourceIds, samples: cleanup ? undefined : journal.samples,
      timeline: cleanup ? undefined : journal.timeline, cleanup: journal.cleanup, deviceCleanup: journal.deviceCleanup, failedChecks: journal.failedChecks,
      rendererPaint: "not_measured", readinessPollMs: 250 }) + "\n");
    process.exitCode = journal.cleanup === "pending" || journal.deviceCleanup === "pending" || !cleanup && journal.failedChecks.length ? 1 : 0;
  } finally { await pool.end(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { process.stderr.write('{"schema":"zeros.workspace-perf-error/v1","code":"run_failed_retain_cleanup_journal"}\n'); process.exitCode = 1; });
