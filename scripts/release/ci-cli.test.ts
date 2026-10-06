import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocked = vi.hoisted(() => ({
  source: { channel: "production", sourceSha: "a".repeat(40), repository: "Withso/zeros", branch: "release/0.1.20" },
  command: vi.fn(), assertRequiredChecks: vi.fn(), assertCurrent: vi.fn(), betaReceipt: vi.fn(), requiredChecks: vi.fn(), waitForRequiredCI: vi.fn(),
  automaticAlpha: vi.fn(), alphaBarrierUnmutated: vi.fn(), requiredWorkflows: vi.fn(),
}));
vi.mock("./github", () => ({ githubClient: () => mocked }));
vi.mock("./ci", () => ({ waitForRequiredCI: mocked.waitForRequiredCI }));
vi.mock("./contracts", async importOriginal => ({
  ...await importOriginal<typeof import("./contracts")>(), releaseSource: () => mocked.source,
}));
vi.mock("./io", async importOriginal => ({
  ...await importOriginal<typeof import("./io")>(), command: mocked.command,
}));

const originalArgv = process.argv, originalExitCode = process.exitCode;
const originalDirectory = process.cwd();
const directories: string[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = ["node", "ci-cli.ts", "--verify"];
  process.exitCode = undefined;
  mocked.source.channel = "production";
  mocked.source.branch = "release/0.1.20";
  mocked.command.mockResolvedValue(mocked.source.sourceSha);
  mocked.assertRequiredChecks.mockResolvedValue(undefined);
  mocked.assertCurrent.mockResolvedValue(undefined);
  mocked.betaReceipt.mockResolvedValue(undefined);
  mocked.requiredChecks.mockResolvedValue([]);
  mocked.waitForRequiredCI.mockImplementation(async (read: () => Promise<unknown>) => read());
  mocked.automaticAlpha.mockResolvedValue(false);
  mocked.alphaBarrierUnmutated.mockResolvedValue(true);
  mocked.requiredWorkflows.mockResolvedValue([{ file: "preflight.yml", name: "Preflight" }, { file: "codeql.yml", name: "CodeQL" }]);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  process.chdir(originalDirectory);
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function automaticBarrier(flag = "enabled") {
  mocked.source.channel = "alpha";
  mocked.source.branch = "main";
  mocked.automaticAlpha.mockResolvedValue(true);
  process.argv[2] = "--wait";
  vi.stubEnv("GITHUB_JOB", "ci");
  vi.stubEnv("GITHUB_WORKFLOW_REF", `${mocked.source.repository}/.github/workflows/release-alpha.yml@refs/heads/main`);
  vi.stubEnv("ZEROS_ALPHA_CI_FAST_PATH", flag);
  if (flag === "enabled") mocked.requiredWorkflows.mockResolvedValue([{ file: "preflight.yml", name: "Preflight" }]);
  const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-ci-output-"));
  directories.push(directory);
  const output = path.join(directory, "output");
  vi.stubEnv("GITHUB_OUTPUT", output);
  return output;
}

describe("exact-source CI CLI mutation authority", () => {
  it("rechecks freshness on every CI wait iteration instead of occupying the channel lock for a superseded SHA", async () => {
    process.argv[2] = "--wait";
    mocked.waitForRequiredCI.mockImplementation(async (read: () => Promise<unknown>) => { await read(); await read(); });
    mocked.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("superseded candidate"));
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(mocked.requiredChecks).toHaveBeenCalledOnce();
    expect(mocked.assertCurrent).toHaveBeenCalledTimes(2);
    expect(console.log).not.toHaveBeenCalled();
  });
  it("binds both the beginning and completion of a successful wait to the same current branch SHA", async () => {
    process.argv[2] = "--wait";
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledOnce());
    expect(mocked.assertCurrent).toHaveBeenCalledTimes(2);
    expect(mocked.assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(mocked.requiredChecks.mock.invocationCallOrder[0]);
    expect(mocked.assertCurrent.mock.invocationCallOrder[1]).toBeGreaterThan(mocked.requiredChecks.mock.invocationCallOrder[0]);
  });
  it("rechecks branch freshness after successful exact-SHA checks before authorizing Apple submission", async () => {
    await import("./ci-cli");
    await vi.waitFor(() => expect(mocked.assertCurrent).toHaveBeenCalledOnce());
    expect(mocked.assertCurrent.mock.invocationCallOrder[0]).toBeGreaterThan(mocked.assertRequiredChecks.mock.invocationCallOrder[0]);
    expect(console.log).toHaveBeenCalledOnce();
    expect(console.error).not.toHaveBeenCalled();
  });
  it("refuses a superseded source even with successful checks and hides private diagnostics", async () => {
    mocked.assertCurrent.mockRejectedValue(new Error("private-provider-diagnostic"));
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith("Required CI proof failed; provider and feed mutation refused.");
  });
  it("does not authorize a source when its required checks failed", async () => {
    mocked.assertRequiredChecks.mockRejectedValue(new Error("untrusted CI result"));
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(mocked.assertCurrent).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it("requires the exact-SHA Beta receipt before a Production Apple submission with hosted promotion enabled", async () => {
    process.argv.push("--beta");
    vi.stubEnv("ZEROS_HOSTED_PROMOTION", "enabled");
    await import("./ci-cli");
    await vi.waitFor(() => expect(mocked.betaReceipt).toHaveBeenCalledOnce());
    expect(mocked.betaReceipt.mock.invocationCallOrder[0]).toBeGreaterThan(mocked.assertCurrent.mock.invocationCallOrder[0]);
    expect(console.log).toHaveBeenCalledOnce();
  });
  it("does not authorize Apple submission when the required Beta receipt is absent", async () => {
    process.argv.push("--beta");
    vi.stubEnv("ZEROS_HOSTED_PROMOTION", "enabled");
    mocked.betaReceipt.mockRejectedValue(new Error("private-beta-artifact-diagnostic"));
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(console.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it("preserves the disabled legacy lane without silently requiring an unavailable hosted Beta receipt", async () => {
    process.argv.push("--beta");
    vi.stubEnv("ZEROS_HOSTED_PROMOTION", "disabled");
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledOnce());
    expect(mocked.betaReceipt).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["enabled", "disabled"])("writes ready=true after successful automatic Alpha CI with flag %s", async flag => {
    const output = await automaticBarrier(flag);
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledOnce());
    expect(await readFile(output, "utf8")).toBe("ready=true\n");
    expect(process.exitCode).toBeUndefined();
    expect(mocked.assertCurrent).toHaveBeenCalledTimes(2);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["enabled", "disabled"])("refuses an unauthenticated automatic Alpha barrier with flag %s", async flag => {
    const output = await automaticBarrier(flag);
    mocked.automaticAlpha.mockResolvedValue(false);
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith("Automatic Alpha barrier identity could not be authenticated; verify the release-alpha.yml parent run, run attempt, repository, source SHA and GITHUB_WORKFLOW_REF before retrying.");
    expect(console.log).not.toHaveBeenCalled();
    expect(mocked.waitForRequiredCI).not.toHaveBeenCalled();
    expect(mocked.assertCurrent).not.toHaveBeenCalled();
    expect(mocked.alphaBarrierUnmutated).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["enabled", "disabled"])("turns a proven pre-mutation Alpha supersession into ready=false and a green notice with flag %s", async flag => {
    const output = await automaticBarrier(flag);
    const { CandidateSupersededError } = await import("./alpha-ci");
    mocked.assertCurrent.mockRejectedValue(new CandidateSupersededError());
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledOnce());
    expect(await readFile(output, "utf8")).toBe("ready=false\n");
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^::notice::.*superseded.*before.*mutation/));
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    expect(mocked.requiredChecks).not.toHaveBeenCalled();
    expect(mocked.alphaBarrierUnmutated).toHaveBeenCalledOnce();
  });

  it("handles supersession after the last successful poll before any mutation", async () => {
    const output = await automaticBarrier();
    const { CandidateSupersededError } = await import("./alpha-ci");
    mocked.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new CandidateSupersededError());
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledOnce());
    expect(await readFile(output, "utf8")).toBe("ready=false\n");
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps a retry red when a prior attempt may already have mutated a destination", async () => {
    const output = await automaticBarrier();
    const { CandidateSupersededError } = await import("./alpha-ci");
    mocked.assertCurrent.mockRejectedValue(new CandidateSupersededError());
    mocked.alphaBarrierUnmutated.mockResolvedValue(false);
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never converts a generic PromotionError with the supersession message into a green no-op", async () => {
    await automaticBarrier();
    const { PromotionError } = await import("./contracts");
    mocked.assertCurrent.mockRejectedValue(new PromotionError("Candidate was superseded before mutation; run the current branch SHA"));
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(mocked.alphaBarrierUnmutated).not.toHaveBeenCalled();
  });

  it.each(["--verify", "worker"])("keeps automatic Alpha supersession red outside the initial wait barrier (%s)", async location => {
    const output = await automaticBarrier();
    if (location === "--verify") process.argv[2] = location;
    else vi.stubEnv("GITHUB_JOB", location);
    const { CandidateSupersededError } = await import("./alpha-ci");
    mocked.assertCurrent.mockRejectedValue(new CandidateSupersededError());
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(mocked.alphaBarrierUnmutated).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["beta", "production"])("keeps %s supersession red and emits no Alpha output even with the flag enabled", async channel => {
    const output = await automaticBarrier();
    mocked.source.channel = channel;
    mocked.source.branch = "release/0.1.20";
    const { CandidateSupersededError } = await import("./alpha-ci");
    mocked.assertCurrent.mockRejectedValue(new CandidateSupersededError());
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(mocked.automaticAlpha).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps unauthenticated manual Alpha on the full policy without ready output", async () => {
    const output = await automaticBarrier();
    vi.stubEnv("GITHUB_WORKFLOW_REF", `${mocked.source.repository}/.github/workflows/controlled-cutover.yml@refs/heads/main`);
    mocked.automaticAlpha.mockResolvedValue(false);
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledOnce());
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["admitted", "enabled"])("writes source-bound admission proof only after successful %s barrier checks", async flag => {
    const output = await automaticBarrier();
    process.chdir(path.dirname(output));
    vi.stubEnv("ZEROS_ALPHA_FORWARD_ONLY", flag);
    vi.stubEnv("GITHUB_RUN_ID", "300"); vi.stubEnv("GITHUB_RUN_ATTEMPT", "1");
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.log).toHaveBeenCalledOnce());
    expect(await readFile(output, "utf8")).toBe("admission_issued=true\nready=true\n");
    expect(JSON.parse(await readFile(".context/release/alpha-admission.json", "utf8"))).toEqual({ version: 1,
      ...mocked.source, runId: "300", runAttempt: "1", mode: flag });
    expect(mocked.assertCurrent).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBeUndefined();
  });

  it.each([true, false])("only skips a known newer destination when parent mutation evidence is unmutated=%s", async unmutated => {
    const output = await automaticBarrier();
    vi.stubEnv("ZEROS_ALPHA_FORWARD_ONLY", "enabled");
    const { AlphaAdmissionRejectedError } = await import("./alpha-frontier");
    mocked.assertCurrent.mockRejectedValue(new AlphaAdmissionRejectedError());
    mocked.alphaBarrierUnmutated.mockResolvedValue(unmutated);
    await import("./ci-cli");
    await vi.waitFor(() => expect(unmutated ? console.log : console.error).toHaveBeenCalledOnce());
    if (unmutated) expect(await readFile(output, "utf8")).toBe("ready=false\n");
    else await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.exitCode).toBe(unmutated ? undefined : 1);
  });

  it.each([true, false])("keeps an unavailable destination unadmitted with unmutated=%s", async unmutated => {
    const output = await automaticBarrier();
    process.chdir(path.dirname(output));
    vi.stubEnv("ZEROS_ALPHA_FORWARD_ONLY", "enabled");
    const { AlphaAdmissionRejectedError } = await import("./alpha-frontier");
    mocked.assertCurrent.mockRejectedValue(new AlphaAdmissionRejectedError("Alpha live API/schema identity is unavailable"));
    mocked.alphaBarrierUnmutated.mockResolvedValue(unmutated);
    await import("./ci-cli");
    await vi.waitFor(() => expect(unmutated ? console.log : console.error).toHaveBeenCalledOnce());
    if (unmutated) {
      expect(await readFile(output, "utf8")).toBe("ready=false\n");
      expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/^::notice::.*not admitted.*before.*mutation/));
      expect(console.error).not.toHaveBeenCalled();
    } else {
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect(console.log).not.toHaveBeenCalled();
    }
    await expect(readFile(".context/release/alpha-admission.json")).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.exitCode).toBe(unmutated ? undefined : 1);
    expect(mocked.requiredChecks).not.toHaveBeenCalled();
  });

  it.each(["--verify", "worker"])("keeps an unavailable destination red outside initial admission (%s)", async location => {
    const output = await automaticBarrier();
    if (location === "--verify") process.argv[2] = location;
    else vi.stubEnv("GITHUB_JOB", location);
    const { AlphaAdmissionRejectedError } = await import("./alpha-frontier");
    mocked.assertCurrent.mockRejectedValue(new AlphaAdmissionRejectedError("Alpha live API/schema identity is unavailable"));
    await import("./ci-cli");
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
    expect(mocked.alphaBarrierUnmutated).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
