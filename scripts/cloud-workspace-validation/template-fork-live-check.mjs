import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseEnv } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseTarget } from "../../apps/control-plane/src/database-target.ts";

export const TEMPLATE_FORK_ALPHA_ORIGIN = "https://api-alpha.zeros.build";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const RESOURCE = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const fail = code => { throw new Error(code); };
const requireCheck = (condition, code) => { if (!condition) fail(code); };
const pause = () => new Promise(resolve => setTimeout(resolve, 5000));
const root = fileURLToPath(new URL("../../", import.meta.url));

/** Only .env.agent supplies credentials. No inherited URL, CLI credential,
 * provider admin API, or write-capable SQL is used by this runbook. */
export function templateForkLiveConfig(values) {
  try {
    const database = parseDatabaseTarget(values.ZEROS_C5_ALPHA_DATABASE_URL);
    requireCheck(database.hostname.endsWith(".psdb.cloud") &&
      values.ZEROS_PLANETSCALE_ALPHA_DATABASE === "zeros-control-plane-alpha", "input_invalid");
    const config = {
      accessToken: values.ZEROS_C5_ALPHA_ACCESS_TOKEN,
      databaseUrl: database.toString(),
      organizationId: values.ZEROS_C5_ALPHA_ORGANIZATION_ID,
      repository: {
        forge: "github.com", owner: values.ZEROS_C5_ALPHA_REPOSITORY_OWNER,
        name: values.ZEROS_C5_ALPHA_REPOSITORY_NAME, revision: values.ZEROS_C5_ALPHA_REVISION,
        githubInstallationId: values.ZEROS_C5_ALPHA_INSTALLATION_ID,
      },
      expectedSha: values.ZEROS_C5_ALPHA_EXPECTED_SHA ?? values.ZEROS_C5_ALPHA_REVISION,
    };
    requireCheck(UUID.test(config.organizationId) && UUID.test(config.repository.githubInstallationId) &&
      [config.repository.owner, config.repository.name].every(value => typeof value === "string" &&
        /^[a-z0-9_.-]{1,100}$/.test(value) && value !== "." && value !== "..") &&
      typeof config.repository.revision === "string" && /^[A-Za-z0-9_./-]{1,512}$/.test(config.repository.revision) &&
      SHA.test(config.expectedSha) && typeof config.accessToken === "string" &&
      config.accessToken.length > 0 && config.accessToken.length <= 16384 && !/\s/.test(config.accessToken), "input_invalid");
    return config;
  } catch { fail("input_invalid"); }
}

export function newTemplateForkJournal(organizationId, id = randomUUID()) {
  requireCheck(UUID.test(organizationId) && UUID.test(id), "input_invalid");
  return { schema: "zeros.template-fork-live/v1", id, organizationId,
    name: `zeros-v2-test-c5-${id}`, createAttempted: false, createRejected: false,
    workspaceId: null, providerResourceIds: [], source: null, replayVerified: false,
    readyVerified: false, cleanup: "pending", failedChecks: [] };
}
const createKey = journal => `zeros-v2-test-c5-${journal.id}.create`;
const workspacePath = journal => `/v1/organizations/${journal.organizationId}/cloud-workspaces`;
const keyTuple = row => ({ buildId: row.build_id, templateId: row.template_id, configId: row.config_id,
  templateSandboxId: row.template_sandbox_id, runtimeId: row.runtime_id,
  baseImageId: row.runtime_base_image_id, manifestSha256: row.runtime_manifest_sha256,
  baseCompatibilityId: row.runtime_base_compatibility_id, repositorySha: row.repository_revision });

function ownWorkspace(journal, row) {
  requireCheck(row && UUID.test(row.workspace_id) && row.org_id === journal.organizationId && row.display_name === journal.name &&
    (!journal.workspaceId || row.workspace_id === journal.workspaceId), "ownership_mismatch");
  requireCheck(Array.isArray(row.operations) && row.operations.every(op => op.resource_id === null ||
    (RESOURCE.test(op.resource_id) && op.resource_id !== row.template_sandbox_id)), "provider_identity_invalid");
  journal.workspaceId = row.workspace_id;
  journal.providerResourceIds = [...new Set(row.operations.flatMap(op => op.resource_id ? [op.resource_id] : []))];
}

function acceptedSource(journal, row, config, expectedBuildId) {
  ownWorkspace(journal, row);
  requireCheck(row.current_generation === 1 && row.build_id === expectedBuildId && row.template_id === row.build_id &&
    UUID.test(row.config_id) && RESOURCE.test(row.template_sandbox_id) &&
    row.image_ref === `boat-template:${row.template_sandbox_id}` && /^r1-[a-f0-9]{64}$/.test(row.runtime_id) &&
    /^[a-f0-9]{64}$/.test(row.runtime_manifest_sha256) && /^bc1-[a-f0-9]{64}$/.test(row.runtime_base_compatibility_id) &&
    typeof row.runtime_base_image_id === "string" && row.runtime_base_image_id.length <= 512 &&
    row.repository_revision === config.expectedSha, "acceptance_mismatch");
  return keyTuple(row);
}

