#!/usr/bin/env node
// Alpha acceptance only. Credentials come from .env.agent; no provider APIs,
// publication, revocation or deployment operations are performed by this runner.
import { randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseAgentEnv } from "../../agent-env-check.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUNTIME = /^r1-[0-9a-f]{64}$/;
const PIN_FIELDS = ["runtimeId", "manifestSha256", "baseImageId", "baseCompatibilityId", "profile", "engineProtocolVersion"];
class CheckFailure extends Error {
  constructor(check) { super(check); this.check = check; }
}
function check(ok, code) { if (!ok) throw new CheckFailure(code); }

export function parseLifecycleConfig(text) {
  const { values, malformedLines, duplicateKeys } = parseAgentEnv(text);
  check(!malformedLines.length && !duplicateKeys.length, "configuration");
  const get = name => values.get(`ZEROS_B8_ALPHA_${name}`);
  let origin;
  try { origin = new URL(get("ORIGIN")); } catch { throw new CheckFailure("configuration"); }
  check(origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash, "configuration");
  const config = {
    origin: origin.origin, token: get("ACCESS_TOKEN"), organizationId: get("ORGANIZATION_ID"),
    teamId: get("TEAM_ID"), nextRuntimeId: get("NEXT_RUNTIME_ID"),
    repository: { forge: "github.com", owner: get("REPOSITORY_OWNER"), name: get("REPOSITORY_NAME"),
      revision: get("REPOSITORY_REVISION") ?? "main", githubInstallationId: get("GITHUB_INSTALLATION_ID") },
    qualificationMode: get("QUALIFICATION_MODE") ?? "full",
    timeoutMs: Number(get("TIMEOUT_SECONDS") ?? "1200") * 1000,
  };
  check(typeof config.token === "string" && config.token.length >= 20 && !/\s/.test(config.token), "configuration");
  check(UUID.test(config.organizationId ?? "") && UUID.test(config.repository.githubInstallationId ?? "") &&
    (!config.teamId || UUID.test(config.teamId)), "configuration");
  check([config.repository.owner, config.repository.name].every(value => /^[A-Za-z0-9_.-]{1,100}$/.test(value ?? "")) &&
    config.repository.revision.length <= 512 && RUNTIME.test(config.nextRuntimeId ?? ""), "configuration");
  check(["smoke", "full"].includes(config.qualificationMode) && Number.isSafeInteger(config.timeoutMs) &&
    config.timeoutMs >= 1000 && config.timeoutMs <= 3_600_000, "configuration");
  return config;
}

function generation(workspace) {
  const value = workspace?.generation, pin = value?.runtime;
  check(Number.isSafeInteger(value?.number) && value.number > 0 && pin &&
    RUNTIME.test(pin.runtimeId) && pin.runtimeId === `r1-${pin.manifestSha256}` &&
    typeof pin.baseImageId === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(pin.baseImageId) && /^bc1-[0-9a-f]{64}$/.test(pin.baseCompatibilityId) &&
    pin.profile === "zeros-cloud-worker-v4" && Number.isSafeInteger(pin.engineProtocolVersion) && pin.engineProtocolVersion > 0, "v4_pin");
  return { number: value.number, pin: Object.fromEntries(PIN_FIELDS.map(field => [field, pin[field]])) };
}

const diagnostic = failedChecks => ({ schema: "zeros.diagnostic/v1", component: "qualification", stage: "lifecycle",
  ok: failedChecks.length === 0, exitCode: failedChecks.length ? 1 : 0,
  timedOut: failedChecks.some(value => value.endsWith("_timeout")), failedChecks });

