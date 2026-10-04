/** Operator runbook, never imported by the control-plane entrypoint.
 * Pending integration: the operator supplies B4/B5b/B7 adapters after they land.
 * Only the disposable LOCAL database may be mutated. Provider credentials are
 * read from .env.agent and passed in memory to the Alpha adapter factory. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import { withSystemTx } from "../../apps/control-plane/src/db.js";
import {
  ComputerTemplateWorker,
  type ComputerTemplateWorkerDependencies,
} from "../../apps/control-plane/src/cloud-workspaces/computer-template-worker.js";
import type { CloudComputerV2Repository } from "../../apps/control-plane/src/cloud-workspaces/computer-v2-contract.js";
import { computerTemplateBuilderName } from "../../apps/control-plane/src/cloud-workspaces/computer-template-name.js";

export type ComputerTemplateAlphaFixture = {
  channel: "alpha";
  deps: ComputerTemplateWorkerDependencies;
  organizationId: string;
  userId: string;
  repositories: CloudComputerV2Repository[];
  /** Keep the local journal/database for --cleanup if provider cleanup is not
   * confirmed. Never remove an Alpha registry row, base or runtime artifact. */
  close(input: { cleanupConfirmed: boolean }): Promise<void>;
};
export type ComputerTemplateAlphaFactory = (input: {
  credentials: Readonly<Record<string, string | undefined>>;
  runId: string;
  namePrefix: string;
  cleanupOnly: boolean;
}) => Promise<ComputerTemplateAlphaFixture>;
type Case =
  | "success"
  | "script_failure"
  | "tcb_modified"
  | "cancelled"
  | "deadline"
  | "superseded";
type Report = {
  schema: "zeros.computer-template-live-check/v1";
  runId: string;
  status: "running" | "passed" | "failed";
  checks: Array<{
    check: Case;
    buildId: string;
    ok: boolean;
    elapsedMs: number;
  }>;
  resources: Array<{
    buildId: string;
    sandboxId: string | null;
    deleted: boolean;
  }>;
  cleanupConfirmed: boolean;
};
const requireCheck = (condition: unknown): void => {
  if (!condition) throw new Error("computer_template_live_check_failed");
};
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 250));

async function runCase(
  fixture: ComputerTemplateAlphaFixture,
  worker: ComputerTemplateWorker,
  check: Case,
  report: Report,
  save: () => Promise<void>,
) {
  const { service, pool } = fixture.deps,
    org = fixture.organizationId,
    user = fixture.userId;
  const before = await service.read(org, user);
  const started = Date.now();
  const scripts: Record<Case, string> = {
    success:
      "printf 'zeros-v2-test-install-ok\\n'\ninstall -d /usr/local/share/zeros-v2-test-computer\nprintf 'installed\\n' > /usr/local/share/zeros-v2-test-computer/marker",
    script_failure: "printf 'zeros-v2-test-install-failure\\n'\nexit 17",
    tcb_modified: "chmod 0644 /etc/systemd/system/zeros-host.service",
    cancelled: "sleep 30",
    deadline: "sleep 30",
    superseded: "sleep 5",
  };
  const requested = await service.build(org, user, {
    expectedRevision: before.revision,
    operationId: randomUUID(),
    draft: {
      repositories: fixture.repositories,
      installScript: scripts[check],
      timeoutSeconds: 60,
    },
  });
  const entry = { check, buildId: requested.build.id, ok: false, elapsedMs: 0 };
  report.checks.push(entry);
  await save(); // Stable build ID lets --cleanup recover an interrupted run.
  let finished = false,
    workerFailed = false;
  const running = worker
    .tick()
    .catch(() => {
      workerFailed = true;
    })
    .finally(() => {
      finished = true;
    });
  try {
    if (["cancelled", "deadline", "superseded"].includes(check)) {
      while (!finished) {
        const current = await service.read(org, user);
        if (
          current.latestBuild?.id === entry.buildId &&
          current.latestBuild.stage === "install"
        )
          break;
        requireCheck(Date.now() - started < 900_000);
        await pause();
      }
      requireCheck(!finished);
      const current = await service.read(org, user);
      if (check === "cancelled")
        await service.cancel(org, user, entry.buildId, {
          expectedRevision: current.revision,
        });
      if (check === "deadline")
        await withSystemTx(pool, (tx) =>
          tx.query(
            "UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1 AND org_id=$2 AND state='running'",
            [entry.buildId, org],
          ),
        );
      if (check === "superseded")
        await service.saveDraft(org, user, {
          expectedRevision: current.revision,
          repositories: fixture.repositories,
          installScript: "true",
          timeoutSeconds: 60,
        });
    }
    await running;
    requireCheck(!workerFailed);
    const current = await service.read(org, user),
      build = current.latestBuild;
    requireCheck(build?.id === entry.buildId);
    if (check === "success") {
      requireCheck(
        build?.state === "succeeded" &&
          build.templateState === "ready" &&
          current.active?.id === entry.buildId,
      );
      const logs = await service.logs(org, user, entry.buildId, { after: 0 });
      requireCheck(
        logs.entries.some((row) =>
          row.text.includes("zeros-v2-test-install-ok"),
        ),
      );
    } else {
      requireCheck(current.active?.id === before.active?.id);
      if (check === "cancelled" || check === "superseded")
        requireCheck(build?.state === check);
      else
        requireCheck(
          build?.state === "failed" &&
            build.errorCode ===
              (
                {
                  script_failure: "install_failed",
                  tcb_modified: "tcb_modified",
                  deadline: "build_timeout",
                } as const
              )[check],
        );
    }
    entry.ok = true;
  } finally {
    await running;
    entry.elapsedMs = Date.now() - started;
    await save();
  }
}