/** Uses only the test run's recorded create key and exact name/org/UUID.
 * An absent row after an ambiguous POST is not evidence of successful cleanup. */
export async function cleanupTemplateFork(journal, { request, database, save, wait = pause, attempts = 180 }) {
  if (!journal.createAttempted) { journal.cleanup = "not_created"; save(journal); return; }
  let deleteAccepted = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const row = await database.accepted(journal.organizationId, createKey(journal));
    if (!row) {
      if (journal.createRejected && !journal.workspaceId) { journal.cleanup = "not_created"; save(journal); return; }
    } else {
      ownWorkspace(journal, row);
      save(journal);
      if (row.deleted_at && row.deletion_state === "succeeded" && row.operations.every(op =>
        op.resource_id ? op.deleted_at !== null : op.create_closed_at !== null)) {
        journal.cleanup = "verified"; save(journal); return;
      }
      if (!deleteAccepted) {
        const response = await request("DELETE", `${workspacePath(journal)}/${journal.workspaceId}`,
          { discardUncheckpointed: true }, `zeros-v2-test-c5-${journal.id}.delete`);
        requireCheck([200, 202].includes(response.status), "cleanup_pending");
        deleteAccepted = true;
      }
    }
    await wait();
  }
  fail("cleanup_pending");
}

/** Dependency injection keeps all local tests offline. Real execution always
 * reaches cleanup, including after a lost create reply or readiness failure. */
export async function runTemplateForkLiveCheck(config, journal, dependencies) {
  const { request, database, save, wait = pause, attempts = 180 } = dependencies;
  save(journal); // Persist the create key before the first allocation request.
  try {
    const active = await database.active(config.organizationId);
    requireCheck(active && UUID.test(active.build_id), "template_unavailable");
    const computer = await request("GET", `/v1/organizations/${config.organizationId}/cloud-computer/v2`);
    requireCheck(computer.status === 200 && computer.body?.active?.id === active.build_id, "alpha_identity_mismatch");
    journal.createAttempted = true;
    save(journal);
    const body = { name: journal.name, repository: config.repository };
    const first = await request("POST", workspacePath(journal), body, createKey(journal));
    journal.createRejected = [400, 401, 403, 404, 409, 422, 429].includes(first.status);
    save(journal);
    requireCheck(first.status === 202 && UUID.test(first.body?.workspace?.id), "create_failed");
    journal.workspaceId = first.body.workspace.id;
    save(journal);
    journal.source = acceptedSource(journal, await database.accepted(config.organizationId, createKey(journal)), config, active.build_id);
    save(journal);
    const replay = await request("POST", workspacePath(journal), body, createKey(journal));
    requireCheck(replay.status === 200 && replay.body?.replayed === true && replay.body.workspace?.id === journal.workspaceId,
      "replay_mismatch");
    const replaySource = acceptedSource(journal, await database.accepted(config.organizationId, createKey(journal)), config, active.build_id);
    requireCheck(JSON.stringify(replaySource) === JSON.stringify(journal.source), "replay_mismatch");
    journal.replayVerified = true;
    save(journal);
    for (let attempt = 0; attempt < attempts; attempt++) {
      const response = await request("GET", `${workspacePath(journal)}/${journal.workspaceId}`);
      requireCheck(response.status === 200 && response.body?.workspace?.id === journal.workspaceId, "readiness_failed");
      const workspace = response.body.workspace;
      requireCheck(!["failed", "deleted", "archived"].includes(workspace.status), "readiness_failed");
      if (workspace.status === "ready") {
        const row = await database.accepted(config.organizationId, createKey(journal));
        const source = acceptedSource(journal, row, config, active.build_id);
        requireCheck(JSON.stringify(source) === JSON.stringify(journal.source) && row.operations.length === 1 &&
          journal.providerResourceIds.length === 1 && workspace.generation?.runtime?.runtimeId === source.runtimeId, "acceptance_mismatch");
        journal.readyVerified = true;
        save(journal);
        break;
      }
      await wait();
    }
    requireCheck(journal.readyVerified, "readiness_timeout");
  } catch {
    // No exception message or remote body can reach the evidence or console.
    journal.failedChecks.push("verification_failed");
  } finally {
    try { await cleanupTemplateFork(journal, dependencies); }
    catch { journal.failedChecks.push("cleanup_pending"); }
    save(journal);
  }
  return journal;
}

