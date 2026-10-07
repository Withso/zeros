/** Operator runbook. Real Alpha Boat adapters, disposable LOCAL database.
 * C3's fixture factory supplies qualified, sanitized template builds. */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs, parseEnv } from "node:util";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { withSystemTx } from "../../apps/control-plane/src/db.js";
import { lockCloudComputerOrganization } from "../../apps/control-plane/src/cloud-workspaces/computer-identity.js";
import { CloudComputerTemplateRetentionWorker } from "../../apps/control-plane/src/cloud-workspaces/computer-template-retention.js";
import type { DatabaseCloudComputerV2Service } from "../../apps/control-plane/src/cloud-workspaces/computer-v2.js";

export type ComputerTemplateRetentionAlphaFixture = {
  channel: "alpha";
  namePrefix: string;
  pool: pg.Pool;
  service: DatabaseCloudComputerV2Service;
  organizationId: string;
  userId: string;
  /** Local metadata only: no Boat workspace allocation or engine admission. */
  workspaceId: string;
  options: ConstructorParameters<
    typeof CloudComputerTemplateRetentionWorker
  >[1];
  /** Run C3's real Build -> verified capture pipeline once. */
  buildNext(): Promise<void>;
  cleanupFailedBuilds(): Promise<boolean>;
  close(input: { cleanupConfirmed: boolean }): Promise<void>;
};
export type ComputerTemplateRetentionAlphaFactory = (input: {
  credentials: Readonly<Record<string, string | undefined>>;
  runId: string;
  namePrefix: string;
  cleanupOnly: boolean;
}) => Promise<ComputerTemplateRetentionAlphaFixture>;
export type RetentionLiveReport = {
  schema: "zeros.computer-template-retention-live/v1";
  runId: string;
  status: "running" | "passed" | "failed";
  resources: Array<{
    buildId: string;
    sandboxId: string | null;
    deletionOperationId: string | null;
    deleted: boolean;
  }>;
  cleanupConfirmed: boolean;
};
function requireCheck(value: unknown): asserts value {
  if (!value) throw new Error("Retention live check failed");
}

