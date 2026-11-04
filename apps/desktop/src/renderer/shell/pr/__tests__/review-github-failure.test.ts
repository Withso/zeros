import { afterEach, describe, expect, it, vi } from "vitest";
import type { GithubAuthSnapshot, GithubCredentialSummary } from "@zeros/protocol/github-auth";
import { ghAuthStatusCache } from "../../../state/read-caches";
import {
  WorkbenchConditionError,
  describeWorkbenchFailure,
} from "../../workbench/tab-status-model";
import {
  LOCAL_GITHUB_DIAGNOSIS_WAIT_MS,
  describeReviewGithubFailure,
  localGithubDiagnosis,
  reviewGithubFailureCode,
  useReviewGithubFailure,
} from "../review-github-failure";

const fixture = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  snapshot: vi.fn(),
  dispatch: vi.fn(),
  section: vi.fn(),
}));
// Run the hook as a plain function: effects are collected and run explicitly,
// so the test observes whether the Settings probe actually starts.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useCallback: (callback: unknown) => callback,
  useMemo: (compute: () => unknown) => compute(),
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: (effect: () => void | (() => void)) => { fixture.effects.push(effect); },
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("../../../platform/git", async (original) => ({
  ...await original<typeof import("../../../platform/git")>(),
  ghAuthSnapshot: fixture.snapshot,
}));
vi.mock("../../../state/store", () => ({ useWorkspaceDispatch: () => fixture.dispatch }));
vi.mock("../../../features/settings/settings-navigation", () => ({ requestUserSettingsSection: fixture.section }));

const LOCAL = "local-review-workspace";
const CLOUD = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const SIGNED_OUT = Object.assign(new Error("Not signed in to GitHub"), {
  code: "NOT_AUTHENTICATED",
  remediation: "Connect GitHub in Settings → Integrations.",
});

function summary(patch: Partial<GithubCredentialSummary>): GithubCredentialSummary {
  return { method: "github-app", health: "connected", configured: true, login: "octocat", ...patch };
}
function snapshot(selected: GithubCredentialSummary): GithubAuthSnapshot {
  return {
    selectedMethod: selected.method,
    methods: {
      "gh-cli": { method: "gh-cli", health: "not-connected", configured: false },
      "github-app": { method: "github-app", health: "not-connected", configured: false },
      pat: { method: "pat", health: "not-connected", configured: false },
      [selected.method]: selected,
    },
  };
}
function Fixture(error: unknown, options: { workspaceId: string; active: boolean }) {
  const value = useReviewGithubFailure(error, options);
  for (const effect of fixture.effects.splice(0)) effect();
  return value;
}
async function settle() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => {
  ghAuthStatusCache.clear();
  fixture.effects.length = 0;
  fixture.snapshot.mockReset();
  fixture.dispatch.mockReset();
  fixture.section.mockReset();
});

describe("Review GitHub failure copy", () => {
  it.each([
    [summary({ health: "unavailable", detail: "This GitHub connection needs to be re-authorized." }),
      "This GitHub connection needs to be re-authorized."],
    [summary({ health: "invalid" }), "GitHub revoked this connection. Reconnect to continue."],
    [summary({ health: "unavailable" }), "Couldn’t check this connection. You may be offline."],
    [summary({ health: "connected" }), "GitHub refused this connection."],
    [summary({ method: "gh-cli", health: "not-connected", configured: false }),
      "Connect GitHub to load this pull request."],
    [summary({ method: "gh-cli", health: "unavailable", configured: false, detail: "GitHub CLI authentication could not be checked." }),
      "GitHub CLI authentication could not be checked."],
    [undefined, "GitHub didn't accept this connection."],
  ])("describes a Local sign-in refusal from the selected method %#", (connection, message) => {
    expect(describeReviewGithubFailure({ code: "NOT_AUTHENTICATED", cloud: false, connection })).toBe(message);
  });

  it.each([
    ["GITHUB_REPO_NOT_INSTALLED", false, "Your GitHub connection can't reach this repository."],
    ["GITHUB_REPO_NOT_INSTALLED", true, "Your cloud GitHub connection can't reach this repository."],
    ["GITHUB_FORBIDDEN_SCOPE", false, "Your GitHub connection can't read this pull request."],
    ["GITHUB_SSO_REQUIRED", true, "This organization requires SAML authorization for your GitHub connection."],
    ["GITHUB_INSTALLATION_SUSPENDED", false, "This GitHub App installation is suspended. Ask the account owner to restore it."],
    ["GITHUB_RATE_LIMITED", false, "GitHub is rate-limiting requests. Retry in a moment."],
    ["NETWORK_ERROR", false, "Zeros couldn't reach GitHub. Check your network, then retry."],
    ["NOT_AUTHENTICATED", true, "Reconnect your cloud GitHub connection to load this pull request."],
  ])("describes %s (cloud: %s)", (code, cloud, message) => {
    expect(describeReviewGithubFailure({ code, cloud })).toBe(message);
  });

  it("names only GitHub connection outcomes", () => {
    for (const code of ["NOT_AUTHENTICATED", "GITHUB_SSO_REQUIRED", "GITHUB_FORBIDDEN_SCOPE",
      "GITHUB_REPO_NOT_INSTALLED", "GITHUB_INSTALLATION_SUSPENDED", "GITHUB_RATE_LIMITED", "NETWORK_ERROR"])
      expect(reviewGithubFailureCode({ code })).toBe(code);
    for (const error of [{ code: "GITHUB_API_ERROR" }, { code: "VALIDATION_FAILED" },
      { code: "CLOUD_V2_UNSUPPORTED" }, new Error("NOT_AUTHENTICATED"), "NOT_AUTHENTICATED", null])
      expect(reviewGithubFailureCode(error)).toBeNull();
  });
});

