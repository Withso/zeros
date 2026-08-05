// End-to-end reproduction of the reported failure.
//
// Clicking "Open GitHub" against a control plane that has no GitHub routes
// produced this toast:
//
//   Couldn't open GitHub
//   Error invoking remote method 'zeros:invoke': GithubAppClientError: Not found
//
// Three separate defects stacked up: begin() rethrew the client error unmapped,
// a 404 was not recognised as "this deployment cannot do App sign-in", and
// Electron's IPC wrapper reached the UI verbatim. This drives the real client,
// the real controller, the real IPC error conversion, and the real renderer
// parser over the exact 404 body `apps/control-plane/src/index.ts` returns.

import { describe, expect, it, vi } from "vitest";

import {
  NativeCommandError,
  parseNativeErrorMessage,
} from "@zeros/protocol/native-error";
import { GithubAppClient, GithubAppClientError } from "../github-app-client";
import {
  GithubAppController,
  GithubAppFlowError,
  type GithubAppControllerDependencies,
} from "../github-app-controller";

/** `app.notFound` in apps/control-plane/src/index.ts, byte for byte. */
const CONTROL_PLANE_404 = {
  status: 404,
  body: { error: { code: "not_found", message: "Not found" } },
};

/** What `createGithubUnconfiguredRoutes()` answers instead. */
const CONTROL_PLANE_503 = {
  status: 503,
  body: {
    error: {
      code: "github_not_configured",
      message: "GitHub sign-in is not configured on this Zeros control plane.",
    },
  },
};

function controllerAgainst(response: {
  status: number;
  body: unknown;
}): GithubAppController {
  const client = new GithubAppClient({
    baseUrl: "https://api.zeros.build",
    fetch: (async () =>
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  const deps: GithubAppControllerDependencies = {
    client,
    credentialStore: {
      get: async () => null,
      set: async () => undefined,
      clear: async () => undefined,
      getSelectedMethod: async () => "gh-cli",
      setSelectedMethod: async () => undefined,
    },
    compareAndSetCredential: async () => false,
    getSession: async () => ({ accessToken: "zeros-access", sub: "auth0|one" }),
    savePending: vi.fn(),
    consumePending: () => ({ status: "missing" }),
    discardPending: vi.fn(),
    clearPending: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    randomNonce: () => "n".repeat(43),
    withCredentialLock: async (operation) => operation(),
    afterCredentialChange: vi.fn(),
    emitConnected: vi.fn(),
    emitError: vi.fn(),
  };
  return new GithubAppController(deps);
}

/** apps/desktop/electron/ipc/commands/github.ts's conversion, then Electron's own wrapper,
 *  then the parse apps/desktop/src/renderer/platform/runtime.ts performs in the renderer. */
function asRendererSees(error: unknown): { message: string; code?: string } {
  const command =
    error instanceof GithubAppFlowError
      ? new NativeCommandError(error.message, error.reason)
      : (error as Error);
  return parseNativeErrorMessage(
    `Error invoking remote method 'zeros:invoke': ${command}`,
  );
}

describe("GitHub App connect error surface", () => {
  it.each([
    ["a control plane with no GitHub routes", CONTROL_PLANE_404],
    ["a control plane with no App registered", CONTROL_PLANE_503],
  ])("turns %s into actionable Settings copy", async (_label, response) => {
    const failure = await controllerAgainst(response)
      .begin({ scheme: "zeros-dev", installFlow: true })
      .catch((error: unknown) => error);

    const rendererError = asRendererSees(failure);

    // The transport wrapper and the class name are both gone.
    expect(rendererError.message).not.toContain("invoking remote method");
    expect(rendererError.message).not.toContain("GithubAppClientError");
    expect(rendererError.message).not.toContain("Not found");

    // The reason survived, so Settings renders written copy for this state
    // rather than an exception (the copy itself is asserted in
    // apps/desktop/src/renderer/platform/bridge/__tests__/github-app-notifications.test.ts).
    expect(rendererError.code).toBe("not_configured");
    expect(rendererError.message).toMatch(/gh CLI or a Personal Access Token/);
  });

  // The user-facing copy merges these two on purpose; the operator's fix does
  // not. On 2026-07-30 a control plane three days behind main answered 404 and
  // was indistinguishable in the log from a missing App registration — the
  // remedies being "redeploy the backend" and "set GITHUB_APP_*".
  it.each([
    ["a control plane with no GitHub routes", CONTROL_PLANE_404, 404, "not_found"],
    [
      "a control plane with no App registered",
      CONTROL_PLANE_503,
      503,
      "github_not_configured",
    ],
  ] as const)(
    "carries what %s actually answered on the error's cause",
    async (_label, response, status, code) => {
      const failure = (await controllerAgainst(response)
        .begin({ scheme: "zeros-dev", installFlow: true })
        .catch((error: unknown) => error)) as GithubAppFlowError;

      const cause = failure.cause as GithubAppClientError;
      expect(cause).toBeInstanceOf(GithubAppClientError);
      expect({ status: cause.status, code: cause.code }).toEqual({
        status,
        code,
      });
    },
  );

  // A 404 whose body is not our error envelope never reached the control
  // plane's router — it is an edge page or a misrouted origin. Reporting that
  // as "not configured" pinned a deployment fault on the feature and told the
  // user to give up on App sign-in permanently.
  it("does not call a proxy's 404 an unconfigured control plane", async () => {
    const failure = (await controllerAgainst({
      status: 404,
      body: { message: "no such app" },
    })
      .begin({ scheme: "zeros-dev", installFlow: true })
      .catch((error: unknown) => error)) as GithubAppFlowError;

    const rendererError = asRendererSees(failure);
    expect(rendererError.code).toBe("github_unavailable");
    expect(rendererError.message).toMatch(/Try again/);
    expect((failure.cause as GithubAppClientError).code).toBe("http_404");
  });

  it("still reports a genuine outage as retryable", async () => {
    const failure = (await controllerAgainst({
      status: 503,
      body: { error: { code: "github_unavailable", message: "upstream" } },
    })
      .begin({ scheme: "zeros-dev", installFlow: true })
      .catch((error: unknown) => error)) as GithubAppFlowError;

    const rendererError = asRendererSees(failure);

    expect(rendererError.code).toBe("github_unavailable");
    expect(rendererError.message).toMatch(/Try again/);
  });

  it("keeps a GitError's remediation and code across the IPC boundary", () => {
    // What withNativeErrors does for verifyGithubToken's failures.
    const rendererError = asRendererSees(
      new NativeCommandError(
        "GitHub rejected this token. Connect GitHub in Settings → Integrations.",
        "NOT_AUTHENTICATED",
      ),
    );

    expect(rendererError.code).toBe("NOT_AUTHENTICATED");
    expect(rendererError.message).toMatch(/Settings → Integrations/);
  });
});
