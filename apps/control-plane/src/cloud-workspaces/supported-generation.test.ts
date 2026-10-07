import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../authz.js";
import type { Tx } from "../db.js";
import { requireSupportedCloudWorkspaceGeneration } from "./supported-generation.js";
import { loadComputerWorkspaceSource } from "./computer-workspace-source.js";
import { CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION } from "./engine-protocol-version.js";
import { publicCloudError } from "./public-contract.js";

vi.mock("./computer-workspace-source.js", () => ({ loadComputerWorkspaceSource: vi.fn() }));

const scope = { organizationId: "org", workspaceId: "workspace", generation: 3 };
const pin = {
  runtime_id: `r1-${"a".repeat(64)}`, runtime_manifest_sha256: "a".repeat(64),
  runtime_base_image_id: "base", runtime_base_compatibility_id: `bc1-${"b".repeat(64)}`,
  runtime_profile: "zeros-cloud-worker-v4", runtime_engine_protocol_version: CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION,
};
const source = {
  buildId: "build", templateId: "build", configId: "config", sourceSandboxId: "template",
  baseImageId: "base", baseCompatibilityId: pin.runtime_base_compatibility_id,
  templateRuntimeId: pin.runtime_id, protectedContractDigest: "c".repeat(64), repositories: [],
};

describe("supported cloud workspace generation", () => {
  const query = vi.fn();
  const tx = { query } as unknown as Tx;
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [pin] });
    vi.mocked(loadComputerWorkspaceSource).mockResolvedValue(source);
  });

  it("exposes the terminal refusal as a safe public cause", () => {
    expect(publicCloudError("cloud_workspace_v2_required")).toEqual({ code: "cloud_workspace_v2_required",
      message: "This workspace uses a retired cloud runtime — create a new workspace." });
  });

  it("requires the exact saved source even when a v4 runtime is pinned", async () => {
    vi.mocked(loadComputerWorkspaceSource).mockResolvedValue(null);
    await expect(requireSupportedCloudWorkspaceGeneration(tx, scope)).rejects.toMatchObject({ status: 409, code: "cloud_workspace_v2_required" });
    expect(loadComputerWorkspaceSource).toHaveBeenCalledWith(tx, scope);
  });

  it.each([
    null,
    { ...pin, runtime_id: null },
    { ...pin, runtime_manifest_sha256: null },
    { ...pin, runtime_profile: "zeros-cloud-worker-v3" },
    { ...pin, runtime_engine_protocol_version: null },
  ])("refuses an unsupported or incomplete saved runtime pin before source lookup: %j", async row => {
    query.mockResolvedValue({ rows: row ? [row] : [] });
    await expect(requireSupportedCloudWorkspaceGeneration(tx, scope)).rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
    expect(loadComputerWorkspaceSource).not.toHaveBeenCalled();
  });

  it("classifies an invalid saved template as retired without selecting a current template", async () => {
    vi.mocked(loadComputerWorkspaceSource).mockRejectedValue(new HttpError(409, "cloud_computer_build_required", "Template unavailable"));
    await expect(requireSupportedCloudWorkspaceGeneration(tx, scope)).rejects.toMatchObject({ code: "cloud_workspace_v2_required" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("cloud_workspace_generations"), [scope.workspaceId, scope.generation, scope.organizationId]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not disguise database failures as retirement", async () => {
    const error = new Error("database unavailable");
    vi.mocked(loadComputerWorkspaceSource).mockRejectedValue(error);
    await expect(requireSupportedCloudWorkspaceGeneration(tx, scope)).rejects.toBe(error);
  });

  it("returns the saved source and pin without rewriting them", async () => {
    const result = await requireSupportedCloudWorkspaceGeneration(tx, scope);
    expect(result).toEqual({ source, runtimePin: {
      runtimeId: pin.runtime_id, manifestSha256: pin.runtime_manifest_sha256, baseImageId: pin.runtime_base_image_id,
      baseCompatibilityId: pin.runtime_base_compatibility_id, profile: pin.runtime_profile, engineProtocolVersion: pin.runtime_engine_protocol_version,
    } });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
