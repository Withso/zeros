import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudCommandFailureError } from "@zeros/protocol/cloud-commands";

// These tests exercise cloud policy/descriptor creation, the actual canary
// child, and exact retirement. Ownership syscalls are the only filesystem
// fixture: the ordinary test runner cannot chown files to the native worker.
// Actual UID isolation remains covered by the separate native/harness tests.
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  chown: vi.fn(async () => undefined),
  lchown: vi.fn(async () => undefined),
}));

import { ZsrExecutionBoundary } from "../zsr-boundary";
import { AdmissionCancelledError, type BoundaryRequest, type PreparedBoundary } from "../types";
import type { PreparedZsrPolicy } from "../policy";

type CanaryInternals = {
  runHostParityAdmissionCanary(
    prepared: PreparedBoundary,
    policy: PreparedZsrPolicy,
    request: BoundaryRequest,
  ): Promise<string[]>;
};

const REFUSED_SUPERVISOR = String.raw`
import { readFileSync } from "node:fs";
const descriptor = JSON.parse(readFileSync(process.argv[process.argv.indexOf("--command") + 1], "utf8"));
if (!descriptor.env.HOST_PARITY_CANARY) process.exit(2);
process.stderr.write("fixture setup detail\n");
process.stderr.write("bwrap: mount proc: Permission denied\n");
process.exit(1);
`;

