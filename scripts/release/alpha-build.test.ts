import { describe, expect, it, vi } from "vitest";
import { ALPHA_BUILD_WAIT_MS, createAlphaBuildMetadata, validateAlphaBuildMetadata, validateAlphaProducerProof, waitForAlphaBuild } from "./alpha-build";

const sourceSha = "b".repeat(40), repository = "example/zeros";
const env: NodeJS.ProcessEnv = { RELEASE_CHANNEL: "alpha", RELEASE_SHA: sourceSha, RELEASE_BRANCH: "main", GITHUB_SHA: sourceSha,
  GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: "300", GITHUB_RUN_ATTEMPT: "2", GITHUB_RUN_NUMBER: "150", GITHUB_JOB: "publish",
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-alpha.yml@refs/heads/main`, VERSION: "0.1.20-alpha.150", ALPHA_PREPARED_VERSION: "0.1.20-alpha.150", BUILD_CLOUD_ENABLED: "true" };
const parent = { id: 300, run_attempt: 2, run_number: 150, name: "Release (alpha)", path: ".github/workflows/release-alpha.yml",
  head_sha: sourceSha, head_branch: "main", event: "push", status: "in_progress", conclusion: null,
  repository: { full_name: repository }, head_repository: { full_name: repository } };
const steps = ["Compute alpha version", "Record the baked cloud capability", "Verify installer + updater signatures", "Write signed Alpha build metadata", "Save signed Alpha artifacts"];
const producer = { id: 400, run_id: 300, run_attempt: 2, head_sha: sourceSha, head_branch: "main",
  name: "Build + sign Alpha (macOS arm64 · NOT notarized)", status: "completed", conclusion: "success",
  steps: steps.map(name => ({ name, status: "completed", conclusion: "success" })) };

function fixture() {
  const state = { parent: { ...parent }, jobs: [{ ...producer }], artifact: { id: 500, name: `zeros-alpha-arm64-build-${sourceSha}`,
    expired: false, workflow_run: { id: 300, head_sha: sourceSha, head_branch: "main" } }, malformed: false };
  const read = vi.fn(async (route: string): Promise<any> => {
    if (route === "/actions/runs/300") return state.parent;
    if (route.startsWith("/actions/runs/300/attempts/2/jobs?")) return state.malformed ? { jobs: state.jobs } : { total_count: state.jobs.length, jobs: state.jobs };
    if (route.startsWith("/actions/runs/300/attempts/1/jobs?")) return { total_count: 1, jobs: [{ ...producer, run_attempt: 1 }] };
    if (route === "/actions/runs/300/artifacts?per_page=100") return { total_count: 1, artifacts: [state.artifact] };
    throw new Error(`Unexpected read: ${route}`);
  });
  return { state, read };
}

describe("same-run Alpha producer readiness", () => {
  it.each(["desktop", "runtime"] as const)("refuses replacement or rerun of the %s producer between wait and publication", async kind => {
    for (const boundary of ["artifact", "parent attempt", "producer", "producing attempt"]) {
      const test = fixture();
      if (kind === "runtime") {
        test.state.jobs[0] = { ...producer, name: "Build Linux runtime bundle",
          steps: ["Build and verify the exact-source runtime", "Save runtime bundle outputs"].map(name => ({ name, status: "completed", conclusion: "success" })) };
        test.state.artifact.name = `zeros-alpha-runtime-build-${sourceSha}`;
      }
      test.state.jobs[0].run_attempt = 1;
      const proof = await waitForAlphaBuild(kind, env, test.read);
      if (boundary === "artifact") test.state.artifact.id = 501;
      if (boundary === "parent attempt") test.state.parent.run_attempt = 3;
      if (boundary === "producer") test.state.jobs[0].id = 401;
      if (boundary === "producing attempt") test.state.jobs[0].run_attempt = 2;
      await expect(validateAlphaProducerProof(proof, env, test.read)).rejects.toThrow(/parent|producer|artifact/);
    }
  });
  it("retains a carried runtime producer after downloading its immutable artifact", async () => {
    const test = fixture(); test.state.jobs[0] = { ...producer, run_attempt: 1, name: "Build Linux runtime bundle",
      steps: ["Build and verify the exact-source runtime", "Save runtime bundle outputs"].map(name => ({ name, status: "completed", conclusion: "success" })) };
    test.state.artifact.name = `zeros-alpha-runtime-build-${sourceSha}`;
    const proof = await waitForAlphaBuild("runtime", env, test.read);
    await expect(validateAlphaProducerProof(proof, env, test.read)).resolves.toEqual(proof);
  });
  it("authenticates the exact desktop producer and artifact from this parent attempt", async () => {
    const test = fixture();
    expect(await waitForAlphaBuild("desktop", env, test.read)).toMatchObject({ kind: "desktop", runId: "300", runAttempt: "2", producerId: 400, producerAttempt: 2, artifactId: 500 });
    expect(test.read).toHaveBeenCalledWith("/actions/runs/300/attempts/2/jobs?per_page=100&page=1");
    expect(test.read).toHaveBeenCalledWith("/actions/runs/300/artifacts?per_page=100");
    expect(test.read.mock.calls.every(([route]) => route.startsWith("/actions/runs/300"))).toBe(true);
  });
  it("recognizes only the Linux runtime producer for the runtime handoff", async () => {
    const test = fixture(); test.state.jobs = [{ ...producer, name: "Build Linux runtime bundle",
      steps: ["Build and verify the exact-source runtime", "Save runtime bundle outputs"].map(name => ({ name, status: "completed", conclusion: "success" })) }];
    test.state.artifact.name = `zeros-alpha-runtime-build-${sourceSha}`;
    expect(await waitForAlphaBuild("runtime", env, test.read)).toMatchObject({ kind: "runtime", artifactId: 500 });
  });
  it.each(["queued", "in_progress"])("waits at the fixed poll interval for a %s producer", async status => {
    const test = fixture(); test.state.jobs[0] = { ...producer, status, conclusion: null as any };
    const sleep = vi.fn(async (milliseconds: number) => { expect(milliseconds).toBe(10_000); test.state.jobs[0] = { ...producer }; });
    await expect(waitForAlphaBuild("desktop", env, test.read, { sleep, attempts: 2 })).resolves.toMatchObject({ producerId: 400 });
    expect(sleep).toHaveBeenCalledOnce();
  });
  it("bounds the wait and never looks for an artifact before producer success", async () => {
    const test = fixture(); test.state.jobs[0] = { ...producer, status: "queued", conclusion: null as any };
    const sleep = vi.fn(async () => {});
    await expect(waitForAlphaBuild("desktop", env, test.read, { sleep, attempts: 2 })).rejects.toThrow(/timed out/);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(test.read.mock.calls.some(([route]) => route.includes("artifacts"))).toBe(false);
  });
  it("stops at the wall-clock deadline even when poll attempts remain", async () => {
    const test = fixture(); test.state.jobs[0] = { ...producer, status: "queued", conclusion: null as any };
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const sleep = vi.fn(async () => { clock.mockReturnValue(ALPHA_BUILD_WAIT_MS); });
    try {
      await expect(waitForAlphaBuild("desktop", env, test.read, { sleep })).rejects.toThrow(/45 minutes/);
      expect(sleep).toHaveBeenCalledOnce();
      expect(test.read.mock.calls.some(([route]) => route.includes("artifacts"))).toBe(false);
    } finally { clock.mockRestore(); }
  });
  it.each(["failure", "cancelled", "skipped", "timed_out", "neutral", "action_required"])("stops promptly for a %s producer", async conclusion => {
    const test = fixture(); test.state.jobs[0].conclusion = conclusion;
    const sleep = vi.fn();
    await expect(waitForAlphaBuild("desktop", env, test.read, { sleep })).rejects.toThrow(/producer/);
    expect(sleep).not.toHaveBeenCalled();
  });
  it("accepts a prior successful producer carried into this attempt's authenticated jobs endpoint", async () => {
    const test = fixture(); test.state.jobs[0].run_attempt = 1;
    await expect(waitForAlphaBuild("desktop", env, test.read)).resolves.toMatchObject({ runAttempt: "2", producerAttempt: 1 });
  });
  it("uses carried proof only for completed success, never an older queued producer", async () => {
    const test = fixture(); test.state.jobs[0] = { ...producer, run_attempt: 1, status: "queued", conclusion: null as any };
    await expect(waitForAlphaBuild("desktop", env, test.read)).rejects.toThrow(/attempt/);
  });
  it.each([
    { id: 301 }, { run_attempt: 3 }, { run_number: 151 }, { head_sha: "c".repeat(40) }, { head_branch: "other" },
    { name: "untrusted workflow" }, { path: ".github/workflows/alpha-publication.yml" }, { event: "workflow_dispatch" },
    { repository: { full_name: "other/zeros" } }, { head_repository: { full_name: "fork/zeros" } }, { status: "completed", conclusion: "cancelled" },
  ])("refuses a foreign or stale parent %#", async patch => {
    const test = fixture(); Object.assign(test.state.parent, patch);
    await expect(waitForAlphaBuild("desktop", env, test.read)).rejects.toThrow(/parent/);
  });
  it.each([
    { id: 0 }, { run_id: 301 }, { run_attempt: 3 }, { run_attempt: "2" }, { head_sha: "c".repeat(40) }, { head_branch: "other" },
    { name: "Alpha publication / Build + sign Alpha (macOS arm64 · NOT notarized)" }, { status: "unknown" },
    { conclusion: "success", status: "in_progress" }, { steps: [] },
  ])("refuses malformed or foreign producer evidence %#", async patch => {
    const test = fixture(); Object.assign(test.state.jobs[0], patch);
    await expect(waitForAlphaBuild("desktop", env, test.read)).rejects.toThrow(/producer/);
  });
  it.each(["missing", "duplicate", "malformed page"])("fails closed on %s producer discovery", async failure => {
    const test = fixture();
    if (failure === "missing") test.state.jobs = [];
    if (failure === "duplicate") test.state.jobs.push({ ...producer, id: 401 });
    if (failure === "malformed page") test.state.malformed = true;
    await expect(waitForAlphaBuild("desktop", env, test.read)).rejects.toThrow();
  });
  it("aborts when a rerun begins during polling or after artifact enumeration", async () => {
    for (const boundary of ["poll", "artifact"]) {
      const test = fixture();
      if (boundary === "poll") test.state.jobs[0] = { ...producer, status: "queued", conclusion: null as any };
      else {
        const original = test.read.getMockImplementation()!;
        test.read.mockImplementation(async route => { const value = await original(route); if (route.includes("artifacts")) test.state.parent.run_attempt = 3; return value; });
      }
      await expect(waitForAlphaBuild("desktop", env, test.read, { sleep: async () => { test.state.parent.run_attempt = 3; }, attempts: 2 })).rejects.toThrow(/parent/);
    }
  });
  it.each([{ expired: true }, { name: "another-artifact" }, { workflow_run: { id: 301, head_sha: sourceSha, head_branch: "main" } },
    { workflow_run: { id: 300, head_sha: "c".repeat(40), head_branch: "main" } }])("refuses another run/source or unavailable build artifact %#", async patch => {
    const test = fixture(); Object.assign(test.state.artifact, patch);
    await expect(waitForAlphaBuild("desktop", env, test.read)).rejects.toThrow(/artifact/);
  });
});

describe("protected Alpha signed-build metadata", () => {
  const metadata = () => createAlphaBuildMetadata({ ...env, GITHUB_JOB: "build" });
  it("records immutable source/run/version and the exact baked cloud boolean", () => {
    expect(metadata()).toMatchObject({ version: 1, channel: "alpha", sourceSha, repository, runId: "300", runAttempt: "2", runNumber: "150", releaseVersion: "0.1.20-alpha.150", cloudEnabled: true });
    expect(createAlphaBuildMetadata({ ...env, GITHUB_JOB: "build", BUILD_CLOUD_ENABLED: "false" }).cloudEnabled).toBe(false);
    expect(() => createAlphaBuildMetadata({ ...env, GITHUB_JOB: "build", BUILD_CLOUD_ENABLED: "" })).toThrow();
    expect(() => createAlphaBuildMetadata({ ...env, GITHUB_JOB: "build", VERSION: "0.1.21-alpha.150" })).toThrow(/version/);
  });
  it("validates current and carried producing attempts before exposing publication outputs", async () => {
    for (const attempt of [1, 2]) {
      const test = fixture(); test.state.jobs[0].run_attempt = attempt;
      const proof = await waitForAlphaBuild("desktop", env, test.read);
      const value = { ...metadata(), runAttempt: String(attempt) };
      await expect(validateAlphaBuildMetadata(value, proof, env, test.read)).resolves.toEqual(value);
    }
  });
  it("authenticates a carried producer's recorded attempt when GitHub omits its attempt on the carried row", async () => {
    const test = fixture(); delete (test.state.jobs[0] as any).run_attempt;
    const proof = await waitForAlphaBuild("desktop", env, test.read);
    await expect(validateAlphaBuildMetadata({ ...metadata(), runAttempt: "1" }, proof, env, test.read)).resolves.toMatchObject({ runAttempt: "1" });
    expect(test.read).toHaveBeenCalledWith("/actions/runs/300/attempts/1/jobs?per_page=100&page=1");
  });
  it.each([{ sourceSha: "c".repeat(40) }, { repository: "other/zeros" }, { branch: "other" }, { channel: "beta" }, { runId: "301" },
    { runAttempt: "3" }, { runNumber: "149" }, { releaseVersion: "0.1.20-alpha.149" }, { releaseVersion: "0.1.21-alpha.150" }, { releaseVersion: "0.1.20-beta.150" },
    { cloudEnabled: "true" }, { unexpected: "value" }])("refuses metadata outside its authenticated source/run/version contract %#", async patch => {
    const test = fixture(), proof = await waitForAlphaBuild("desktop", env, test.read);
    await expect(validateAlphaBuildMetadata({ ...metadata(), ...patch }, proof, env, test.read)).rejects.toThrow(/metadata/);
  });
  it("refuses a previous artifact after the producer was rerun or its producing attempt lacks proof", async () => {
    const test = fixture(), proof = await waitForAlphaBuild("desktop", env, test.read);
    await expect(validateAlphaBuildMetadata({ ...metadata(), runAttempt: "1" }, proof, env, test.read)).rejects.toThrow(/metadata/);
    test.state.jobs[0].id = 401;
    await expect(validateAlphaBuildMetadata(metadata(), proof, env, test.read)).rejects.toThrow(/producer/);
  });
});
