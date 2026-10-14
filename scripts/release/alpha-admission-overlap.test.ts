import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fixture = vi.hoisted(() => ({
  source: { channel: "alpha", sourceSha: "c".repeat(40), repository: "example/zeros", branch: "main" },
  prior: "a".repeat(40), publisher: "b".repeat(40), now: 0,
  pause: vi.fn(), assertCurrent: vi.fn(), requiredChecks: vi.fn(), assertRequiredChecks: vi.fn(),
  automaticAlpha: vi.fn(), alphaBarrierUnmutated: vi.fn(),
}));
vi.mock("./github", () => ({ githubClient: () => ({ ...fixture,
  requiredWorkflows: async () => [{ file: "preflight.yml", name: "Preflight" }],
}) }));
vi.mock("./contracts", async importOriginal => ({
  ...await importOriginal<typeof import("./contracts")>(), releaseSource: () => fixture.source,
}));
vi.mock("./io", async importOriginal => ({
  ...await importOriginal<typeof import("./io")>(), command: async () => fixture.source.sourceSha,
}));
vi.mock("./ci", async importOriginal => {
  const actual = await importOriginal<typeof import("./ci")>();
  return { ...actual, waitForRequiredCI: (read: Parameters<typeof actual.waitForRequiredCI>[0],
    options: Parameters<typeof actual.waitForRequiredCI>[1], required: Parameters<typeof actual.waitForRequiredCI>[2]) =>
    actual.waitForRequiredCI(read, { ...options, sleep: async () => { fixture.now += 10_000; await fixture.pause(); } }, required) };
});

