import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { parseDatabaseTarget } from "../../apps/control-plane/src/database-target.ts";
import {
  BoatApiClient,
  BOAT_BILLING_ORG_PATTERN,
  BOAT_RESOURCE_ID_PATTERN,
} from "../../apps/control-plane/src/cloud-workspaces/boat-client.ts";
import { executeBoatPinnedSsh } from "../../apps/control-plane/src/cloud-workspaces/boat-pinned-ssh.ts";
import { RuntimeBaseStatusSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-contract.ts";
import { computerWorkspaceTemplateManifest } from "../../apps/control-plane/src/cloud-workspaces/computer-workspace-source.ts";
import { parseCloudComputerSetup } from "./sandbox/cloud-computer-checkout.mjs";
import { sanitizeProbeReport } from "./template-setup-probe.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const DELETION = /^bdop_[a-f0-9]{32}$/;
const root = fileURLToPath(new URL("../../", import.meta.url));
const pause = () => new Promise((resolve) => setTimeout(resolve, 5000));
const requireCheck = (pass, code) => {
  if (!pass) throw new Error(code);
};
const key = (journal) => `zeros-v2-test-s1-${journal.id}`;
const STATUS_COMMAND =
  "/usr/bin/sudo -n /usr/bin/python3 -I /opt/zeros-bootstrap/bootstrap.py status";

/** Operator-only: .env.agent is the sole credential source. The Alpha database
 * is read-only; no workspace admission, GitHub token, hook or engine is issued. */
export function templateSetupReproConfig(values) {
  try {
    const database = parseDatabaseTarget(
      values.ZEROS_S1_ALPHA_DATABASE_URL ?? values.ZEROS_C5_ALPHA_DATABASE_URL,
    );
    requireCheck(
      database.hostname.endsWith(".psdb.cloud") &&
        values.ZEROS_PLANETSCALE_ALPHA_DATABASE ===
          "zeros-control-plane-alpha" &&
        BOAT_BILLING_ORG_PATTERN.test(values.BOAT_BILLING_ORG ?? "") &&
        /^[\x21-\x7e]{16,4096}$/.test(values.BOAT_API_KEY ?? ""),
      "input_invalid",
    );
    return {
      databaseUrl: database.toString(),
      apiKey: values.BOAT_API_KEY,
      billingOrg: values.BOAT_BILLING_ORG,
    };
  } catch {
    throw new Error("input_invalid");
  }
}

export function newTemplateSetupJournal(
  workspaceId,
  generation,
  templateId,
  id = randomUUID(),
) {
  requireCheck(
    UUID.test(workspaceId) &&
      UUID.test(id) &&
      Number.isSafeInteger(generation) &&
      generation > 0 &&
      BOAT_RESOURCE_ID_PATTERN.test(templateId),
    "input_invalid",
  );
  return {
    schema: "zeros.template-setup-repro/v1",
    id,
    workspaceId,
    generation,
    templateId,
    createdAt: new Date().toISOString(),
    createAttempted: false,
    forkBody: null,
    childId: null,
    deletionId: null,
    phase: "source",
    cleanup: "pending",
    failedChecks: [],
    probe: null,
  };
}

/** Same size/env/from contract as BoatCloudWorkspaceProvider.createAllocation.
 * The diagnostic fork has a fixed 30-minute lease rather than a CP-funded lease. */
export function templateSetupForkBody(material) {
  const resource = material.image?.resources;
  const type =
    resource?.cpuMillicores === 2000 && resource.memoryMiB === 4096
      ? "small"
      : resource?.cpuMillicores === 4000 && resource.memoryMiB === 8192
        ? "default"
        : resource?.cpuMillicores === 8000 && resource.memoryMiB === 16384
          ? "large"
          : null;
  requireCheck(
    type &&
      resource.architecture === "linux/amd64" &&
      Number.isSafeInteger(resource.storageMiB) &&
      resource.storageMiB > 0,
    "source_invalid",
  );
  return { type, ttlSeconds: 1800, noEnv: true, env: {} };
}

async function recoverFork(journal, { request, save }) {
  requireCheck(
    journal.forkBody &&
      ["small", "default", "large"].includes(journal.forkBody.type) &&
      JSON.stringify(journal.forkBody) ===
        JSON.stringify({
          type: journal.forkBody.type,
          ttlSeconds: 1800,
          noEnv: true,
          env: {},
        }) &&
      Number.isFinite(Date.parse(journal.createdAt)) &&
      Date.now() - Date.parse(journal.createdAt) >= -60000 &&
      Date.now() - Date.parse(journal.createdAt) < 23 * 60 * 60_000,
    "fork_unknown",
  );
  const response = await request(`/sandboxes/${journal.templateId}/fork`, {
    method: "POST",
    body: journal.forkBody,
    idempotencyKey: key(journal),
  });
  const child = response.sandbox?.id ?? response.sandboxId;
  requireCheck(
    BOAT_RESOURCE_ID_PATTERN.test(child ?? "") &&
      child !== journal.templateId &&
      (!journal.childId || child === journal.childId),
    "child_invalid",
  );
  // Retain the disposable ID even if other receipt fields are malformed.
  journal.childId = child;
  save(journal);
  requireCheck(
    (response.sandboxId === undefined || response.sandboxId === child) &&
      [response, response.sandbox].every(
        (value) =>
          !value ||
          value.sourceSandboxId === undefined ||
          value.sourceSandboxId === journal.templateId,
      ),
    "child_invalid",
  );
}

export async function cleanupTemplateSetupFork(journal, dependencies) {
  const { request, save, wait = pause, attempts = 120 } = dependencies;
  if (!journal.createAttempted) {
    journal.cleanup = "not_created";
    save(journal);
    return;
  }
  if (journal.childId !== null)
    requireCheck(
      BOAT_RESOURCE_ID_PATTERN.test(journal.childId) &&
        journal.childId !== journal.templateId,
      "child_invalid",
    );
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (!journal.childId) await recoverFork(journal, dependencies);
      if (!journal.deletionId) {
        const response = await request(`/sandboxes/${journal.childId}`, {
          method: "DELETE",
          confirmDelete: journal.childId,
        });
        requireCheck(
          DELETION.test(response.operation?.id ?? "") &&
            response.operation.targetId === journal.childId,
          "cleanup_pending",
        );
        journal.deletionId = response.operation.id;
        save(journal);
      }
      requireCheck(DELETION.test(journal.deletionId), "cleanup_pending");
      const { operation } = await request(
        `/deletion-operations/${journal.deletionId}`,
      );
      requireCheck(
        operation?.id === journal.deletionId &&
          operation.targetId === journal.childId &&
          operation.kind === "sandbox",
        "cleanup_pending",
      );
      if (
        operation.status === "completed" &&
        typeof operation.completedAt === "string" &&
        Number.isFinite(Date.parse(operation.completedAt))
      ) {
        journal.cleanup = "verified";
        save(journal);
        return;
      }
    } catch {
      /* Keep the key, ID and receipt for retry; never print a remote body. */
    }
    if (attempt + 1 < attempts) await wait();
  }
  throw new Error("cleanup_pending");
}

