import { beforeEach, describe, expect, it, vi } from "vitest";

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("../posthog", () => ({ capture }));

import {
  githubConnectErrorKind,
  trackGithubConnectCompleted,
  trackGithubConnectStarted,
  trackGithubHealthRefreshed,
  trackGithubInstallOpened,
  trackGithubMethodSelected,
} from "../github-events";

beforeEach(() => {
  capture.mockClear();
});

describe("GitHub analytics PII contract", () => {
  it("emits fixed scalar metadata without identity or repository fields", () => {
    trackGithubMethodSelected({
      method: "github-app",
      previousMethod: "gh-cli",
      hadOtherCredential: true,
    });
    trackGithubConnectStarted({
      method: "github-app",
      entryPoint: "settings",
    });
    trackGithubConnectCompleted({
      method: "github-app",
      outcome: "error",
      errorKind: "github_unavailable",
    });
    trackGithubInstallOpened({
      variantKey: "github.com",
      kind: "new",
    });
    trackGithubHealthRefreshed({
      method: "github-app",
      state: "connected",
      installationCount: 2,
      repositoryCountKnown: true,
    });

    expect(capture).toHaveBeenCalledTimes(5);
    for (const [, props] of capture.mock.calls) {
      expect(Object.keys(props)).not.toEqual(
        expect.arrayContaining([
          "login",
          "repository",
          "branch",
          "url",
          "message",
        ]),
      );
      for (const value of Object.values(props)) {
        expect(["string", "number", "boolean", "undefined"]).toContain(
          typeof value,
        );
        if (typeof value === "string") {
          expect(value).not.toMatch(/[/\\@\n]/);
          expect(value.length).toBeLessThanOrEqual(40);
        }
      }
    }
  });

  it("maps an adversarial error code to unknown", () => {
    expect(
      githubConnectErrorKind({
        code: "/Users/alice/private-repo alice@example.com",
      }),
    ).toBe("unknown");
  });
});
