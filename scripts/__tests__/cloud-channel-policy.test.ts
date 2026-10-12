import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const policy = JSON.parse(readFileSync(new URL("../../apps/control-plane/src/cloud-workspace-channels.json", import.meta.url), "utf8"));

afterEach(() => {
  vi.doUnmock("../../apps/control-plane/src/cloud-workspace-channels.json");
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("reversible cloud channel pause", () => {
  it.each([["development", "dev"], ["alpha", "alpha"], ["beta", "beta"], ["production", "stable"]])(
    "uses the same %s switch in the control plane and %s desktop", async (deployment, desktop) => {
      const cp = await import("../../apps/control-plane/src/cloud-workspaces/channel-policy");
      const client = await import("../../apps/desktop/shared/cloud-workspace-channel");
      expect(cp.cloudWorkspaceChannelEnabled(deployment)).toBe(policy[deployment]);
      expect(client.cloudWorkspaceChannelEnabled(desktop)).toBe(policy[deployment]);
    },
  );

  it.each([["beta", "beta"], ["production", "stable"]])(
    "unpauses %s by changing only its configuration switch in the next build", async (deployment, desktop) => {
      vi.resetModules();
      vi.doMock("../../apps/control-plane/src/cloud-workspace-channels.json", () => ({
        default: { ...policy, [deployment]: true },
      }));
      vi.stubEnv("VITE_ZEROS_CHANNEL", desktop);
      vi.stubEnv("ZEROS_CHANNEL", desktop);
      const cp = await import("../../apps/control-plane/src/cloud-workspaces/channel-policy");
      const renderer = await import("../../apps/desktop/src/renderer/config/release-channel");
      const engine = await import("../../apps/desktop/src/engine/cloud-workspace-capability");
      const { promotionConfig } = await import("../release/contracts");
      expect(cp.cloudWorkspaceChannelEnabled(deployment)).toBe(true);
      expect(renderer.isFeatureEnabled("cloud-workspaces")).toBe(true);
      expect(engine.cloudWorkspaceDesktopCapabilityEnabled({ bakedCapability: true })).toBe(true);
      // The same release configuration requires cloud and qualification again.
      const uuid = "11111111-1111-4111-8111-111111111111";
      expect(promotionConfig({ RELEASE_CHANNEL: deployment, RELEASE_SHA: "a".repeat(40), GITHUB_SHA: "a".repeat(40),
        RELEASE_BRANCH: "release/1.2.3", GITHUB_REPOSITORY: "example/zeros", GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1",
        ZEROS_HOSTED_PROMOTION: "enabled", ZEROS_CLOUD_WORKSPACES_ENABLED: "true", ZEROS_WORKER_PROMOTION: "enabled",
        RAILWAY_DEPLOY_TOKEN: "synthetic", RAILWAY_PROJECT_ID: uuid, RAILWAY_ENVIRONMENT_ID: uuid, RAILWAY_SERVICE_ID: uuid,
        PLANETSCALE_SERVICE_TOKEN_ID: "synthetic", PLANETSCALE_SERVICE_TOKEN: "synthetic", PLANETSCALE_ORG: "example",
        PLANETSCALE_DATABASE: `zeros-control-plane-${deployment}`, PLANETSCALE_BRANCH: "main",
        CLOUDFLARE_API_TOKEN: "synthetic", CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
        CF_PAGES_APP_PROJECT: deployment === "beta" ? "zeros-web-beta" : "zeros-web",
        CF_PAGES_OPS_PROJECT: deployment === "beta" ? "" : "zeros-ops", AUTH_PROVIDER: "workos", CLOUD_WORKSPACE_PROVIDER: "boat",
      })).toMatchObject({ cloudRequired: true, requireQualifiedWorker: true });
    },
  );
});