export async function runRuntimeLifecycle(config, {
  fetchImpl = fetch, pause = ms => new Promise(done => setTimeout(done, ms)), now = Date.now,
  reportProgress = async () => {},
} = {}) {
  const operations = Object.fromEntries(["create", "stop", "wake", "upgrade", "stale", "delete"].map(key => [key, randomUUID()]));
  const report = { schema: "zeros.runtime-lifecycle-report/v1", workspaceId: null, operations, transitionId: null,
    sourceGeneration: null, upgradedGeneration: null, checks: [], providerCleanupConfirmed: null };
  const failed = [];
  const base = `/v1/organizations/${config.organizationId}/cloud-workspaces`;
  let createAttempted = false;
  const createBody = { name: `zeros-v2-test-${operations.create}`, repository: config.repository,
    ...(config.teamId ? { teamId: config.teamId } : {}) };

  // Every mutating request has a stable idempotency key (or body operationId),
  // including retries after a lost response. Raw response/error text is discarded.
  async function request(path, method = "GET", body, key) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(`${config.origin}${path}`, {
          method, redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${config.token}`, accept: "application/json", "content-type": "application/json",
            ...(key ? { "idempotency-key": key } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const data = await response.json();
        return { status: response.status, data, replayed: response.headers.get("Idempotency-Replayed") === "true" };
      } catch {
        if (attempt === 2) throw new CheckFailure("request_failed");
        await pause(1000);
      }
    }
  }
  function accepted(response) {
    check([200, 202].includes(response.status), "http_status");
    return response.data;
  }
  async function poll(read, code) {
    const deadline = now() + config.timeoutMs;
    do {
      const result = await read();
      if (result) return result;
      await pause(5000);
    } while (now() < deadline);
    throw new CheckFailure(code);
  }
  async function rememberCreated(response) {
    const id = accepted(response).workspace?.id;
    check(UUID.test(id ?? ""), "workspace_identity");
    report.workspaceId = id;
    await reportProgress(report);
  }
  const workspacePath = () => `${base}/${report.workspaceId}`;
  async function waitWorkspace(status, expectedGeneration) {
    return poll(async () => {
      const workspace = accepted(await request(workspacePath())).workspace;
      check(workspace?.id === report.workspaceId, "workspace_identity");
      if (status !== "deleted") check(workspace.status !== "failed", "workspace_failed");
      return workspace.status === status && (expectedGeneration === undefined || workspace.generation?.number === expectedGeneration) && workspace;
    }, "workspace_timeout");
  }
  try {
    const identity = accepted(await request("/v1/release-identity"));
    check(identity.channel === "alpha" && identity.ready === true && identity.runtimeV4?.newWorkspaceProfile === "v4", "alpha_v4_guard");
    check(accepted(await request("/v1/internal/cloud-runtime/status")).channel === "alpha", "staff_alpha_guard");
    const inventory = accepted(await request(`/v1/organizations/${config.organizationId}/cloud-workspace-management/pending-deletion`));
    check(inventory.truncated === false && Array.isArray(inventory.pendingDeletion), "cleanup_inventory_guard");
    report.checks.push("alpha_v4_guard", "staff_alpha_guard", "cleanup_inventory_guard");
    await reportProgress(report);
    createAttempted = true;
    await rememberCreated(await request(base, "POST", createBody, operations.create));
    const source = generation(await waitWorkspace("ready"));
    report.sourceGeneration = source.number;
    check(source.pin.runtimeId !== config.nextRuntimeId, "later_runtime_required");
    accepted(await request(`${workspacePath()}/stop`, "POST", {}, operations.stop));
    await waitWorkspace("stopped", source.number);
    report.checks.push("source_stopped");
    await reportProgress(report); // Operator may now qualify the separate later release.
    await poll(async () => {
      const status = accepted(await request("/v1/internal/cloud-runtime/status"));
      const runtime = status.runtimes?.find(value => value.runtimeId === config.nextRuntimeId);
      return status.channelReleases?.some(value => value.runtimeId === config.nextRuntimeId && value.confirmedAt && !value.revokedAt) &&
        runtime && !runtime.revokedAt && runtime.engineProtocolVersion === source.pin.engineProtocolVersion &&
        ["claude-setup-token", "codex-chatgpt", "cursor-api-key"].every(kind => status.qualifications?.some(value =>
          value.runtimeId === config.nextRuntimeId && value.baseCompatibilityId === source.pin.baseCompatibilityId &&
          value.credentialKind === kind && value.profile === "zeros-cloud-worker-v4" && value.enabled && !value.revokedAt &&
          (value.evidenceMode === "full" || config.qualificationMode === "smoke" && value.evidenceMode === "smoke")));
    }, "later_runtime_timeout");
    accepted(await request(`${workspacePath()}/wake`, "POST", {}, operations.wake));
    const woken = generation(await waitWorkspace("ready", source.number));
    check(JSON.stringify(woken) === JSON.stringify(source), "wake_pins");
    report.checks.push("wake_pins");
    const upgradeBody = { expectedGeneration: source.number, operationId: operations.upgrade };
    const upgrade = accepted(await request(`${workspacePath()}/runtime-upgrade`, "POST", upgradeBody));
    check(upgrade.operationId === operations.upgrade && upgrade.sourceGeneration === source.number && !upgrade.unchanged &&
      upgrade.runtimeId === config.nextRuntimeId && Number.isSafeInteger(upgrade.generation) && upgrade.generation > source.number &&
      UUID.test(upgrade.transitionId ?? ""), "replacement_generation");
    report.transitionId = upgrade.transitionId;
    report.upgradedGeneration = upgrade.generation;
    await reportProgress(report);
    const upgraded = generation(await waitWorkspace("ready", upgrade.generation));
    check(upgraded.pin.runtimeId === upgrade.runtimeId && upgraded.pin.baseImageId === source.pin.baseImageId &&
      upgraded.pin.baseCompatibilityId === source.pin.baseCompatibilityId, "same_base_upgrade");
    const replay = await request(`${workspacePath()}/runtime-upgrade`, "POST", upgradeBody);
    check(replay.status === 200 && replay.replayed && JSON.stringify(replay.data) === JSON.stringify(upgrade), "upgrade_replay");
    const stale = await request(`${workspacePath()}/runtime-upgrade`, "POST", { ...upgradeBody, operationId: operations.stale });
    check(stale.status === 409 && stale.data?.error?.code === "cloud_generation_changed", "generation_cas");
    report.checks.push("same_base_upgrade", "upgrade_replay", "generation_cas");
  } catch (error) {
    failed.push(error instanceof CheckFailure ? error.check : "lifecycle_failed");
  } finally {
    if (createAttempted) {
      report.providerCleanupConfirmed = false;
      try {
        // Recover the workspace ID by replay if all original create replies were lost.
        if (!report.workspaceId) await rememberCreated(await request(base, "POST", createBody, operations.create));
        accepted(await request(workspacePath(), "DELETE", { discardUncheckpointed: true }, operations.delete));
        await waitWorkspace("deleted");
        await poll(async () => {
          const pending = accepted(await request(`/v1/organizations/${config.organizationId}/cloud-workspace-management/pending-deletion`));
          return pending.truncated === false && Array.isArray(pending.pendingDeletion) &&
            !pending.pendingDeletion.some(value => value.workspaceId === report.workspaceId);
        }, "cleanup_timeout");
        report.providerCleanupConfirmed = true;
        report.checks.push("provider_cleanup");
      } catch { failed.push("cleanup_unconfirmed"); }
    }
  }
  return { ...report, diagnostic: diagnostic([...new Set(failed)]) };
}

async function main() {
  const reportUrl = new URL("../../../.context/b8-runtime-lifecycle.json", import.meta.url);
  const persist = async report => {
    await mkdir(new URL(".", reportUrl), { recursive: true });
    await writeFile(reportUrl, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  };
  let result;
  try {
    check(process.argv.length === 2, "configuration");
    const config = parseLifecycleConfig(await readFile(new URL("../../../.env.agent", import.meta.url), "utf8"));
    result = await runRuntimeLifecycle(config, { reportProgress: persist });
    await persist(result);
  } catch { result = { diagnostic: diagnostic(["configuration_or_report_failed"]) }; }
  // Only the closed diagnostic goes to stdout. The private report contains
  // allowlisted UUIDs and check results, never pins, paths, bodies or credentials.
  process.stdout.write(`${JSON.stringify(result.diagnostic)}\n`);
  process.exitCode = result.diagnostic.ok ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
