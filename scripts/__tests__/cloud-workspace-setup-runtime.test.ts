import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudRuntimeResolver } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { cloudRuntimeFixture } from "../../apps/desktop/src/engine/agents/containment/__tests__/cloud-runtime-fixture";

const host = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs", async (original) => ({
  ...await original<typeof import("../cloud-workspace-validation/sandbox/cloud-runtime-root.mjs")>(),
  resolveCloudRuntime: host.resolve,
}));

const request = {
  admission: {
    endpoint: "https://control.example.test/internal/v1/cloud-workspaces/setup/admission",
    token: "test-only",
  },
  execution: {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    organizationId: "00000000-0000-4000-8000-000000000002",
    generation: 2,
    setupRunId: "00000000-0000-4000-8000-000000000003",
    executionFence: 7,
  },
  expected: {
    imageRef: "snapshot:zeros-cloud-v2",
    imageSourceCommit: "d".repeat(40),
    repositoryRevision: "main",
    settingsVersion: 3,
    settingsSha256: "e".repeat(64),
  },
};
const legacyBody = { materialVersion: 2, ...request.execution, expected: request.expected };
let tree: ReturnType<typeof cloudRuntimeFixture>;
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.resetModules();
  tree = cloudRuntimeFixture();
  host.resolve.mockReset().mockImplementation(createCloudRuntimeResolver({
    filesystem: tree.filesystem,
    executable: () => "/usr/bin/node",
    isEngine: () => false,
  }).resolve);
  // Stop immediately after redemption so these tests never perform setup or
  // contact a provider. The real resolver validates the isolated host files.
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  tree.dispose();
});

async function redemptionBody() {
  const { redeemMaterials } = await import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs");
  await expect(redeemMaterials(request)).rejects.toMatchObject({ code: "admission_temporarily_unavailable" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toBe(request.admission.endpoint);
  return JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
}

describe("cloud setup runtime redemption witness", () => {
  it("sends exactly the six v4 identity fields from the validated active descriptor", async () => {
    const { runtimeId, manifestSha256, baseCompatibilityId, installerReceiptSha256, bootId, supervisorSessionId } = tree.descriptor;
    expect(await redemptionBody()).toEqual({
      ...legacyBody,
      checkoutSourceVersion: 1,
      runtime: { runtimeId, manifestSha256, baseCompatibilityId, installerReceiptSha256, bootId, supervisorSessionId },
    });
    expect(fetchMock.mock.calls[0][1]!.headers).toHaveProperty("X-Zeros-Resume-Existing", "1");
  });

  it.each([1, 2, 3])("refuses worker v%i before material redemption", async (version) => {
    tree.write("/etc/zeros/cloud-worker.json", { ...tree.marker, version, profile: `zeros-cloud-worker-v${version}` });
    tree.write("/run/zeros/active-runtime.json", "invalid", 0o600);
    await expect(import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs")
      .then(({ redeemMaterials }) => redeemMaterials(request))).rejects.toThrow(/runtime descriptor/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { installerReceiptSha256: "invalid" },
    { supervisorSessionId: undefined },
  ])("rejects a malformed v4 descriptor before redemption: %j", async (change) => {
    tree.write("/run/zeros/active-runtime.json", { ...tree.descriptor, ...change }, 0o600);
    await expect(import("../cloud-workspace-validation/sandbox/setup-cloud-workspace.mjs")
      .then(({ redeemMaterials }) => redeemMaterials(request))).rejects.toThrow(/runtime descriptor/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
