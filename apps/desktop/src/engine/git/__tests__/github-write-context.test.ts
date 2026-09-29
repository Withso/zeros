import { afterEach, describe, expect, it, vi } from "vitest";
import { githubWriteCredential, runWithGithubWriteCredential } from "../github-write-context";
import { setOctokitFactoryForTesting, setTokenStoreForTesting, updatePr } from "../github";
import { closeGitCredentialBrokerForTesting, prepareGitCredentialInvocation, setGitCredentialSourceForTesting } from "../credential-broker";

afterEach(async () => {
  setOctokitFactoryForTesting(null); setTokenStoreForTesting(null);
  setGitCredentialSourceForTesting(null); await closeGitCredentialBrokerForTesting();
});

const credential = (token: string) => ({ token, apiBaseUrl: "https://api.example.test/internal/v1/cloud-workspaces/github-proxy/api", gitBaseUrl: "https://api.example.test/internal/v1/cloud-workspaces/github-proxy/git/", owner: "sample-org", repository: "sample", expiresAtMs: Date.now() + 60_000 });
describe("request-scoped cloud GitHub writes", () => {
  it("does not rotate or clear the shared read credential after a write token is rejected", async () => {
    const store = { get: vi.fn(async () => "ambient-read-token"), set: vi.fn(), clear: vi.fn(), refreshAfterRejection: vi.fn() };
    setTokenStoreForTesting(store);
    const update = vi.fn(async () => { throw Object.assign(new Error("Rejected"), { status: 401 }); });
    const factory = vi.fn(() => ({ pulls: { update } })); setOctokitFactoryForTesting(factory as never);
    await expect(runWithGithubWriteCredential(credential("scoped-write-token"), () => true, () => updatePr({ workspaceId: "workspace", prNumber: 1, title: "Title" }, { owner: "sample-org", repo: "sample" }))).rejects.toThrow();
    expect(factory).toHaveBeenCalledWith("scoped-write-token", credential("").apiBaseUrl);
    expect(update).toHaveBeenCalledTimes(1);
    expect(store.get).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled(); expect(store.refreshAfterRejection).not.toHaveBeenCalled();
    await expect(runWithGithubWriteCredential(credential("scoped-write-token"), () => true, () => updatePr({ workspaceId: "workspace", prNumber: 1 }, { owner: "other", repo: "sample" }))).rejects.toThrow("GitHub write authorization");
    expect(update).toHaveBeenCalledTimes(1);
  });
  it("uses a private helper grant for exact HTTPS Git requests and refuses remote substitutions", async () => {
    const ambient = { supports: () => true, getCredential: vi.fn(async () => null) };
    setGitCredentialSourceForTesting(ambient);
    const request = { contextId: "workspace", protocol: "https" as const, host: "github.com", authority: "github.com", path: "sample-org/sample.git" };
    await runWithGithubWriteCredential(credential("scoped-write-token"), () => true, async () => {
      const invocation = await prepareGitCredentialInvocation(request);
      expect(invocation).not.toBeNull();
      expect(JSON.stringify(invocation)).not.toContain("scoped-write-token");
      expect(invocation?.credentialFingerprint).toBeNull();
      invocation?.release?.();
      for (const replacement of [{ path: "sample-org/other.git" }, { authority: "github.com:443" }, { protocol: "http" as const }])
        await expect(prepareGitCredentialInvocation({ ...request, ...replacement })).rejects.toThrow("does not cover this remote");
    });
    expect(ambient.getCredential).not.toHaveBeenCalled();
  });
  it("isolates simultaneous actors and never installs an ambient credential", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = runWithGithubWriteCredential(credential("first-test-token"), () => true, async () => {
      await gate;
      return githubWriteCredential()?.token;
    });
    expect(githubWriteCredential()).toBeNull();
    expect(await runWithGithubWriteCredential(credential("second-test-token"), () => true, async () => githubWriteCredential()?.token)).toBe("second-test-token");
    release();
    expect(await first).toBe("first-test-token");
    expect(githubWriteCredential()).toBeNull();
  });
  it("rejects a changed actor, an expired grant and a different repository", async () => {
    let live = true;
    await runWithGithubWriteCredential(credential("test-token"), () => live, async () => {
      expect(githubWriteCredential({ owner: "SAMPLE-ORG", repository: "SAMPLE" })?.token).toBe("test-token");
      expect(() => githubWriteCredential({ owner: "sample-org", repository: "other" })).toThrow("GitHub write authorization");
      live = false;
      expect(() => githubWriteCredential()).toThrow("GitHub write authorization");
    });
    await expect(runWithGithubWriteCredential({ ...credential("test-token"), expiresAtMs: 1 }, () => true, async () => githubWriteCredential())).rejects.toThrow("GitHub write authorization");
  });
  it("fences inherited asynchronous work after the operation finishes, including failure", async () => {
    let later!: () => void;
    const gate = new Promise<void>(resolve => { later = resolve; });
    let detached!: Promise<unknown>;
    const observed = vi.fn();
    await expect(runWithGithubWriteCredential(credential("test-token"), () => true, async () => {
      detached = gate.then(() => { try { githubWriteCredential(); } catch (error) { observed(error); } });
      throw new Error("operation failed");
    })).rejects.toThrow("operation failed");
    later(); await detached;
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ message: "GitHub write authorization is no longer valid. Try again." }));
  });
});
