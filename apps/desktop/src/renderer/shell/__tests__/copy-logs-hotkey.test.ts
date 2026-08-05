import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  copyRecentLogsToClipboard,
  isStaleProcessError,
  matchesCopyLogsHotkey,
} from "../use-copy-logs-hotkey";

// Mocks for the stateful copyRecentLogsToClipboard tests. Stubbing the settings
// module keeps the auth import chain out of the test; the pure-matcher tests
// below don't touch any of these.
const mocks = vi.hoisted(() => ({
  nativeInvoke: vi.fn(),
  copyToClipboardWithFallback: vi.fn(),
  useInternalFeatureActive: vi.fn(() => false),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("../../platform/runtime", () => ({ nativeInvoke: mocks.nativeInvoke }));
vi.mock("../../features/settings/internal-features", () => ({
  useInternalFeatureActive: mocks.useInternalFeatureActive,
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: mocks.toast }));
vi.mock("../../shared/lib/clipboard", () => ({
  copyToClipboardWithFallback: mocks.copyToClipboardWithFallback,
}));

function key(
  overrides: Partial<
    Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">
  > = {},
) {
  return {
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
    code: "KeyL",
    ...overrides,
  };
}

describe("matchesCopyLogsHotkey", () => {
  it("matches Command+Shift+L and Control+Shift+L", () => {
    expect(matchesCopyLogsHotkey(key())).toBe(true);
    expect(matchesCopyLogsHotkey(key({ metaKey: false, ctrlKey: true }))).toBe(
      true,
    );
  });

  it("rejects plain Cmd+L (the browser-tab element-picker chord)", () => {
    expect(matchesCopyLogsHotkey(key({ shiftKey: false }))).toBe(false);
  });

  it("rejects Option/Alt so it never collides with ⌥⌘ chords", () => {
    expect(matchesCopyLogsHotkey(key({ altKey: true }))).toBe(false);
  });

  it("rejects a bare Shift+L and non-L keys", () => {
    expect(matchesCopyLogsHotkey(key({ metaKey: false, ctrlKey: false }))).toBe(
      false,
    );
    expect(matchesCopyLogsHotkey(key({ code: "KeyK" }))).toBe(false);
  });
});

describe("isStaleProcessError", () => {
  it("flags a stale main (unknown command) and stale preload (not permitted)", () => {
    // The exact string the IPC router throws for a missing handler.
    expect(
      isStaleProcessError(
        new Error(
          '[Zeros] IPC: unknown command "logs_recent". Expected one of 65 registered commands.',
        ),
      ),
    ).toBe(true);
    // The preload allowlist rejection (stale preload.cjs).
    expect(
      isStaleProcessError(
        new Error('[Zeros] command not permitted: "logs_recent"'),
      ),
    ).toBe(true);
    // Electron wraps the message; the substring must still match.
    expect(
      isStaleProcessError(
        new Error(
          "Error invoking remote method 'zeros:invoke': Error: [Zeros] IPC: unknown command \"logs_recent\".",
        ),
      ),
    ).toBe(true);
  });

  it("does NOT flag unrelated failures (clipboard, generic, non-Error)", () => {
    expect(isStaleProcessError(new Error("Document is not focused"))).toBe(
      false,
    );
    expect(isStaleProcessError(new Error("boom"))).toBe(false);
    expect(isStaleProcessError("some string")).toBe(false);
    expect(isStaleProcessError(null)).toBe(false);
    expect(isStaleProcessError(undefined)).toBe(false);
  });
});

describe("copyRecentLogsToClipboard", () => {
  beforeEach(() => {
    mocks.nativeInvoke.mockReset();
    mocks.copyToClipboardWithFallback.mockReset();
    mocks.toast.success.mockReset();
    mocks.toast.error.mockReset();
    mocks.toast.info.mockReset();
    mocks.copyToClipboardWithFallback.mockResolvedValue(true);
  });

  it("copies the fetched tail and toasts the size", async () => {
    const text = "x".repeat(2048);
    mocks.nativeInvoke.mockResolvedValue({ text });
    await copyRecentLogsToClipboard();
    expect(mocks.nativeInvoke).toHaveBeenCalledWith("logs_recent");
    expect(mocks.copyToClipboardWithFallback).toHaveBeenCalledWith(text);
    expect(mocks.toast.success).toHaveBeenCalledWith("App logs copied — 2 KB.");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("routes an empty store to an info toast, not an error", async () => {
    mocks.nativeInvoke.mockResolvedValue({ text: "" });
    await copyRecentLogsToClipboard();
    expect(mocks.copyToClipboardWithFallback).not.toHaveBeenCalled();
    expect(mocks.toast.info).toHaveBeenCalledWith("No app logs to copy yet.");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it("tells the dev to restart when the main process is stale", async () => {
    mocks.nativeInvoke.mockRejectedValue(
      new Error('[Zeros] IPC: unknown command "logs_recent".'),
    );
    await copyRecentLogsToClipboard();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Copy logs: the app's main process is out of date — restart the dev instance.",
    );
    expect(mocks.copyToClipboardWithFallback).not.toHaveBeenCalled();
  });

  it("distinguishes a generic read failure from a stale main", async () => {
    mocks.nativeInvoke.mockRejectedValue(new Error("disk exploded"));
    await copyRecentLogsToClipboard();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Couldn't read the app logs.",
    );
  });

  it("reports a clipboard write that didn't land", async () => {
    mocks.nativeInvoke.mockResolvedValue({ text: "abc" });
    mocks.copyToClipboardWithFallback.mockResolvedValue(false);
    await copyRecentLogsToClipboard();
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Couldn't write to the clipboard — focus the app and retry.",
    );
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("dedupes concurrent presses via the in-flight guard", async () => {
    let resolve!: (v: { text: string }) => void;
    mocks.nativeInvoke.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p1 = copyRecentLogsToClipboard();
    const p2 = copyRecentLogsToClipboard(); // guarded no-op while p1 in flight
    resolve({ text: "abc" });
    await Promise.all([p1, p2]);
    expect(mocks.nativeInvoke).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });
});
