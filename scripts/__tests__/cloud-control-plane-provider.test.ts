import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
}));

vi.mock(
  "../../apps/control-plane/src/cloud-workspaces/daytona-provider",
  () => ({
    DaytonaWorkspaceProvider: class {
      constructor(config: Record<string, unknown>) {
        captured.configs.push(config);
      }
    },
  }),
);

vi.mock("../cloud-workspace-validation/config", () => ({
  DAYTONA_API_URL: "https://daytona.example.test/api",
  DAYTONA_PREVIEW_HOST_SUFFIXES: ["preview.example.test"],
  DAYTONA_SSH_HOSTS: ["ssh.example.test"],
  DAYTONA_TARGET: "eu",
  RESOURCES: { cpu: 4, memory: 8, disk: 20 },
  VALIDATION_AUTO_DELETE_MINUTES: 720,
  loadSnapshotAttestation: () => ({ snapshotId: "snapshot-id" }),
  requireEnv: () => "test-api-key",
}));

import { makeQualifiedControlPlaneProvider } from "../cloud-workspace-validation/control-plane-provider";

describe("qualified control-plane provider", () => {
  beforeEach(() => captured.configs.splice(0));

  it("uses the configured production access-host allowlists", () => {
    makeQualifiedControlPlaneProvider();

    expect(captured.configs).toHaveLength(1);
    expect(captured.configs[0]).toMatchObject({
      allowedSshHosts: ["ssh.example.test"],
      allowedPreviewHostSuffixes: ["preview.example.test"],
    });
  });
});
