import { describe, expect, it } from "vitest";

import {
  describePrAccessBlock,
  describePrCreateFailure,
  needsGithubSettings,
} from "../pr-github-access";

describe("describePrAccessBlock", () => {
  it("offers sign-in only when nothing is connected", () => {
    expect(
      describePrAccessBlock({ code: "NOT_AUTHENTICATED", connected: false }),
    ).toEqual({
      title: "Connect GitHub to create this pull request",
      description:
        "Choose an authentication method in Settings → Integrations to continue.",
      openSettings: true,
    });
  });

  // The reported bug: a connected GitHub App whose installation doesn't cover
  // this repository. GitHub answers with a 404, `git push` reports "Repository
  // not found", and the transport classifier has to call that
  // NOT_AUTHENTICATED — which used to tell a connected user to connect GitHub.
  it("never tells a connected user to connect GitHub", () => {
    const message = describePrAccessBlock({
      code: "NOT_AUTHENTICATED",
      connected: true,
    });
    expect(message.title).not.toMatch(/connect github/i);
    expect(message.description).toMatch(/access to this repository/i);
    expect(message.openSettings).toBe(true);
  });

  it("names repository reach as the problem for an uninstalled repo", () => {
    const message = describePrAccessBlock({
      code: "GITHUB_REPO_NOT_INSTALLED",
      connected: true,
      remediation: "Grant the GitHub connection access to this repository.",
    });
    expect(message.title).toMatch(/can't reach this repository/i);
    expect(message.description).toBe(
      "Grant the GitHub connection access to this repository.",
    );
    expect(message.openSettings).toBe(true);
  });

  it("keeps the engine's own remediation as the description", () => {
    for (const code of [
      "GITHUB_FORBIDDEN_SCOPE",
      "GITHUB_SSO_REQUIRED",
      "GITHUB_INSTALLATION_SUSPENDED",
    ]) {
      expect(
        describePrAccessBlock({ code, remediation: "Do the specific thing." })
          .description,
      ).toBe("Do the specific thing.");
    }
  });

  // A missing remote or a non-github.com host is fixed in the repository, not
  // in Settings — a button that opens Settings would send the user nowhere.
  it("does not offer GitHub settings for a repository-shaped problem", () => {
    const message = describePrAccessBlock({
      code: "VALIDATION_FAILED",
      message: "This repository has no 'origin' remote on GitHub.",
      remediation: "Publish the repository to GitHub first.",
    });
    expect(message).toEqual({
      title: "Couldn't create pull request",
      description: "Publish the repository to GitHub first.",
      openSettings: false,
    });
  });

  it("falls back to the message when there is no remediation", () => {
    expect(
      describePrAccessBlock({ code: "VALIDATION_FAILED", message: "Nope." })
        .description,
    ).toBe("Nope.");
  });
});

describe("describePrCreateFailure", () => {
  it("prefers the preflight verdict over the operation's own error", () => {
    const message = describePrCreateFailure(
      { code: "NOT_AUTHENTICATED", message: "git push origin foo failed" },
      {
        state: "blocked",
        connected: true,
        code: "GITHUB_REPO_NOT_INSTALLED",
        remediation: "Grant access to this repository.",
      },
    );
    expect(message.title).toMatch(/can't reach this repository/i);
  });

  // With no verdict the error stands, but the probe still contributes the one
  // fact a GitError never carries: whether a credential exists at all.
  it("borrows `connected` from an indeterminate probe", () => {
    const message = describePrCreateFailure(
      { code: "NOT_AUTHENTICATED", message: "git push origin foo failed" },
      { state: "unknown", connected: true },
    );
    expect(message.title).toBe("GitHub refused this connection");
  });

  it("keeps a plain error's own sentence", () => {
    expect(
      describePrCreateFailure({ message: "Request timeout: WORKSPACE_REQUEST" }),
    ).toEqual({
      title: "Couldn't create pull request",
      description: "Request timeout: WORKSPACE_REQUEST",
      openSettings: false,
    });
  });
});

describe("needsGithubSettings", () => {
  it("matches the codes the engine treats as definite access refusals", () => {
    for (const code of [
      "NOT_AUTHENTICATED",
      "GITHUB_SSO_REQUIRED",
      "GITHUB_FORBIDDEN_SCOPE",
      "GITHUB_REPO_NOT_INSTALLED",
      "GITHUB_INSTALLATION_SUSPENDED",
    ]) {
      expect(needsGithubSettings(code)).toBe(true);
    }
    expect(needsGithubSettings("VALIDATION_FAILED")).toBe(false);
    expect(needsGithubSettings(undefined)).toBe(false);
  });
});
