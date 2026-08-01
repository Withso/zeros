import { describe, expect, it } from "vitest";

import type { GithubCredentialSummary } from "@zeros/core/github-auth";
import {
  githubAppConnectOptions,
  githubAutomaticSetup,
  githubMethodLabel,
  githubMethodStatusCopy,
  githubRefreshFailureSnapshot,
  shouldShowGithubTopRefresh,
} from "../github-section-helpers";

function summary(
  patch: Partial<GithubCredentialSummary>,
): GithubCredentialSummary {
  return {
    method: "pat",
    health: "connected",
    configured: true,
    login: "octocat",
    ...patch,
  };
}

describe("GitHub settings row helpers", () => {
  it("forces installation only after a complete inventory confirms zero installations", () => {
    expect(
      githubAppConnectOptions(
        summary({
          method: "github-app",
          configured: true,
          installationCount: 0,
        }),
      ),
    ).toEqual({ installFlow: true, forceInstall: true });
    expect(
      githubAppConnectOptions(
        summary({
          method: "github-app",
          configured: true,
          installationCount: undefined,
        }),
      ),
    ).toEqual({ installFlow: false, forceInstall: false });
    expect(
      githubAppConnectOptions(
        summary({
          method: "github-app",
          configured: false,
          health: "not-connected",
        }),
      ),
    ).toEqual({ installFlow: true, forceInstall: false });
  });

  it("does not expose sign-in setup before the first confirmed auth snapshot", () => {
    const snapshot = {
      selectedMethod: "gh-cli" as const,
      methods: {
        "gh-cli": summary({
          method: "gh-cli",
          health: "not-connected",
          configured: false,
        }),
        "github-app": summary({
          method: "github-app",
          health: "not-connected",
          configured: false,
        }),
        pat: summary({
          method: "pat",
          health: "not-connected",
          configured: false,
        }),
      },
    };

    expect(githubAutomaticSetup(snapshot, false)).toBeNull();
    expect(githubAutomaticSetup(snapshot, true)).toBe("gh-cli");
    expect(
      githubAutomaticSetup(
        {
          ...snapshot,
          methods: {
            ...snapshot.methods,
            "gh-cli": summary({
              method: "gh-cli",
              health: "unavailable",
              configured: false,
            }),
          },
        },
        true,
      ),
    ).toBeNull();
    expect(
      githubAutomaticSetup(
        {
          ...snapshot,
          methods: {
            ...snapshot.methods,
            "gh-cli": summary({ method: "gh-cli" }),
          },
        },
        true,
      ),
    ).toBeNull();
  });

  it("uses the user-facing method names", () => {
    expect(githubMethodLabel("gh-cli")).toBe("gh CLI auth");
    expect(githubMethodLabel("github-app")).toBe("GitHub App");
    expect(githubMethodLabel("pat")).toBe("Personal Access Token");
  });

  it("puts Refresh in the detail row only for the healthy active method", () => {
    expect(shouldShowGithubTopRefresh(summary({}), true)).toBe(false);
    expect(shouldShowGithubTopRefresh(summary({}), false)).toBe(true);
    expect(
      shouldShowGithubTopRefresh(summary({ health: "rate-limited" }), true),
    ).toBe(true);
    expect(
      shouldShowGithubTopRefresh(
        summary({ health: "unavailable", configured: false }),
        true,
      ),
    ).toBe(true);
    expect(
      shouldShowGithubTopRefresh(
        summary({ health: "not-connected", configured: false }),
        true,
      ),
    ).toBe(false);
  });

  it("uses method-specific connected status copy", () => {
    expect(githubMethodStatusCopy(summary({ method: "gh-cli" }))).toBe(
      "GitHub CLI is authenticated and ready.",
    );
    expect(
      githubMethodStatusCopy(
        summary({ method: "github-app", allRepositories: true }),
      ),
    ).toBe("All repositories accessible.");
    expect(
      githubMethodStatusCopy(
        summary({
          method: "github-app",
          allRepositories: false,
          repositoryCount: 3,
        }),
      ),
    ).toBe("3 repositories accessible.");
    expect(githubMethodStatusCopy(summary({ method: "pat" }))).toBe(
      "Validated for API and Git operations.",
    );
  });

  it("keeps confirmed identity metadata and marks only a failed Refresh unavailable", () => {
    const snapshot = {
      selectedMethod: "github-app" as const,
      methods: {
        "gh-cli": summary({ method: "gh-cli" }),
        "github-app": summary({
          method: "github-app",
          installationCount: 2,
          repositoryCount: 7,
        }),
        pat: summary({ method: "pat" }),
      },
    };

    const next = githubRefreshFailureSnapshot(snapshot, "github-app");

    expect(next.methods["github-app"]).toMatchObject({
      login: "octocat",
      installationCount: 2,
      repositoryCount: 7,
      health: "unavailable",
      detail: "Couldn’t check this connection. You may be offline.",
    });
    expect(next.methods["gh-cli"]).toBe(snapshot.methods["gh-cli"]);
    expect(next.methods.pat).toBe(snapshot.methods.pat);
  });
});