export async function runTemplateSetupRepro(journal, billingOrg, dependencies) {
  const { request, load, ready, probe, save } = dependencies;
  save(journal);
  try {
    const material = await load(journal);
    requireCheck(
      material.templateId === journal.templateId &&
        material.billingOrg === billingOrg &&
        material.baseImageId.startsWith("zeros-v2-test-"),
      "source_invalid",
    );
    const { sandbox } = await request(`/sandboxes/${journal.templateId}`);
    requireCheck(
      sandbox?.id === journal.templateId &&
        sandbox.state === "archived" &&
        sandbox.snapshotAvailable === true &&
        sandbox.lastSnapshotStatus === "completed" &&
        sandbox.team?.id?.toLowerCase() === billingOrg.toLowerCase(),
      "source_invalid",
    );
    journal.forkBody = templateSetupForkBody(material);
    journal.phase = "fork";
    journal.createAttempted = true;
    save(journal);
    await recoverFork(journal, dependencies);
    journal.phase = "bootstrap";
    save(journal);
    await request(`/sandboxes/${journal.childId}`, {
      method: "PATCH",
      body: { name: key(journal) },
    });
    await ready(journal, material);
    journal.phase = "probe";
    save(journal);
    journal.probe = sanitizeProbeReport(await probe(journal, material));
    if (journal.probe.checks.some((check) => !check.ok))
      journal.failedChecks.push("probe_failed");
  } catch {
    journal.failedChecks.push("verification_failed");
  } finally {
    try {
      await cleanupTemplateSetupFork(journal, dependencies);
    } catch {
      journal.failedChecks.push("cleanup_pending");
    }
    save(journal);
  }
  return journal;
}

