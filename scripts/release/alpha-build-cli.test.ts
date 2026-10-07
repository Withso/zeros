import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("./io", async importOriginal => ({
  ...await importOriginal<typeof import("./io")>(), jsonClient: () => mocked.json,
}));

const sourceSha = "b".repeat(40), repository = "example/zeros";
const env = { RELEASE_CHANNEL: "alpha", RELEASE_SHA: sourceSha, RELEASE_BRANCH: "main", GITHUB_SHA: sourceSha,
  GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: "300", GITHUB_RUN_ATTEMPT: "2", GITHUB_RUN_NUMBER: "150", GITHUB_JOB: "publish",
  GITHUB_WORKFLOW_REF: `${repository}/.github/workflows/release-alpha.yml@refs/heads/main`, ALPHA_PREPARED_VERSION: "0.1.20-alpha.150", GH_TOKEN: "synthetic-read-token" };
const parent = { id: 300, run_attempt: 2, run_number: 150, name: "Release (alpha)", path: ".github/workflows/release-alpha.yml",
  head_sha: sourceSha, head_branch: "main", event: "push", status: "in_progress", conclusion: null,
  repository: { full_name: repository }, head_repository: { full_name: repository } };
const metadata = { version: 1, channel: "alpha", repository, branch: "main", sourceSha, runId: "300", runAttempt: "1", runNumber: "150",
  releaseVersion: "0.1.20-alpha.150", cloudEnabled: false };
const originalArgv = process.argv, originalExitCode = process.exitCode, originalDirectory = process.cwd();
let directory: string;

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  directory = await mkdtemp(path.join(os.tmpdir(), "alpha-build-cli-"));
  await mkdir(path.join(directory, "release"));
  process.chdir(directory);
  process.exitCode = undefined;
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  vi.stubEnv("GITHUB_OUTPUT", path.join(directory, "output"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(originalDirectory); process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function buildAPI(kind: "desktop" | "runtime") {
  const steps = kind === "desktop"
    ? ["Compute alpha version", "Record the baked cloud capability", "Verify installer + updater signatures", "Write signed Alpha build metadata", "Save signed Alpha artifacts"]
    : ["Build and verify the exact-source runtime", "Save runtime bundle outputs"];
  const state = { parent: { ...parent }, artifactId: 500 };
  const producer = { id: 400, run_id: 300, run_attempt: 1, head_sha: sourceSha, head_branch: "main",
    name: kind === "desktop" ? "Build + sign Alpha (macOS arm64 · NOT notarized)" : "Build Linux runtime bundle",
    status: "completed", conclusion: "success", steps: steps.map(name => ({ name, status: "completed", conclusion: "success" })) };
  mocked.json.mockImplementation(async (url: string, init: RequestInit) => {
    expect(url).toMatch(new RegExp(`^https://api\\.github\\.com/repos/${repository}/actions/runs/300(?:/|$)`));
    expect(init.headers).toMatchObject({ authorization: "Bearer synthetic-read-token" });
    const route = url.split(`/repos/${repository}`)[1];
    if (route === "/actions/runs/300") return state.parent;
    if (/^\/actions\/runs\/300\/attempts\/[12]\/jobs\?per_page=100&page=1$/.test(route)) return { total_count: 1, jobs: [producer] };
    if (route === "/actions/runs/300/artifacts?per_page=100") return { total_count: 1, artifacts: [{ id: state.artifactId,
      name: `${kind === "desktop" ? "zeros-alpha-arm64-build" : "zeros-alpha-runtime-build"}-${sourceSha}`,
      expired: false, workflow_run: { id: 300, head_sha: sourceSha, head_branch: "main" } }] };
    throw new Error("Unrecognized synthetic producer read");
  });
  return state;
}
async function run(mode: string, kind?: string) {
  process.argv = ["node", "alpha-build-cli.ts", mode, ...(kind ? [kind] : [])];
  vi.resetModules();
  await import("./alpha-build-cli");
}
async function wait(kind: "desktop" | "runtime") {
  await run("--wait", kind);
  await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith(`Alpha ${kind} producer and same-run artifact verified.`));
  return JSON.parse(await readFile(`.context/release/alpha-${kind}-producer.json`, "utf8"));
}

describe("Alpha producer CLI handoff", () => {
  it.each(["desktop", "runtime"] as const)("emits only the authenticated %s artifact ID and persists carried producer proof", async kind => {
    buildAPI(kind);
    expect(await wait(kind)).toMatchObject({ kind, runId: "300", runAttempt: "2", producerId: 400, producerAttempt: 1, artifactId: 500 });
    expect(await readFile("output", "utf8")).toBe("artifact_id=500\n");
    expect(console.error).not.toHaveBeenCalled();
    expect(JSON.stringify((console.log as any).mock.calls)).not.toContain("synthetic-read-token");
  });
  it("uses the carried signing build's version and baked false capability when current configuration is true", async () => {
    buildAPI("desktop"); await wait("desktop");
    vi.stubEnv("ZEROS_CLOUD_WORKSPACES_ENABLED", "true");
    await writeFile("release/alpha-build-metadata.json", JSON.stringify(metadata));
    await writeFile("release/alpha-mac.yml", `version: ${metadata.releaseVersion}\n`);
    await run("--verify-metadata");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledWith("Alpha signed-build source, producing attempt, version and baked cloud capability verified."));
    expect(await readFile("output", "utf8")).toBe(`artifact_id=500\nversion=${metadata.releaseVersion}\ncloud_enabled=false\n`);
  });
  it("refuses a feed whose version differs from the protected metadata without emitting publication fields", async () => {
    buildAPI("desktop"); await wait("desktop");
    await writeFile("release/alpha-build-metadata.json", JSON.stringify(metadata));
    await writeFile("release/alpha-mac.yml", "version: 0.1.20-alpha.151\n");
    await run("--verify-metadata");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("Alpha feed version differs from its signed-build metadata"));
    expect(process.exitCode).toBe(1);
    expect(await readFile("output", "utf8")).toBe("artifact_id=500\n");
  });
  it.each(["artifact", "attempt"])("refuses runtime %s replacement between download and publication", async boundary => {
    const state = buildAPI("runtime"); await wait("runtime");
    if (boundary === "artifact") state.artifactId = 501;
    else state.parent.run_attempt = 3;
    await run("--verify-producer", "runtime");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining("revalidated after download"));
  });
  it("refuses oversized metadata before querying producer evidence or exposing publication fields", async () => {
    await writeFile("release/alpha-build-metadata.json", " ".repeat(16 * 1024 + 1));
    await run("--verify-metadata");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("Alpha build metadata or producer proof exceeds its bound"));
    expect(mocked.json).not.toHaveBeenCalled();
    await expect(readFile("output")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
