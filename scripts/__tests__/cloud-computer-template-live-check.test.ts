import { describe, expect, it, vi } from "vitest";
import {
  runComputerTemplateLiveCheck,
  type ComputerTemplateAlphaFactory,
  type ComputerTemplateAlphaFixture,
} from "../cloud-workspace-validation/computer-template-live-check";

const credentials = {
  ZEROS_R2_ALPHA_BUCKET: "zeros-cloud-workspaces-alpha",
  ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-alpha",
};
const report = () => ({
  schema: "zeros.computer-template-live-check/v1" as const,
  runId: "11111111-1111-4111-8111-111111111111",
  status: "running" as const,
  checks: [],
  resources: [],
  cleanupConfirmed: false,
});

describe("computer template live runbook boundaries", () => {
  it("rejects a non-Alpha credential file before opening any adapter", async () => {
    const factory = vi.fn<ComputerTemplateAlphaFactory>();
    await expect(
      runComputerTemplateLiveCheck(
        factory,
        { ...credentials, ZEROS_R2_ALPHA_BUCKET: "other" },
        report(),
        vi.fn(),
      ),
    ).rejects.toThrow("computer_template_live_check_failed");
    expect(factory).not.toHaveBeenCalled();
  });

  it.each([
    "postgresql://db.example.test/zeros_v2_test_fixture",
    "postgresql://localhost/postgres",
  ])(
    "refuses mutations in a shared database (%s)",
    async (connectionString) => {
      const close = vi.fn(async () => {}),
        query = vi.fn(),
        create = vi.fn();
      const fixture = {
        channel: "alpha",
        close,
        deps: {
          pool: { options: { connectionString }, query },
          vms: { create },
        },
      } as unknown as ComputerTemplateAlphaFixture;
      await expect(
        runComputerTemplateLiveCheck(
          async () => fixture,
          credentials,
          report(),
          vi.fn(),
        ),
      ).rejects.toThrow("computer_template_live_check_failed");
      expect(query).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith({ cleanupConfirmed: false });
    },
  );
});