export async function runComputerTemplateRetentionLiveCheck(
  factory: ComputerTemplateRetentionAlphaFactory,
  credentials: Readonly<Record<string, string | undefined>>,
  report: RetentionLiveReport,
  save: () => Promise<void>,
  cleanupOnly = false,
) {
  requireCheck(
    credentials.ZEROS_PLANETSCALE_ALPHA_DATABASE ===
      "zeros-control-plane-alpha" &&
      credentials.ZEROS_R2_ALPHA_BUCKET === "zeros-cloud-workspaces-alpha",
  );
  const namePrefix = `zeros-v2-test-c6-${report.runId.replaceAll("-", "").slice(0, 12)}`;
  const fixture = await factory({
    credentials,
    runId: report.runId,
    namePrefix,
    cleanupOnly,
  });
  let validated = false;
  const { pool, organizationId: org } = fixture;
  const refresh = async () => {
    const rows = await withSystemTx(
      pool,
      async (tx) =>
        (
          await tx.query<{
            build_id: string;
            sandbox_id: string | null;
            deletion_operation_id: string | null;
            name: string;
            state: string;
            closed: boolean;
          }>(
            `SELECT template.build_id,operation.sandbox_id,operation.deletion_operation_id,
         operation.intent->>'name' AS name,operation.state,operation.create_closed_at IS NOT NULL AS closed
       FROM cloud_computer_templates template JOIN cloud_builder_vm_operations operation
         ON operation.account_scope=template.account_scope AND operation.operation_key='computer-build:'||template.build_id::text
       WHERE template.org_id=$1 AND operation.purpose='computer-build'`,
            [org],
          )
        ).rows,
    );
    requireCheck(rows.every((row) => row.name.startsWith(namePrefix + "-")));
    report.resources = rows.map((row) => ({
      buildId: row.build_id,
      sandboxId: row.sandbox_id,
      deletionOperationId: row.deletion_operation_id,
      deleted:
        row.state === "deleted" || (row.sandbox_id === null && row.closed),
    }));
    await save();
  };
  try {
    const target = new URL(pool.options.connectionString ?? "");
    requireCheck(
      fixture.channel === "alpha" &&
        fixture.namePrefix === namePrefix &&
        ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) &&
        /^\/zeros_v2_test_[a-z0-9_]+$/.test(target.pathname),
    );
    requireCheck(
      (
        await withSystemTx(pool, (tx) =>
          tx.query(
            "SELECT 1 FROM cloud_workspace_provider_operations WHERE org_id=$1",
            [org],
          ),
        )
      ).rowCount === 0,
    );
    validated = true;
    const worker = new CloudComputerTemplateRetentionWorker(
      pool,
      fixture.options,
    );
    try {
      if (!cleanupOnly) {
        requireCheck(
          (await fixture.service.read(org, fixture.userId)).revision === 0,
        );
        for (let index = 0; index < 14; index++) {
          try {
            await fixture.buildNext();
          } finally {
            await refresh();
          }
        }
        const versions = (
          await fixture.service.read(org, fixture.userId)
        ).history.builds
          .slice()
          .reverse();
        requireCheck(
          versions.length === 14 &&
            versions.every(
              (row) =>
                row.state === "succeeded" && row.templateState === "ready",
            ),
        );
        for (const version of [versions[1]!, versions[0]!])
          await fixture.service.activate(org, fixture.userId, version.version, {
            expectedRevision: (await fixture.service.read(org, fixture.userId))
              .revision,
            operationId: randomUUID(),
          });
        await withSystemTx(pool, async (tx) => {
          await lockCloudComputerOrganization(tx, org);
          await tx.query(
            `INSERT INTO cloud_workspace_computer_sources(workspace_id,generation,org_id,build_id,template_id,config_id)
             VALUES($1,1,$2,$3,$3,$4)`,
            [fixture.workspaceId, org, versions[2]!.id, versions[2]!.configId],
          );
        });
        requireCheck(
          (await worker.tick(org)) === 1 && (await worker.tick(org)) === 0,
        );
        const history = (await fixture.service.read(org, fixture.userId))
          .history.builds;
        requireCheck(
          history.every(
            (row) =>
              row.templateState ===
              (row.id === versions[3]!.id ? "retired" : "ready"),
          ),
        );
        await refresh();
        requireCheck(
          report.resources.find((row) => row.buildId === versions[3]!.id)
            ?.deleted,
        );
        report.status = "passed";
      }
    } catch {
      report.status = "failed";
    } finally {
      // Only this disposable local DB changes. Erasure releases head/history
      // holds; the same production retention worker deletes the real sandboxes.
      await withSystemTx(pool, async (tx) => {
        await tx.query(
          "UPDATE cloud_workspaces SET status='deleted',desired_state='deleted',deleted_at=coalesce(deleted_at,now()),data_deleted_at=now() WHERE org_id=$1",
          [org],
        );
        await tx.query(
          "UPDATE organizations SET lifecycle_status='purging' WHERE id=$1",
          [org],
        );
      });
      const failedBuildsCleaned = await fixture.cleanupFailedBuilds();
      for (let attempt = 0; attempt < 3; attempt++) await worker.tick(org);
      await refresh();
      report.cleanupConfirmed =
        failedBuildsCleaned && report.resources.every((row) => row.deleted);
      await save();
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
  const file = path.resolve(args.report!);
  requireCheck(
    file.startsWith(path.resolve(".context") + path.sep) &&
      file.endsWith(".json"),
  );
  const report: RetentionLiveReport = args.cleanup
    ? JSON.parse(await fs.readFile(file, "utf8"))
    : {
        schema: "zeros.computer-template-retention-live/v1",
        runId: randomUUID(),
        status: "running",
        resources: [],
        cleanupConfirmed: false,
      };
  requireCheck(
    report.schema === "zeros.computer-template-retention-live/v1" &&
      /^[a-f0-9-]{36}$/.test(report.runId),
  );
  if (!args.cleanup)
    await fs.writeFile(file, JSON.stringify(report), {
      mode: 0o600,
      flag: "wx",
    });
  const save = () =>
    fs.writeFile(file, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  const credentials = parseEnv(await fs.readFile(".env.agent", "utf8"));
  const adapter = await import(pathToFileURL(path.resolve(args.adapter!)).href);
  requireCheck(
    typeof adapter.openComputerTemplateRetentionAlphaFixture === "function",
  );
  await runComputerTemplateRetentionLiveCheck(
    adapter.openComputerTemplateRetentionAlphaFixture,
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
        '{"schema":"zeros.computer-template-retention-live/v1","ok":true,"cleanupConfirmed":true}',
      ),
    )
    .catch(() => {
      console.error(
        '{"schema":"zeros.computer-template-retention-live/v1","ok":false,"check":"run_or_cleanup_failed"}',
      );
      process.exitCode = 1;
    });
}