export function templateForkEvidenceReader(pool) {
  const read = async fn => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL ROLE zeros_app");
      await client.query("SELECT set_config('app.system', 'on', true)");
      const result = await fn(client);
      await client.query("ROLLBACK");
      return result;
    } catch { await client.query("ROLLBACK").catch(() => {}); fail("database_unavailable"); }
    finally { client.release(); }
  };
  return {
    active: organizationId => read(async client => (await client.query(`SELECT build.id AS build_id
      FROM cloud_computer_v2_heads head JOIN cloud_computer_v2_builds build ON build.id=head.active_build_id AND build.org_id=head.org_id
      JOIN cloud_computer_templates template ON template.build_id=build.id AND template.org_id=build.org_id
      WHERE head.org_id=$1 AND build.state='succeeded' AND template.state='ready' AND template.stopped_at IS NOT NULL`,
    [organizationId])).rows[0] ?? null),
    accepted: (organizationId, key) => read(async client => {
      const row = (await client.query(`SELECT workspace.id AS workspace_id,workspace.org_id,workspace.display_name,
        workspace.current_generation,workspace.deleted_at,generation.image_ref,generation.runtime_id,generation.runtime_base_image_id,
        generation.runtime_manifest_sha256,generation.runtime_base_compatibility_id,
        source.build_id,source.template_id,source.config_id,template.provider_resource_id AS template_sandbox_id,
        spec.repository_revision,deletion.state AS deletion_state
        FROM cloud_workspace_lifecycle_intents intent JOIN cloud_workspaces workspace ON workspace.id=intent.workspace_id AND workspace.org_id=intent.org_id
        JOIN cloud_workspace_generations generation ON generation.workspace_id=workspace.id AND generation.generation=1 AND generation.org_id=workspace.org_id
        LEFT JOIN cloud_workspace_computer_sources source ON source.workspace_id=generation.workspace_id
          AND source.generation=generation.generation AND source.org_id=generation.org_id
        LEFT JOIN cloud_computer_templates template ON template.build_id=source.template_id AND template.org_id=source.org_id
        LEFT JOIN cloud_workspace_setup_specs spec ON spec.workspace_id=generation.workspace_id
          AND spec.generation=generation.generation AND spec.org_id=generation.org_id
        LEFT JOIN workspace_deletion_jobs deletion ON deletion.workspace_id=workspace.id AND deletion.org_id=workspace.org_id
        WHERE intent.org_id=$1 AND intent.idempotency_key=$2 AND intent.operation='create'`, [organizationId, key])).rows[0];
      if (!row) return null;
      const operations = (await client.query(`SELECT resource_id,deleted_at,create_closed_at
        FROM cloud_workspace_provider_operations WHERE org_id=$1 AND workspace_id=$2 ORDER BY generation`,
      [organizationId, row.workspace_id])).rows;
      return { ...row, operations };
    }),
  };
}

function alphaRequest(config) {
  return async (method, pathname, body, idempotencyKey) => {
    requireCheck(pathname.startsWith(`/v1/organizations/${config.organizationId}/`), "request_invalid");
    const response = await fetch(`${TEMPLATE_FORK_ALPHA_ORIGIN}${pathname}`, { method, redirect: "error",
      signal: AbortSignal.timeout(30000), headers: { authorization: `Bearer ${config.accessToken}`,
        "content-type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const reader = response.body?.getReader();
    requireCheck(reader, "response_invalid");
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        requireCheck(bytes <= 1024 * 1024, "response_invalid");
        chunks.push(chunk.value);
      }
      return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  };
}

function privateJson(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    requireCheck(stat.isFile() && stat.nlink === 1 && !(stat.mode & 0o077) && stat.size <= 65536, "input_invalid");
    return readFileSync(descriptor, "utf8");
  } finally { closeSync(descriptor); }
}

async function main() {
  const config = templateForkLiveConfig(parseEnv(privateJson(path.join(root, ".env.agent"))));
  const args = process.argv.slice(2);
  requireCheck(args.length === 0 || args.length === 2 && args[0] === "--cleanup" && UUID.test(args[1]), "input_invalid");
  const directory = path.join(root, ".context", "zeros-v2-test-c5");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const id = args[1] ?? randomUUID(), file = path.join(directory, `${id}.json`);
  const journal = args.length ? JSON.parse(privateJson(file)) : newTemplateForkJournal(config.organizationId, id);
  requireCheck(journal.schema === "zeros.template-fork-live/v1" && journal.id === id &&
    journal.organizationId === config.organizationId && journal.name === `zeros-v2-test-c5-${id}`, "input_invalid");
  const save = value => {
    const temporary = `${file}.tmp-${randomUUID()}`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try { writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
    renameSync(temporary, file);
  };
  const { Pool } = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("pg");
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 10000,
    statement_timeout: 15000, idle_in_transaction_session_timeout: 15000,
    application_name: "zeros-v2-test-c5", options: "-c role=none -c default_transaction_read_only=on" });
  pool.on("error", () => {});
  const dependencies = { request: alphaRequest(config), database: templateForkEvidenceReader(pool), save };
  try {
    if (args.length) await cleanupTemplateFork(journal, dependencies);
    else await runTemplateForkLiveCheck(config, journal, dependencies);
    process.stdout.write(JSON.stringify({ schema: journal.schema, runId: id, workspaceId: journal.workspaceId,
      providerResourceIds: journal.providerResourceIds, replayVerified: journal.replayVerified,
      readyVerified: journal.readyVerified, cleanup: journal.cleanup, failedChecks: journal.failedChecks }) + "\n");
    process.exitCode = journal.cleanup === "pending" || !args.length && journal.failedChecks.length ? 1 : 0;
  } finally { await pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => { process.stderr.write("Template fork live check failed; retain the cleanup journal.\n"); process.exitCode = 1; });