async function cleanup(
  fixture: ComputerTemplateAlphaFixture,
  worker: ComputerTemplateWorker,
  report: Report,
  save: () => Promise<void>,
) {
  const { pool, service, vms } = fixture.deps,
    org = fixture.organizationId;
  const current = await service.read(org, fixture.userId);
  if (
    current.latestBuild &&
    ["running", "queued"].includes(current.latestBuild.state)
  )
    await service.cancel(org, fixture.userId, current.latestBuild.id, {
      expectedRevision: current.revision,
    });
  // Test-only LOCAL DB. Expiry fences abandoned helpers before deletion. This
  // does not edit deployed Alpha configuration or template references.
  await withSystemTx(pool, async (tx) => {
    await tx.query(
      "UPDATE cloud_computer_v2_builds SET deadline_at=clock_timestamp()-interval '1 second' WHERE org_id=$1 AND state='running'",
      [org],
    );
    await tx.query(
      "UPDATE cloud_computer_templates SET cleanup_retry_at=NULL,cleanup_lease_until=NULL WHERE org_id=$1 AND cleanup_confirmed_at IS NULL",
      [org],
    );
    await tx.query(
      "UPDATE cloud_computer_v2_heads SET active_build_id=NULL,previous_build_id=NULL WHERE org_id=$1",
      [org],
    );
  });
  await worker.tick();
  const resources = await withSystemTx(
    pool,
    async (tx) =>
      (
        await tx.query<{
          build_id: string;
          provider_resource_id: string | null;
          builder_operation_key: string;
          builder_name: string;
          cleanup_confirmed_at: Date | null;
        }>(
          "SELECT build_id,provider_resource_id,builder_operation_key,builder_name,cleanup_confirmed_at FROM cloud_computer_templates WHERE org_id=$1",
          [org],
        )
      ).rows,
  );
  report.resources = resources.map((row) => ({
    buildId: row.build_id,
    sandboxId: row.provider_resource_id,
    deleted: row.cleanup_confirmed_at !== null,
  }));
  await save();
  for (const [index, row] of resources.entries()) {
    requireCheck(
      row.builder_name ===
        computerTemplateBuilderName(
          row.build_id,
          computerTemplateBuilderName(report.runId, "zeros-v2-test-c3"),
        ) && row.builder_operation_key === `computer-build:${row.build_id}`,
    );
    if (report.resources[index]!.deleted) continue;
    if (!row.provider_resource_id) continue; // Unknown allocation remains pending.
    try {
      await vms.delete({
        sandboxId: row.provider_resource_id,
        purpose: "computer-build",
        operationKey: row.builder_operation_key,
      });
      await withSystemTx(pool, (tx) =>
        tx.query(
          "UPDATE cloud_computer_templates SET state='retired',retired_at=coalesce(retired_at,clock_timestamp()),cleanup_confirmed_at=clock_timestamp() WHERE build_id=$1 AND org_id=$2 AND cleanup_confirmed_at IS NULL",
          [row.build_id, org],
        ),
      );
      report.resources[index]!.deleted = true;
    } catch {
      /* Keep IDs and local journal for a later --cleanup. */
    }
    await save();
  }
  report.cleanupConfirmed = report.resources.every((row) => row.deleted);
  await save();
}