/** Reconstruct the saved generation's computer contract using C5's exact
 * manifest mapper. No current head, secret table or mutable setup material. */
export async function readTemplateSetupSource(pool, journal) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL ROLE zeros_app");
    await client.query("SELECT set_config('app.system', 'on', true)");
    const { rows } = await client.query(
      `SELECT source.org_id,source.build_id,source.config_id,
      template.provider_resource_id,template.billing_org,template.protected_contract_digest,
      build.base_image_id,build.runtime_id AS template_runtime_id,build.repository_manifest,
      base.base_compatibility_id,gen.image_ref,gen.source_commit,gen.runtime_id,gen.runtime_manifest_sha256,
      gen.runtime_base_compatibility_id,gen.architecture,gen.cpu_millicores,gen.memory_mib,gen.storage_mib,
      spec.repository_forge,spec.repository_owner,spec.repository_name,spec.repository_revision,
      workspace.repository_revision AS requested_revision,
      repo.repository_id
      FROM cloud_workspace_computer_sources source
      JOIN cloud_workspace_generations gen USING(workspace_id,generation,org_id)
      JOIN cloud_workspaces workspace ON workspace.id=source.workspace_id AND workspace.org_id=source.org_id
      JOIN cloud_computer_v2_builds build ON build.id=source.build_id AND build.config_id=source.config_id AND build.org_id=source.org_id
      JOIN cloud_computer_templates template ON template.build_id=source.template_id AND template.org_id=source.org_id
      JOIN cloud_runtime_base_images base ON base.base_image_id=build.base_image_id AND base.provider='boat'
      JOIN cloud_workspace_setup_specs spec ON spec.workspace_id=source.workspace_id AND spec.generation=source.generation AND spec.org_id=source.org_id
      JOIN cloud_computer_v2_config_repositories repo ON repo.config_id=source.config_id AND repo.org_id=source.org_id
        AND repo.repository_owner=lower(spec.repository_owner) AND repo.repository_name=lower(spec.repository_name)
      WHERE source.workspace_id=$1 AND source.generation=$2 AND build.state='succeeded' AND template.state='ready'
        AND source.template_id=source.build_id AND template.stopped_at IS NOT NULL AND template.protected_contract_digest IS NOT NULL`,
      [journal.workspaceId, journal.generation],
    );
    requireCheck(rows.length === 1, "source_invalid");
    const row = rows[0];
    requireCheck(
      row.provider_resource_id === journal.templateId &&
        row.image_ref === `boat-template:${journal.templateId}` &&
        UUID.test(row.org_id) &&
        typeof row.base_image_id === "string" &&
        row.base_image_id.startsWith("zeros-v2-test-") &&
        Buffer.isBuffer(row.protected_contract_digest) &&
        row.protected_contract_digest.length === 32,
      "source_invalid",
    );
    const computer = {
      template: computerWorkspaceTemplateManifest({
        buildId: row.build_id,
        configId: row.config_id,
        baseImageId: row.base_image_id,
        templateRuntimeId: row.template_runtime_id,
        baseCompatibilityId: row.base_compatibility_id,
        repositories: row.repository_manifest,
        protectedContractDigest: row.protected_contract_digest.toString("hex"),
      }),
      primaryRepositoryId: row.repository_id,
      requestedRevision: row.requested_revision,
    };
    const repository = {
      forge: row.repository_forge,
      owner: row.repository_owner,
      name: row.repository_name,
      revision: row.repository_revision,
      cloneUrl: `https://github.com/${row.repository_owner}/${row.repository_name}.git`,
    };
    parseCloudComputerSetup(computer, repository);
    return {
      templateId: row.provider_resource_id,
      billingOrg: row.billing_org,
      baseImageId: row.base_image_id,
      computer,
      repository,
      runtimePin: {
        runtimeId: row.runtime_id,
        manifestSha256: row.runtime_manifest_sha256,
        baseCompatibilityId: row.runtime_base_compatibility_id,
      },
      execution: {
        workspaceId: randomUUID(),
        organizationId: row.org_id,
        generation: 1,
        setupRunId: randomUUID(),
        executionFence: 1,
      },
      engine: { instanceId: randomUUID() },
      image: {
        ref: row.image_ref,
        sourceCommit: row.source_commit,
        resources: {
          architecture: row.architecture,
          cpuMillicores: row.cpu_millicores,
          memoryMiB: row.memory_mib,
          storageMiB: Number(row.storage_mib),
        },
      },
    };
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