describe.runIf(process.platform === "linux")("cloud workload canary failure classification", () => {
  let root: string;
  let workspace: string;
  let supervisor: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-canary-test-")));
    workspace = path.join(root, "workspace");
    supervisor = path.join(root, "canary-supervisor.mjs");
    previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "engine");
    await mkdir(workspace);
    await writeFile(supervisor, REFUSED_SUPERVISOR, { mode: 0o700 });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  });

  function boundary(cloud = true): ZsrExecutionBoundary {
    const result = new ZsrExecutionBoundary({
      projectRoot: root,
      supervisorScript: supervisor,
      supervisorRuntime: process.execPath,
      ...(cloud ? { cloudWorker: { uid: 10001, gid: 10001 } } : {}),
    });
    vi.spyOn(result, "probe").mockResolvedValue({
      backend: cloud ? "cloud-worker" : "zeros-srt",
      available: true,
      secureNestedIsolation: true,
      reasons: [],
    });
    return result;
  }

  function request(executionId: string, actor: BoundaryRequest["actor"] = "agent-code"): BoundaryRequest {
    return { executionId, actor, providerId: "claude", cwd: workspace, workspaceRoot: workspace };
  }

  function captureCanary(owner: ZsrExecutionBoundary, inspect: CanaryInternals["runHostParityAdmissionCanary"]) {
    const internals = owner as unknown as CanaryInternals;
    return vi.spyOn(internals, "runHostParityAdmissionCanary").mockImplementation(inspect);
  }

  it.each(["blocking", "background"] as const)("classifies actual exit1 refusal after exact retirement (%s)", async attestation => {
    const owner = boundary();
    const internals = owner as unknown as CanaryInternals;
    const originalCanary = internals.runHostParityAdmissionCanary.bind(owner);
    let prepared: PreparedBoundary | undefined;
    let policy: PreparedZsrPolicy | undefined;
    let retire: ReturnType<typeof vi.spyOn> | undefined;
    captureCanary(owner, async (value, paths, input) => {
      prepared = value;
      policy = paths;
      retire = vi.spyOn(value, "stopAndProve");
      expect(paths.document.runtime.cloudWorker).toEqual({ version: 1, uid: 10001, gid: 10001 });
      return originalCanary(value, paths, input);
    });
    const admission = (async () => {
      const value = await owner.prepare(request(`actual-canary-${attestation}`), { attestation });
      await value.attestation;
    })();

    await expect(admission).rejects.toMatchObject({
      code: "cloud_containment_canary_failed",
      message: "cloud_containment_canary_failed",
      diagnosis: { stage: "containment", category: "canary_failed" },
    });
    expect(retire).toHaveBeenCalledOnce();
    expect(prepared?.status.backend).toBe("cloud-worker");
    expect(() => prepared!.wrapSpawn({ command: process.execPath, args: ["--version"], cwd: workspace, env: {} })).toThrow(/revoked/);
    await expect(access(policy!.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(policy!.paths.network)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits for exact retirement before surfacing the closed canary cause", async () => {
    const owner = boundary();
    const originalCanary = (owner as unknown as CanaryInternals).runHostParityAdmissionCanary.bind(owner);
    let finishRetirement!: () => void;
    const retirementGate = new Promise<void>(resolve => { finishRetirement = resolve; });
    let retiring = false;
    let settled = false;
    let policy: PreparedZsrPolicy | undefined;
    captureCanary(owner, async (prepared, paths, input) => {
      policy = paths;
      const stop = prepared.stopAndProve.bind(prepared);
      vi.spyOn(prepared, "stopAndProve").mockImplementation(async () => {
        retiring = true;
        await retirementGate;
        await stop();
      });
      return originalCanary(prepared, paths, input);
    });
    const admission = owner.prepare(request("canary-retirement-order"));
    void admission.then(() => { settled = true; }, () => { settled = true; });
    try {
      await vi.waitFor(() => expect(retiring).toBe(true));
      expect(settled).toBe(false);
      await expect(readFile(policy!.paths.policy, "utf8")).resolves.toBeTruthy();
    } finally {
      finishRetirement();
    }
    await expect(admission).rejects.toMatchObject({ code: "cloud_containment_canary_failed" });
    await expect(access(policy!.paths.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["agent-code", "design-agent"] as const)("preserves the Local native refusal (%s)", async actor => {
    await expect(boundary(false).prepare(request(`local-canary-${actor}`, actor))).rejects.toMatchObject({
      message: "host-parity canary exited 1: bwrap: mount proc: Permission denied",
    });
  });

  it.each([
    new CloudCommandFailureError({ stage: "validation", category: "lease_expired" }),
    Object.assign(new Error("private authority diagnostic"), { code: "cloud_admission_rate_limited" }),
    Object.assign(new Error("private credential diagnostic"), { code: "cloud_agent_credential_revoked" }),
  ])("preserves a known inner typed cause: $code", async cause => {
    const owner = boundary();
    let retire: ReturnType<typeof vi.spyOn> | undefined;
    captureCanary(owner, async prepared => {
      retire = vi.spyOn(prepared, "stopAndProve");
      throw cause;
    });
    await expect(owner.prepare(request("typed-canary-cause"))).rejects.toMatchObject({
      code: cause.code,
      message: expect.not.stringContaining("private"),
    });
    expect(retire).toHaveBeenCalledOnce();
  });

  it("classifies a rejected behavioral proof without copying its prose", async () => {
    const owner = boundary();
    captureCanary(owner, async () => ["private canary diagnostic"]);
    await expect(owner.prepare(request("canary-proof-refused"))).rejects.toMatchObject({
      code: "cloud_containment_canary_failed",
      message: "cloud_containment_canary_failed",
    });
  });

  it("preserves cancellation after successful exact retirement", async () => {
    const owner = boundary();
    const controller = new AbortController();
    let prepared: PreparedBoundary | undefined;
    captureCanary(owner, async value => {
      prepared = value;
      controller.abort();
      return [];
    });
    await expect(owner.prepare(request("cancelled-canary"), { signal: controller.signal })).rejects.toBeInstanceOf(AdmissionCancelledError);
    expect(() => prepared!.wrapSpawn({ command: process.execPath, args: ["--version"], cwd: workspace, env: {} })).toThrow(/revoked/);
  });

  it("retains failed-retirement aggregate and proof instead of a canary-only cause", async () => {
    const owner = boundary();
    const originalCanary = (owner as unknown as CanaryInternals).runHostParityAdmissionCanary.bind(owner);
    const failure = new Error("exact boundary retirement refused");
    let prepared: PreparedBoundary | undefined;
    let policy: PreparedZsrPolicy | undefined;
    const internals = owner as unknown as { retirementFailures: Map<string, unknown> };
    let revoke: ReturnType<typeof vi.spyOn> | undefined;
    captureCanary(owner, async (value, paths, input) => {
      prepared = value;
      policy = paths;
      revoke = vi.spyOn(value, "revoke").mockRejectedValueOnce(failure);
      return originalCanary(value, paths, input);
    });
    try {
      const error = await owner.prepare(request("unproven-canary-retirement"), { retainFailedPreparationProof: true }).catch(error => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toMatchObject({ message: "host-parity admission failed and teardown could not be proven" });
      expect(error.code).toBeUndefined();
      expect(error.errors[0]).toMatchObject({ message: "host-parity canary exited 1: bwrap: mount proc: Permission denied" });
      expect(error.errors[1].errors).toContain(failure);
      expect(internals.retirementFailures.has(prepared!.generation)).toBe(true);
      await expect(access(policy!.paths.policy)).resolves.toBeUndefined();
    } finally {
      revoke?.mockRestore();
      await prepared?.stopAndProve();
    }
    expect(internals.retirementFailures.size).toBe(0);
    await expect(owner.proveFailedPreparationStopped("unproven-canary-retirement")).resolves.toBeUndefined();
  });
});