/** Factory bootstraps a fresh local test DB and seeds its registry from the
 * approved Alpha registry (read-only). VM/artifact/GitHub adapters are real. */
export async function runComputerTemplateLiveCheck(
  factory: ComputerTemplateAlphaFactory,
  credentials: Readonly<Record<string, string | undefined>>,
  report: Report,
  save: () => Promise<void>,
  cleanupOnly = false,
) {
  requireCheck(
    credentials.ZEROS_R2_ALPHA_BUCKET === "zeros-cloud-workspaces-alpha",
  );
  requireCheck(
    credentials.ZEROS_PLANETSCALE_ALPHA_DATABASE ===
      "zeros-control-plane-alpha",
  );
  const namePrefix = computerTemplateBuilderName(
    report.runId,
    "zeros-v2-test-c3",
  );
  const fixture = await factory({
    credentials,
    runId: report.runId,
    namePrefix,
    cleanupOnly,
  });
  let validated = false;
  try {
    requireCheck(fixture.channel === "alpha");
    const target = new URL(fixture.deps.pool.options.connectionString ?? "");
    requireCheck(
      ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
        /^\/zeros_v2_test_[a-z0-9_]+$/.test(target.pathname),
    );
    requireCheck(fixture.deps.namePrefix === namePrefix);
    requireCheck(fixture.repositories.length > 0);
    validated = true;
    const worker = new ComputerTemplateWorker(fixture.deps);
    try {
      if (!cleanupOnly) {
        requireCheck(
          (
            await fixture.deps.service.read(
              fixture.organizationId,
              fixture.userId,
            )
          ).revision === 0,
        );
        for (const check of [
          "success",
          "script_failure",
          "tcb_modified",
          "cancelled",
          "deadline",
          "superseded",
        ] as const)
          await runCase(fixture, worker, check, report, save);
        report.status = "passed";
      }
    } catch {
      report.status = "failed";
    } finally {
      await cleanup(fixture, worker, report, save);
    }
  } finally {
    await fixture.close({
      cleanupConfirmed: validated && report.cleanupConfirmed,
    });
  }
  requireCheck(report.status === "passed" && report.cleanupConfirmed);
}

async function main() {
  const args = parseArgs({
    options: {
      adapter: { type: "string" },
      report: { type: "string" },
      cleanup: { type: "boolean", default: false },
    },
  }).values;
  requireCheck(args.adapter && args.report);
  const context = path.resolve(".context") + path.sep,
    file = path.resolve(args.report!);
  requireCheck(file.startsWith(context) && file.endsWith(".json"));
  const report: Report = args.cleanup
    ? JSON.parse(await fs.readFile(file, "utf8"))
    : {
        schema: "zeros.computer-template-live-check/v1",
        runId: randomUUID(),
        status: "running",
        checks: [],
        resources: [],
        cleanupConfirmed: false,
      };
  requireCheck(
    report.schema === "zeros.computer-template-live-check/v1" &&
      /^[a-f0-9-]{36}$/.test(report.runId),
  );
  if (!args.cleanup)
    await fs.writeFile(file, JSON.stringify(report), {
      mode: 0o600,
      flag: "wx",
    });
  const save = async () => {
    await fs.writeFile(file, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  };
  const credentials = parseEnv(await fs.readFile(".env.agent", "utf8"));
  const adapter = await import(pathToFileURL(path.resolve(args.adapter!)).href);
  requireCheck(typeof adapter.openComputerTemplateAlphaFixture === "function");
  await runComputerTemplateLiveCheck(
    adapter.openComputerTemplateAlphaFixture,
    credentials,
    report,
    save,
    args.cleanup,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main()
    .then(() =>
      console.log(
        '{"schema":"zeros.computer-template-live-check/v1","ok":true,"cleanupConfirmed":true}',
      ),
    )
    .catch(() => {
      console.error(
        '{"schema":"zeros.computer-template-live-check/v1","ok":false,"check":"run_or_cleanup_failed"}',
      );
      process.exitCode = 1;
    });
}
