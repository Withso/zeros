import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudComputerTemplateRetentionWorker } from "../../apps/control-plane/src/cloud-workspaces/computer-template-retention.js";
import {
  runComputerTemplateRetentionLiveCheck,
  type ComputerTemplateRetentionAlphaFixture,
  type RetentionLiveReport,
} from "../cloud-workspace-validation/computer-template-retention-live-check.mts";

const credentials = {
  ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-alpha",
  ZEROS_R2_ALPHA_BUCKET: "zeros-cloud-workspaces-alpha",
};
const report = (): RetentionLiveReport => ({
  schema: "zeros.computer-template-retention-live/v1",
  runId: "00000000-0000-4000-8000-000000000001",
  status: "running",
  resources: [],
  cleanupConfirmed: false,
});

afterEach(() => vi.restoreAllMocks());

describe("template retention live runbook boundaries", () => {
  it("uses four builds to check active, previous and source holds, then confirms cleanup", async () => {
    const builds: Array<{
      id: string;
      configId: string;
      version: number;
      state: "succeeded";
      templateState: "ready" | "retired";
    }> = [];
    let namePrefix = "";
    let erasing = false;
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("UPDATE organizations")) erasing = true;
      const rows = sql.includes("SELECT template.build_id")
        ? builds.map((build) => ({
            build_id: build.id,
            sandbox_id: `bx_fixture${build.version}`,
            deletion_operation_id:
              build.templateState === "retired" ? "bdop_fixture" : null,
            name: `${namePrefix}-${build.version}`,
            state: build.templateState === "retired" ? "deleted" : "archived",
            closed: false,
          }))
        : [];
      return { rows, rowCount: rows.length };
    });
    const activate = vi.fn().mockResolvedValue({ activated: true });
    const buildNext = vi.fn(async () => {
      const version = builds.length + 1;
      builds.push({
        id: `build-${version}`,
        configId: "configuration",
        version,
        state: "succeeded",
        templateState: "ready",
      });
    });
    // The database-backed suite exercises the worker. Here its outcomes drive
    // the operator harness without contacting a database or provider.
    vi.spyOn(CloudComputerTemplateRetentionWorker.prototype, "tick")
      .mockImplementation(async () => {
        const retiring = builds.filter(
          (build) =>
            build.templateState === "ready" && (erasing || build.version === 4),
        );
        for (const build of retiring) build.templateState = "retired";
        return retiring.length;
      });
    const close = vi.fn();
    const factory = vi.fn(async (input: { namePrefix: string }) => {
      namePrefix = input.namePrefix;
      return {
        channel: "alpha",
        namePrefix,
        pool: {
          options: {
            connectionString: "postgresql://localhost/zeros_v2_test_retention",
          },
          connect: async () => ({ query, release: vi.fn() }),
        },
        service: {
          read: async () => ({
            revision: builds.length + activate.mock.calls.length,
            history: { builds: builds.slice().reverse() },
          }),
          activate,
        },
        organizationId: "organization",
        userId: "user",
        workspaceId: "workspace",
        options: {},
        buildNext,
        cleanupFailedBuilds: async () => true,
        close,
      } as unknown as ComputerTemplateRetentionAlphaFixture;
    });
    const result = report();
    await runComputerTemplateRetentionLiveCheck(
      factory,
      credentials,
      result,
      vi.fn(),
    );
    expect(buildNext).toHaveBeenCalledTimes(4);
    expect(activate.mock.calls.map((args) => args[2])).toEqual([2, 1]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO cloud_workspace_computer_sources"),
      ["workspace", "organization", "build-3", "configuration"],
    );
    expect(result).toMatchObject({ status: "passed", cleanupConfirmed: true });
    expect(result.resources).toHaveLength(4);
    expect(result.resources.every((resource) => resource.deleted)).toBe(true);
    expect(close).toHaveBeenCalledWith({ cleanupConfirmed: true });
  });

  it("requires Alpha resource names before opening an adapter", async () => {
    const factory = vi.fn();
    await expect(
      runComputerTemplateRetentionLiveCheck(factory, {}, report(), vi.fn()),
    ).rejects.toThrow("Retention live check failed");
    expect(factory).not.toHaveBeenCalled();
  });

  it.each(["channel", "database", "namespace"])(
    "refuses an invalid %s before builds or cleanup mutations",
    async (mismatch) => {
      const buildNext = vi.fn();
      const cleanupFailedBuilds = vi.fn();
      const query = vi.fn();
      const close = vi.fn();
      const factory = vi.fn(
        async ({ namePrefix }: { namePrefix: string }) =>
          ({
            channel: mismatch === "channel" ? "production" : "alpha",
            namePrefix: mismatch === "namespace" ? "other-prefix" : namePrefix,
            pool: {
              options: {
                connectionString:
                  mismatch === "database"
                    ? "postgresql://remote.invalid/zeros_v2_test_retention"
                    : "postgresql://localhost/zeros_v2_test_retention",
              },
              query,
            },
            organizationId: "00000000-0000-4000-8000-000000000002",
            buildNext,
            cleanupFailedBuilds,
            close,
          }) as unknown as ComputerTemplateRetentionAlphaFixture,
      );
      await expect(
        runComputerTemplateRetentionLiveCheck(
          factory,
          credentials,
          report(),
          vi.fn(),
        ),
      ).rejects.toThrow("Retention live check failed");
      expect(buildNext).not.toHaveBeenCalled();
      expect(cleanupFailedBuilds).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith({ cleanupConfirmed: false });
    },
  );

  it("prints a closed failure without paths or exception text", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/cloud-workspace-validation/computer-template-retention-live-check.mts",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schema: "zeros.computer-template-retention-live/v1",
      ok: false,
      check: "run_or_cleanup_failed",
    });
  });
});
