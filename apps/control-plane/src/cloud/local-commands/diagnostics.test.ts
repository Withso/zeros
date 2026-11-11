import { afterEach, describe, expect, it, vi } from "vitest";
import { localCommandDiagnostic, type LocalCommandDiagnostic } from "./diagnostics.js";

describe("local-command diagnostic allowlist", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops fields and codes outside the closed vocabulary even if a caller passes a payload", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    localCommandDiagnostic({ event: "terminal", outcome: "failed", reason: "private-error-fixture", durationMs: 1200,
      workspaceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", requestId: "private-request-fixture",
      chatId: "private-chat-fixture", command: "private-command-fixture", stdout: "private-output-fixture",
      deviceName: "private-device-fixture", cwd: "/private/fixture", token: "private-token-fixture",
    } as LocalCommandDiagnostic);
    expect(log).toHaveBeenCalledExactlyOnceWith('[local-commands] terminal {"workspaceId":"aaaaaaaa","outcome":"failed","durationMs":1200}');
  });

  it("refuses event names and channel-close reasons taken from arbitrary error text", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    localCommandDiagnostic({ event: "private-event-fixture" } as unknown as LocalCommandDiagnostic);
    expect(log).not.toHaveBeenCalled();
    localCommandDiagnostic({ event: "channel_closed", reason: "revoked:private-code-fixture", secondsOpen: 2.25 } as unknown as LocalCommandDiagnostic);
    expect(log).toHaveBeenCalledExactlyOnceWith('[local-commands] channel_closed {"secondsOpen":2.25}');
  });
});