const originalDirectory = process.cwd(), originalArgv = process.argv, originalExitCode = process.exitCode;
let directory: string;
let state: { tag: string; ledger: string; malformed: boolean };
let snapshots: number;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  fixture.now = Date.parse("2026-10-01T01:00:00Z");
  vi.spyOn(Date, "now").mockImplementation(() => fixture.now);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  directory = await mkdtemp(path.join(os.tmpdir(), "alpha-admission-overlap-"));
  process.chdir(directory);
  process.argv = ["node", "ci-cli.ts", "--wait"];
  process.exitCode = undefined;
  for (const [name, value] of Object.entries({ GITHUB_JOB: "ci", GITHUB_RUN_ID: "300", GITHUB_RUN_ATTEMPT: "1",
    GITHUB_OUTPUT: path.join(directory, "output"), ZEROS_ALPHA_FORWARD_ONLY: "enabled",
    GITHUB_WORKFLOW_REF: "example/zeros/.github/workflows/release-alpha.yml@refs/heads/main" })) vi.stubEnv(name, value);
  fixture.automaticAlpha.mockResolvedValue(true);
  fixture.alphaBarrierUnmutated.mockResolvedValue(true);
  fixture.requiredChecks.mockResolvedValue([{ workflow: "Preflight", runId: 100, attempt: 1, succeeded: true }]);
  fixture.assertRequiredChecks.mockResolvedValue(undefined);
  state = { tag: fixture.prior, ledger: fixture.publisher, malformed: false };
  snapshots = 0;
  const { alphaAncestry, assertAlphaDestinations } = await import("./alpha-frontier");
  const read = async (route: string) => {
    if (route === "/git/ref/tags/alpha") return { ref: "refs/tags/alpha", object: { type: "commit", sha: state.tag } };
    const [base, head] = route.slice("/compare/".length).split("...");
    const order = [fixture.prior, fixture.publisher, fixture.source.sourceSha];
    if (route.startsWith("/compare/")) return { status: order.indexOf(base) >= 0 ? "ahead" : "diverged",
      base_commit: { sha: base }, merge_base_commit: { sha: order.includes(base) ? base : fixture.prior } };
    throw new Error(`Unexpected synthetic read: ${route} (${head})`);
  };
  const fetcher: typeof fetch = async (input, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(String(input));
    if (url.pathname === "/v1/release-identity") {
      snapshots++;
      return Response.json({ version: 1, ready: true, channel: "alpha", sourceSha: fixture.prior, maintenance: false,
        migrations: { state: "current", head: "0001_fixture.sql", expectedHead: "0001_fixture.sql", manifestSha256: "e".repeat(64) },
        cloud: { enabled: false, ready: true, state: "disabled" }, worker: null });
    }
    if (url.pathname === "/zeros-deployment.json") return Response.json({ version: 1,
      surface: url.hostname.startsWith("ops-") ? "ops" : "app", commitSha: fixture.prior });
    const ledgerUrl = "https://github.com/example/zeros/releases/download/alpha/alpha-release-ledger.json";
    if (url.pathname === "/repos/example/zeros/releases/tags/alpha") return Response.json({ draft: false, prerelease: true, tag_name: "alpha",
      assets: [{ name: "alpha-release-ledger.json", browser_download_url: ledgerUrl }] });
    if (url.href === ledgerUrl) return Response.json({ version: 1, channel: "alpha", releases: [
      { version: state.malformed ? "invalid" : "0.1.0-alpha.149", publishedAt: "2026-10-01T00:00:00Z", sourceSha: state.ledger },
    ] });
    throw new Error(`Unexpected synthetic URL: ${url.origin}${url.pathname}`);
  };
  // Keep the real ledger, identity, ancestry and disagreement classification.
  fixture.assertCurrent.mockImplementation(async () => {
    await assertAlphaDestinations(fixture.source, process.env, read, alphaAncestry(read), fetcher);
  });
});
afterEach(async () => {
  process.chdir(originalDirectory);
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

async function expectNoAdmission() {
  await expect(readFile(path.join(directory, "output"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(path.join(directory, ".context/release/alpha-admission.json"))).rejects.toMatchObject({ code: "ENOENT" });
}

describe("Alpha barrier overlapping an older feed publication", () => {
  it.each(["ledger-first", "tag-first"])("waits for a %s ancestor publication and then emits fresh admission", async order => {
    if (order === "tag-first") [state.tag, state.ledger] = [state.ledger, state.tag];
    fixture.alphaBarrierUnmutated.mockResolvedValue(false);
    fixture.pause.mockImplementationOnce(async () => {
      await expectNoAdmission();
      expect(fixture.requiredChecks).not.toHaveBeenCalled();
      state.tag = state.ledger = fixture.publisher;
    });
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalled());
    expect(await readFile(path.join(directory, "output"), "utf8")).toBe("admission_issued=true\nready=true\n");
    expect(fixture.pause).toHaveBeenCalledOnce();
    expect(fixture.requiredChecks).toHaveBeenCalledOnce();
    expect(snapshots).toBe(3);
    expect(fixture.alphaBarrierUnmutated).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("rereads CI as well as every frontier when publication overlaps the completion check", async () => {
    state.ledger = fixture.prior;
    fixture.requiredChecks.mockImplementationOnce(async () => {
      state.ledger = fixture.publisher;
      return [{ workflow: "Preflight", runId: 100, attempt: 1, succeeded: true }];
    });
    fixture.pause.mockImplementationOnce(async () => { await expectNoAdmission(); state.tag = fixture.publisher; });
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalled());
    expect(await readFile(path.join(directory, "output"), "utf8")).toBe("admission_issued=true\nready=true\n");
    expect(fixture.requiredChecks).toHaveBeenCalledTimes(2);
    expect(snapshots).toBe(4);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("withholds admission if CI loses its green result while publication settles", async () => {
    state.ledger = fixture.prior;
    fixture.requiredChecks.mockImplementationOnce(async () => {
      state.ledger = fixture.publisher;
      return [{ workflow: "Preflight", runId: 100, attempt: 1, succeeded: true }];
    }).mockResolvedValueOnce([{ workflow: "Preflight", runId: 100, attempt: 2, succeeded: false }]);
    fixture.pause.mockImplementation(async () => { await expectNoAdmission(); state.tag = fixture.publisher; });
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalled());
    expect(await readFile(path.join(directory, "output"), "utf8")).toBe("admission_issued=true\nready=true\n");
    expect(fixture.requiredChecks).toHaveBeenCalledTimes(3);
    expect(fixture.pause).toHaveBeenCalledTimes(2);
    expect(snapshots).toBe(5);
  });

  it.each(["observations", "deadline"])("keeps a persistent mismatch red within the %s bound", async bound => {
    if (bound === "deadline") fixture.pause.mockImplementationOnce(() => { fixture.now += 120_000; });
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/rolling tag and release ledger disagree/));
    expect(fixture.pause).toHaveBeenCalledTimes(bound === "deadline" ? 1 : 11);
    expect(snapshots).toBe(bound === "deadline" ? 1 : 12);
    expect(fixture.requiredChecks).not.toHaveBeenCalled();
    expect(fixture.alphaBarrierUnmutated).not.toHaveBeenCalled();
    await expectNoAdmission();
  });

  it.each(["malformed ledger", "newer tag"])("does not retry a %s as a publication overlap", async failure => {
    if (failure === "malformed ledger") state.malformed = true;
    else state.tag = "d".repeat(40);
    fixture.alphaBarrierUnmutated.mockResolvedValue(false);
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(fixture.pause).not.toHaveBeenCalled();
    expect(snapshots).toBe(1);
    await expectNoAdmission();
  });

  it.each(["malformed ledger", "newer tag"])("stops if a retry observes a %s", async failure => {
    fixture.alphaBarrierUnmutated.mockResolvedValue(false);
    fixture.pause.mockImplementationOnce(() => {
      if (failure === "malformed ledger") state.malformed = true;
      else state.tag = "d".repeat(40);
    });
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(fixture.pause).toHaveBeenCalledOnce();
    expect(snapshots).toBe(2);
    expect(fixture.requiredChecks).not.toHaveBeenCalled();
    await expectNoAdmission();
  });

  it.each(["verify", "downstream", "unauthenticated", "beta", "production"])("keeps %s callers strict", async caller => {
    if (caller === "verify") process.argv[2] = "--verify";
    if (caller === "downstream") vi.stubEnv("GITHUB_JOB", "entry");
    if (caller === "unauthenticated") fixture.automaticAlpha.mockResolvedValue(false);
    if (caller === "beta" || caller === "production") fixture.source.channel = caller;
    try {
      await import("./ci-cli");
      await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
      expect(fixture.pause).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      await expectNoAdmission();
    } finally { fixture.source.channel = "alpha"; }
  });
});
