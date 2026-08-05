// Electron's IPC wrapper must never reach a toast.
//
// `ipcRenderer.invoke` rejects with a NEW Error whose message is
// `Error invoking remote method '<channel>': <name>: <message>`, and only
// `name`/`message`/`stack` survive the main→renderer hop. The regression this
// guards: Settings rendered that whole string as a toast description
// ("Error invoking remote method 'zeros:invoke': GithubAppClientError: Not
// found"), and every renderer branch on `error.code` was unreachable.

import { describe, expect, it } from "vitest";

import { NativeCommandError } from "@zeros/protocol/native-error";
import { normalizeNativeInvokeError } from "../runtime";

/** Reproduce what Electron hands the renderer for a rejected handler. */
function asElectronRejection(error: Error): Error {
  return new Error(`Error invoking remote method 'zeros:invoke': ${error}`);
}

describe("nativeInvoke error normalization", () => {
  it("strips the transport wrapper and the error-class prefix", () => {
    const normalized = normalizeNativeInvokeError(
      asElectronRejection(new Error("Add a personal access token first")),
      "gh_method_select",
    );

    expect(normalized.message).toBe("Add a personal access token first");
    expect(normalized.code).toBeUndefined();
  });

  it("recovers the code main tagged onto a NativeCommandError", () => {
    const normalized = normalizeNativeInvokeError(
      asElectronRejection(
        new NativeCommandError(
          "GitHub App sign-in isn’t available on this Zeros control plane yet.",
          "not_configured",
        ),
      ),
      "gh_app_connect",
    );

    expect(normalized.code).toBe("not_configured");
    expect(normalized.message).toBe(
      "GitHub App sign-in isn’t available on this Zeros control plane yet.",
    );
  });

  it("does not leak a control-plane class name for an uncoded throw", () => {
    class GithubAppClientError extends Error {
      constructor(message: string) {
        super(message);
        this.name = "GithubAppClientError";
      }
    }

    const normalized = normalizeNativeInvokeError(
      asElectronRejection(new GithubAppClientError("Not found")),
      "gh_app_connect",
    );

    expect(normalized.message).toBe("Not found");
    expect(normalized.message).not.toContain("invoking remote method");
    expect(normalized.message).not.toContain("GithubAppClientError");
  });

  it("keeps the raw message reachable for logs and preserves the cause", () => {
    const original = asElectronRejection(new Error("boom"));
    const normalized = normalizeNativeInvokeError(original, "keychain_get");

    expect(normalized.rawMessage).toBe(original.message);
    expect(normalized.cause).toBe(original);
  });

  it("passes an already-clean message through unchanged", () => {
    const normalized = normalizeNativeInvokeError(
      new Error('[Zeros] command not permitted: "nope"'),
      "nope",
    );

    expect(normalized.message).toBe('[Zeros] command not permitted: "nope"');
  });

  it("survives a non-Error rejection", () => {
    const normalized = normalizeNativeInvokeError("plain string", "app_info");

    expect(normalized.message).toBe("plain string");
    expect(normalized.code).toBeUndefined();
  });

  it("refuses a code that is not a stable lower_snake_case identifier", () => {
    expect(() => new NativeCommandError("nope", "Not Found")).toThrow(
      /Invalid NativeCommandError code/,
    );
  });
});