describe("useReviewGithubFailure", () => {
  it("reads Settings for a visible Local sign-in refusal and names its diagnosis", async () => {
    fixture.snapshot.mockResolvedValue(snapshot(summary({
      health: "unavailable", detail: "This GitHub connection needs to be re-authorized.",
    })));
    const first = Fixture(SIGNED_OUT, { workspaceId: LOCAL, active: true });
    // Until Settings answers, the banner must not claim nothing is connected.
    expect(describeWorkbenchFailure("review", first).message).toBe("GitHub didn't accept this connection.");
    await settle();
    expect(fixture.snapshot).toHaveBeenCalledOnce();
    const status = describeWorkbenchFailure("review", Fixture(SIGNED_OUT, { workspaceId: LOCAL, active: true }));
    expect(status).toMatchObject({
      tone: "error",
      message: "This GitHub connection needs to be re-authorized.",
      diagnostic: "Not signed in to GitHub",
    });
    expect(status.action).toBeUndefined();
    status.command!.run();
    expect(fixture.section).toHaveBeenCalledWith("integrations");
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "SET_ACTIVE_PAGE", page: "settings" });
  });

  it.each([
    ["GITHUB_RATE_LIMITED", "Retry"],
    ["NETWORK_ERROR", "Retry"],
    ["GITHUB_SSO_REQUIRED", "Open GitHub settings"],
    ["GITHUB_INSTALLATION_SUSPENDED", "Open GitHub settings"],
  ])("offers %s's fix as %s", (code, label) => {
    const status = describeWorkbenchFailure("review", Fixture(Object.assign(new Error(code), { code }), { workspaceId: CLOUD, active: true }));
    expect(status.command?.label ?? status.action).toBe(label);
  });

  it.each([
    ["a hidden Local tab", SIGNED_OUT, LOCAL, false],
    ["a cloud workspace", SIGNED_OUT, CLOUD, true],
    ["a refusal Settings cannot explain", Object.assign(new Error("not installed"), { code: "GITHUB_REPO_NOT_INSTALLED" }), LOCAL, true],
  ])("does not probe the Mac's GitHub methods for %s", async (_case, error, workspaceId, active) => {
    const value = Fixture(error, { workspaceId, active });
    await settle();
    expect(value).toBeInstanceOf(WorkbenchConditionError);
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });

  it("reads Settings' diagnosis for a Local Create PR refusal and never for cloud", async () => {
    fixture.snapshot.mockResolvedValue(snapshot(summary({
      health: "unavailable", detail: "This GitHub connection needs to be re-authorized.",
    })));
    await expect(localGithubDiagnosis(CLOUD)).resolves.toBeUndefined();
    expect(fixture.snapshot).not.toHaveBeenCalled();
    await expect(localGithubDiagnosis(LOCAL)).resolves.toBe("This GitHub connection needs to be re-authorized.");
    expect(fixture.snapshot).toHaveBeenCalledOnce();
    ghAuthStatusCache.clear();
    fixture.snapshot.mockResolvedValue(snapshot(summary({ health: "connected" })));
    await expect(localGithubDiagnosis(LOCAL)).resolves.toBeUndefined();
    ghAuthStatusCache.clear();
    fixture.snapshot.mockRejectedValue(new Error("native bridge unavailable"));
    await expect(localGithubDiagnosis(LOCAL)).resolves.toBeUndefined();
  });

  it("keeps the action's own copy when Settings is slow", async () => {
    vi.useFakeTimers();
    try {
      fixture.snapshot.mockReturnValue(new Promise(() => {}));
      const diagnosis = localGithubDiagnosis(LOCAL);
      await vi.advanceTimersByTimeAsync(LOCAL_GITHUB_DIAGNOSIS_WAIT_MS - 1);
      expect(fixture.snapshot).toHaveBeenCalledOnce();
      let settled = false;
      void diagnosis.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(diagnosis).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes other failures through unchanged", async () => {
    const error = new Error("engine disconnected");
    expect(Fixture(error, { workspaceId: LOCAL, active: true })).toBe(error);
    expect(Fixture(null, { workspaceId: LOCAL, active: true })).toBeNull();
    await settle();
    expect(fixture.snapshot).not.toHaveBeenCalled();
  });
});