function privateFile(file, maximum = 256 * 1024) {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(descriptor);
    requireCheck(
      stat.isFile() &&
        stat.nlink === 1 &&
        !(stat.mode & 0o077) &&
        stat.size <= maximum,
      "input_invalid",
    );
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

// This fixed launcher writes only to a private /run directory on the child.
// Code and secret-free expected material travel over the pinned SSH stdin.
const PROBE_LAUNCHER = `import json,os,shutil,subprocess,sys,tempfile
os.umask(0o077)
data=json.loads(sys.stdin.buffer.read(256*1024))
directory=tempfile.mkdtemp(prefix='zeros-v2-test-s1-',dir='/run/zeros')
try:
 file=directory+'/probe.mjs'
 with open(file,'x') as stream: stream.write(data['source'])
 node=os.path.realpath('/opt/zeros/current/bin/node')
 result=subprocess.run([node,file],input=json.dumps(data['material']).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=420,env={'PATH':'/usr/bin:/bin','HOME':'/root'})
 if len(result.stdout)>128*1024: raise ValueError()
 sys.stdout.buffer.write(result.stdout)
 sys.exit(result.returncode)
except Exception:
 print('probe_transport_failed',file=sys.stderr)
 sys.exit(1)
finally:
 shutil.rmtree(directory)
`;
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

async function main() {
  const args = process.argv.slice(2),
    cleanupOnly = args[0] === "--cleanup";
  let journal;
  if (cleanupOnly) {
    requireCheck(args.length === 2 && UUID.test(args[1]), "input_invalid");
    journal = JSON.parse(
      privateFile(
        path.join(root, ".context/zeros-v2-test-s1", `${args[1]}.json`),
      ),
    );
  } else {
    requireCheck(
      args.length === 5 &&
        args[0] === "--run" &&
        args[1] === "--workspace" &&
        args[3] === "--template",
      "input_invalid",
    );
    journal = newTemplateSetupJournal(args[2], 1, args[4]);
  }
  requireCheck(
    journal.schema === "zeros.template-setup-repro/v1" &&
      UUID.test(journal.id) &&
      UUID.test(journal.workspaceId) &&
      Number.isSafeInteger(journal.generation) &&
      journal.generation > 0 &&
      BOAT_RESOURCE_ID_PATTERN.test(journal.templateId) &&
      Array.isArray(journal.failedChecks) &&
      journal.failedChecks.every((check) =>
        ["probe_failed", "verification_failed", "cleanup_pending"].includes(
          check,
        ),
      ) &&
      ["source", "fork", "bootstrap", "probe"].includes(journal.phase),
    "input_invalid",
  );
  if (journal.probe !== null)
    journal.probe = sanitizeProbeReport(journal.probe);
  const config = templateSetupReproConfig(
    parseEnv(privateFile(path.join(root, ".env.agent"))),
  );
  const directory = path.join(root, ".context/zeros-v2-test-s1");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${journal.id}.json`);
  const save = (value) => {
    const temporary = `${file}.${randomUUID()}.tmp`,
      fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  };
  const boat = new BoatApiClient({
    apiKey: config.apiKey,
    billingOrg: config.billingOrg,
    timeoutMs: 30000,
    diagnostics: () => {},
  });
  const { Pool } = createRequire(
    new URL("../../apps/control-plane/package.json", import.meta.url),
  )("pg");
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 10000,
    statement_timeout: 15000,
    idle_in_transaction_session_timeout: 15000,
    application_name: "zeros-v2-test-s1",
    options: "-c role=none -c default_transaction_read_only=on",
  });
  pool.on("error", () => {});
  const dependencies = {
    save,
    request: boat.request.bind(boat),
    load: () => readTemplateSetupSource(pool, journal),
    ready: async (_journal, material) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        try {
          const { sandbox } = await boat.request(
            `/sandboxes/${journal.childId}`,
          );
          requireCheck(
            sandbox?.id === journal.childId &&
              sandbox.team?.id?.toLowerCase() ===
                config.billingOrg.toLowerCase() &&
              (sandbox.sourceSandboxId === undefined ||
                sandbox.sourceSandboxId === journal.templateId),
            "child_invalid",
          );
          const response = await boat.request(
            `/sandboxes/${journal.childId}/commands`,
            {
              method: "POST",
              body: { command: STATUS_COMMAND, timeoutSeconds: 20 },
            },
          );
          const parsed = RuntimeBaseStatusSchema.safeParse(
            JSON.parse(response.stdout),
          );
          if (
            response.success === true &&
            response.exitCode === 0 &&
            !response.timedOut &&
            !response.stdoutTruncated &&
            parsed.success &&
            parsed.data.baseCompatibilityId ===
              material.computer.template.baseCompatibilityId &&
            ["idle", "waiting_for_runtime"].includes(parsed.data.hostState)
          )
            return;
        } catch {
          /* Restore and /run publication can still be in progress. */
        }
        await pause();
      }
      throw new Error("bootstrap_timeout");
    },
    probe: async (_journal, material) => {
      const result = await executeBoatPinnedSsh(
        {
          resourceId: journal.childId,
          command: `/usr/bin/python3 -I -c ${shellQuote(PROBE_LAUNCHER)}`,
          stdin: JSON.stringify({
            source: readFileSync(
              new URL("./template-setup-probe.mjs", import.meta.url),
              "utf8",
            ),
            material,
          }),
          timeoutSeconds: 480,
        },
        { client: boat, maxOutputBytes: 256 * 1024 },
        globalThis.AbortSignal.timeout(540000),
      );
      requireCheck(
        result.exitCode === 0 &&
          !result.stdoutTruncated &&
          typeof result.stdout === "string" &&
          Buffer.byteLength(result.stdout) <= 128 * 1024,
        "probe_invalid",
      );
      return JSON.parse(result.stdout);
    },
  };
  try {
    if (cleanupOnly) await cleanupTemplateSetupFork(journal, dependencies);
    else await runTemplateSetupRepro(journal, config.billingOrg, dependencies);
    process.stdout.write(
      JSON.stringify({
        runId: journal.id,
        templateId: journal.templateId,
        childId: journal.childId,
        phase: journal.phase,
        cleanup: journal.cleanup,
        failedChecks: journal.failedChecks,
        probe: journal.probe,
      }) + "\n",
    );
    process.exitCode =
      journal.cleanup === "pending" ||
      (!cleanupOnly && journal.failedChecks.length > 0)
        ? 1
        : 0;
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    process.stderr.write(
      "Template setup reproduction failed; retain the cleanup journal.\n",
    );
    process.exitCode = 1;
  });
