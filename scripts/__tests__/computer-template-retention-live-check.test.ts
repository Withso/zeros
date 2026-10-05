import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
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

describe("template retention live runbook boundaries", () => {
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
