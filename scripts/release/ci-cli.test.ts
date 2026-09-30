import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  source: { channel: "production", sourceSha: "a".repeat(40), repository: "Withso/zeros", branch: "release/0.1.20" },
  command: vi.fn(), assertRequiredChecks: vi.fn(), assertCurrent: vi.fn(), betaReceipt: vi.fn(), requiredChecks: vi.fn(), waitForRequiredCI: vi.fn(),
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
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  process.argv = ["node", "ci-cli.ts", "--verify"];
  process.exitCode = undefined;
  mocked.command.mockResolvedValue(mocked.source.sourceSha);
  mocked.assertRequiredChecks.mockResolvedValue(undefined);
  mocked.assertCurrent.mockResolvedValue(undefined);
  mocked.betaReceipt.mockResolvedValue(undefined);
  mocked.requiredChecks.mockResolvedValue([]);
  mocked.waitForRequiredCI.mockImplementation(async (read: () => Promise<unknown>) => read());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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
});
