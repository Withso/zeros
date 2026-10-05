import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceBackendConfig, Config } from "../config.js";
import type { Tx } from "../db.js";
import { BoatCloudBuilderVms } from "./cloud-builder-vm.js";
import { DatabaseBuilderVmOperationStore } from "./cloud-builder-vm-store.js";
import { BUILDER_WALLET } from "./cloud-builder-vm-test-fixtures.js";
import { templateRuntime } from "./computer-template-test-fixtures.js";
import { ComputerTemplateWorker } from "./computer-template-worker.js";
import { createComputerTemplateWorker } from "./computer-template-worker-factory.js";
import { DatabaseCloudComputerV2Service } from "./computer-v2.js";
import * as runtimeSelection from "./runtime-selection.js";

// Keep the actual Boat adapters and runtime selector wiring; only capture the
// worker's dependencies here. The integration test starts the real worker.
vi.mock("./computer-template-worker.js", () => ({ ComputerTemplateWorker: vi.fn(class {}) }));

const pool = new pg.Pool();
const github = { mintContentsRead: vi.fn(), revoke: vi.fn() };
const artifacts = { presignGet: vi.fn(), presignCreatePut: vi.fn(), head: vi.fn() };
function config() {
  return { deploymentChannel: "alpha", cloudWorkspaces: {
    provider: "boat", apiKey: "zeros-v2-test-boat-key",
    boat: { accountScope: "zeros-v2-test-template-account", billingOrg: BUILDER_WALLET, ttlSeconds: null },
    computerMaxConcurrentBuilds: 3,
    runtime: { qualificationMode: "smoke", qualificationEnabled: false, newWorkspaceProfile: "legacy", staffOnly: true },
  } } as Config;
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
afterAll(async () => { await pool.end(); });

describe("computer template worker factory", () => {
  it.each(["development", "beta", "production"] as const)("disables template builds on %s", channel => {
    const value = config();
    value.deploymentChannel = channel;
    expect(createComputerTemplateWorker(value, pool, artifacts, github)).toBeNull();
    expect(ComputerTemplateWorker).not.toHaveBeenCalled();
  });

  it.each(["no cloud", "non-Boat", "no Boat settings", "no artifacts"])("disables builds with %s", missing => {
    const value = config();
    if (missing === "no cloud") value.cloudWorkspaces = null;
    if (missing === "non-Boat") value.cloudWorkspaces!.provider = "daytona";
    if (missing === "no Boat settings") delete value.cloudWorkspaces!.boat;
    expect(createComputerTemplateWorker(value, pool, missing === "no artifacts" ? null : artifacts, github)).toBeNull();
    expect(ComputerTemplateWorker).not.toHaveBeenCalled();
  });

  it.each(["full", "smoke"] as const)("wires the production adapters and %s runtime admission without qualification-worker enablement", async mode => {
    const value = config();
    const cloud = value.cloudWorkspaces!;
    cloud.runtime!.qualificationMode = mode;
    const worker = createComputerTemplateWorker(value, pool, artifacts, github);
    expect(worker).toBeInstanceOf(ComputerTemplateWorker);
    const deps = vi.mocked(ComputerTemplateWorker).mock.calls[0]![0];
    expect(deps).toMatchObject({ pool, github, artifacts, accountScope: cloud.boat!.accountScope,
      billingOrg: BUILDER_WALLET, maxConcurrentBuilds: 3 });
    expect(deps.service).toBeInstanceOf(DatabaseCloudComputerV2Service);
    expect(deps.operations).toBeInstanceOf(DatabaseBuilderVmOperationStore);
    expect(deps.vms).toBeInstanceOf(BoatCloudBuilderVms);
    const select = vi.spyOn(runtimeSelection, "selectCloudRuntime").mockResolvedValue(null);
    const validate = vi.spyOn(runtimeSelection, "loadPinnedCloudRuntime").mockResolvedValue(null);
    const tx = {} as Tx;
    expect(await deps.runtime.select(tx)).toBeNull();
    expect(select).toHaveBeenCalledWith(tx, mode);
    expect(await deps.runtime.validate(tx, templateRuntime)).toBe(false);
    expect(validate).toHaveBeenCalledWith(tx, expect.objectContaining({
      baseImageId: templateRuntime.baseImageId, runtimeId: templateRuntime.descriptor.runtimeId,
      manifestSha256: templateRuntime.descriptor.manifestSha256,
    }), mode);
  });

  it("reuses the entrypoint's Cloud Computer service", () => {
    const value = config();
    const service = new DatabaseCloudComputerV2Service(pool, value.cloudWorkspaces as CloudWorkspaceBackendConfig);
    createComputerTemplateWorker(value, pool, artifacts, github, service);
    expect(vi.mocked(ComputerTemplateWorker).mock.calls[0]![0].service).toBe(service);
  });
});
