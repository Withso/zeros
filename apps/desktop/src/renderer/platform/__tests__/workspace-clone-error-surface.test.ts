import { describe, expect, it, vi } from "vitest";

import { NativeCommandError } from "@zeros/protocol/native-error";
import { GitError } from "../../../engine/git/errors";
import { classifyGitTransportError } from "../../../engine/git/git-exec";
import { cloneRepo } from "../../../engine/git";
import { workspaceClone } from "../../../../electron/ipc/commands/git";
import { normalizeNativeInvokeError } from "../runtime";
import { cloneErrorGuidance } from "../../shell/dialogs/clone-error-guidance";

vi.mock("../../../engine/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../engine/git")>();
  return { ...actual, cloneRepo: vi.fn() };
});

const cloneRepoMock = vi.mocked(cloneRepo);
const syntheticUrl =
  "https://fake-user-sentinel:fake-password-sentinel@auth-marker.invalid/repository?marker=private";
const sensitiveMarkers = [
  "fake-user-sentinel",
  "fake-password-sentinel",
  "auth-marker.invalid",
  "marker=private",
  "stderr-marker",
  "remediation-marker",
  "git clone",
];
const commandContext = {} as Parameters<typeof workspaceClone>[1];

function asElectronRejection(error: Error): Error {
  return new Error(`Error invoking remote method 'zeros:invoke': ${error}`);
}

function errorDetails(error: Error): string {
  const cause = error.cause;
  const causeDetails =
    cause instanceof Error
      ? errorDetails(cause)
      : cause === undefined
        ? ""
        : String(cause);
  return [error.name, error.message, error.stack, causeDetails].join(" ");
}

async function cloneErrorRoundTrip(stderr: string) {
  const code = classifyGitTransportError(stderr);
  if (!code) throw new Error("Expected a classified transport error");
  const failure = new GitError({
    code,
    message: `git clone ${syntheticUrl} failed`,
    cause: new Error("stderr-marker"),
    remediation: "remediation-marker",
    context: { url: syntheticUrl },
  });
  cloneRepoMock.mockRejectedValueOnce(failure);

  let mainError: unknown;
  try {
    await workspaceClone(
      { url: syntheticUrl, parentFolder: "/tmp/clone-error" },
      commandContext,
    );
  } catch (error) {
    mainError = error;
  }
  if (!(mainError instanceof Error)) throw new Error("Expected a native Error");
  const rendererError = normalizeNativeInvokeError(
    asElectronRejection(mainError),
    "workspace_clone",
  );
  return { code, mainError, rendererError };
}

describe("workspace clone error IPC surface", () => {
  it.each([401, 403])(
    "retains only safe authentication classification for HTTP %s",
    async (status) => {
      const result = await cloneErrorRoundTrip(
        `fatal: requested URL returned error: ${status}`,
      );

      expect(result.mainError).toBeInstanceOf(NativeCommandError);
      expect(result.mainError).not.toHaveProperty("cause");
      expect(result.mainError).not.toHaveProperty("remediation");
      expect(result.mainError).not.toHaveProperty("context");
      expect(result.code).toBe("NOT_AUTHENTICATED");
      expect(result.rendererError.code).toBe("NOT_AUTHENTICATED");
      expect(result.rendererError.message).toBe(
        "The repository host rejected the request.",
      );
      const guidance = cloneErrorGuidance(result.rendererError, "local");
      expect(guidance).toBe(
        "Check credentials for the repository host and confirm the account can access the repository, then try again.",
      );
      expect(cloneErrorGuidance(result.rendererError, "cloud")).toBeNull();
      const surfaced = [
        errorDetails(result.mainError),
        errorDetails(result.rendererError),
        result.rendererError.rawMessage,
        guidance,
      ].join(" ");
      for (const marker of sensitiveMarkers) {
        expect(surfaced).not.toContain(marker);
      }
    },
  );

  it("retains only safe network classification for a refused connection", async () => {
    const result = await cloneErrorRoundTrip("Failed to connect: Connection refused");

    expect(result.mainError).toBeInstanceOf(NativeCommandError);
    expect(result.code).toBe("NETWORK_ERROR");
    expect(result.rendererError.code).toBe("NETWORK_ERROR");
    expect(result.rendererError.message).toBe(
      "The repository host could not be reached.",
    );
    const guidance = cloneErrorGuidance(result.rendererError, "local");
    expect(guidance).toBe(
      "Couldn't reach the repository host. Check your connection, then try again.",
    );
    const surfaced = [
      errorDetails(result.mainError),
      errorDetails(result.rendererError),
      result.rendererError.rawMessage,
      guidance,
    ].join(" ");
    for (const marker of sensitiveMarkers) {
      expect(surfaced).not.toContain(marker);
    }
  });

  it("preserves the generic fallback for unknown GitError codes", async () => {
    const failure = new GitError({
      code: "GIT_COMMAND_FAILED",
      message: "Could not clone repository.",
    });
    cloneRepoMock.mockRejectedValueOnce(failure);

    let mainError: unknown;
    try {
      await workspaceClone(
        { url: syntheticUrl, parentFolder: "/tmp/clone-error" },
        commandContext,
      );
    } catch (error) {
      mainError = error;
    }
    expect(mainError).toBe(failure);
    const rendererError = normalizeNativeInvokeError(
      asElectronRejection(failure),
      "workspace_clone",
    );
    expect(rendererError.code).toBeUndefined();
    expect(rendererError.message).toBe("Could not clone repository.");
    expect(cloneErrorGuidance(rendererError, "local")).toBeNull();
  });
});
