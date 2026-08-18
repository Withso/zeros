import { describe, expect, it } from "vitest";

import {
  codexBrowserIabInfo,
  codexFinalizeDisposition,
  codexFinalizeKeepsTab,
  consumeCodexDownloadAuthorization,
  codexNativePreapprovedNavigationOrigin,
  releaseCodexNativeControl,
  codexNativeTabMatches,
  codexTurnSettlementDisposition,
  codexNativeUserTab,
  codexUserTabClaimMatches,
  unsupportedCodexBrowserMethodMessage,
} from "../browser/codex-native-contract";

const identity = {
  browserSessionId: "browser_conversation",
  webContentsId: 42,
};

describe("native Codex Browser IAB contract", () => {
  it("advertises the current IAB claim and handoff APIs", () => {
    expect(codexBrowserIabInfo("codex-thread-1")).toMatchObject({
      type: "iab",
      apiSupportOverrides: {
        "BrowserUser.claimTab": true,
        "Tab.markDeliverable": true,
        "Tab.markHandoff": true,
        "Tabs.finalize": true,
      },
      metadata: {
        codexSessionId: "codex-thread-1",
        codexAppBuildFlavor: "prod",
      },
    });
  });

  it("accepts fresh opaque and provider tab identities but rejects another tab", () => {
    expect(codexNativeTabMatches("browser_conversation", identity)).toBe(true);
    expect(codexNativeTabMatches("42", identity)).toBe(true);
    expect(
      codexNativeTabMatches(
        { tab: { id: "browser_conversation", providerTabId: "42" } },
        identity,
      ),
    ).toBe(true);
    expect(codexNativeTabMatches("43", identity)).toBe(false);
    expect(codexNativeTabMatches({ tabId: "browser_other" }, identity)).toBe(
      false,
    );
  });

  it("uses the current positive WebContents id for the official IAB claim flow", () => {
    expect(
      codexNativeUserTab(identity, {
        title: "Example",
        url: "https://example.com/",
        touchedAt: Date.parse("2024-08-11T00:00:00.000Z"),
      }),
    ).toEqual({
      id: "42",
      providerTabId: "42",
      title: "Example",
      url: "https://example.com/",
      lastOpened: "2024-08-11T00:00:00.000Z",
    });
    expect(codexUserTabClaimMatches("42", identity)).toBe(true);
    expect(codexUserTabClaimMatches(42, identity)).toBe(true);
    expect(codexUserTabClaimMatches("browser_conversation", identity)).toBe(
      false,
    );
  });

  it("retains only an explicitly kept tab and conservatively hands off on missing keep", () => {
    expect(codexFinalizeKeepsTab({}, identity)).toBe(true);
    expect(codexFinalizeKeepsTab({ keep: [] }, identity)).toBe(false);
    expect(
      codexFinalizeKeepsTab(
        {
          keep: [
            {
              tab: { id: "browser_conversation" },
              status: "deliverable",
            },
          ],
        },
        identity,
      ),
    ).toBe(true);
  });

  it("honors official markDeliverable and markHandoff state during finalization", () => {
    expect(codexFinalizeDisposition({}, identity, "deliverable")).toBe("keep");
    expect(codexFinalizeDisposition({ keep: [] }, identity, "handoff")).toBe(
      "keep",
    );
    expect(codexFinalizeDisposition({ keep: [] }, identity, null)).toBe(
      "close",
    );
    expect(
      codexFinalizeDisposition(
        { keep: [{ tabId: 42, status: "deliverable" }] },
        identity,
        null,
      ),
    ).toBe("keep");
  });

  it("uses the official fallback error for optional newer wire methods", () => {
    expect(
      unsupportedCodexBrowserMethodMessage("executeCdpWithCachedExpression"),
    ).toBe("No handler registered for method: executeCdpWithCachedExpression");
  });

  it("consumes only the exact native download URL once", () => {
    expect(
      consumeCodexDownloadAuthorization(
        "https://example.com/report.csv?year=2026",
        "https://example.com/report.csv?year=2026",
      ),
    ).toEqual({ authorized: true, remaining: null });
    expect(
      consumeCodexDownloadAuthorization(
        "https://example.com/report.csv?year=2026",
        "https://example.com/other.csv",
      ),
    ).toEqual({
      authorized: false,
      remaining: "https://example.com/report.csv?year=2026",
    });
  });

  it("preapproves only the destination already approved by native Codex navigation", () => {
    expect(
      codexNativePreapprovedNavigationOrigin("Page.navigate", {
        url: "https://example.com/account?from=codex#section",
      }),
    ).toBe("https://example.com");
    expect(
      codexNativePreapprovedNavigationOrigin("Runtime.evaluate", {
        url: "https://example.com/account",
      }),
    ).toBeNull();
    expect(
      codexNativePreapprovedNavigationOrigin("Page.navigate", {
        url: "file:///tmp/secret",
      }),
    ).toBeNull();
    expect(
      codexNativePreapprovedNavigationOrigin("Page.navigate", {
        url: "not a URL",
      }),
    ).toBeNull();
  });

  it("fully releases native control on both Stop and final handoff", () => {
    let detached = 0;
    const state = {
      disposeBrowserUseDebugger: () => {
        detached += 1;
      },
      browserUseSocket: { connected: true } as unknown,
      browserUseTurnId: "turn-1" as string | null,
      codexApprovedDownloadUrl: "https://example.com/report.csv" as
        | string
        | null,
      actor: "agent" as "agent" | "user",
      pointer: { x: 1 },
      action: { label: "Clicking" },
      agentActivityUntil: 123,
      workingOverlayVisible: true,
      userInputGeneration: 4,
    };

    releaseCodexNativeControl(state);

    expect(detached).toBe(1);
    expect(state).toMatchObject({
      browserUseSocket: null,
      browserUseTurnId: null,
      codexApprovedDownloadUrl: null,
      actor: "user",
      pointer: null,
      action: null,
      agentActivityUntil: 0,
      workingOverlayVisible: false,
      userInputGeneration: 5,
    });
  });

  it("settles only the registered native owner and preserves a stopped-turn block", () => {
    expect(
      codexTurnSettlementDisposition({
        requestedBrowserSessionId: "browser_conversation",
        bindingBrowserSessionId: "browser_conversation",
        activeTurnId: "turn-1",
        blockedTurnId: "turn-1",
        leaseActor: "agent",
        leaseTurnId: "turn-1",
      }),
    ).toEqual({
      settled: true,
      handoff: true,
      activeTurnId: null,
      blockedTurnId: "turn-1",
    });
    expect(
      codexTurnSettlementDisposition({
        requestedBrowserSessionId: "browser_conversation",
        bindingBrowserSessionId: "browser_conversation",
        activeTurnId: null,
        blockedTurnId: null,
        leaseActor: "user",
        leaseTurnId: null,
      }),
    ).toEqual({
      settled: true,
      handoff: false,
      activeTurnId: null,
      blockedTurnId: null,
    });
    expect(
      codexTurnSettlementDisposition({
        requestedBrowserSessionId: "browser_conversation",
        bindingBrowserSessionId: "browser_conversation",
        activeTurnId: "turn-completed-without-finalize",
        blockedTurnId: null,
        leaseActor: "agent",
        leaseTurnId: "turn-completed-without-finalize",
      }),
    ).toEqual({
      settled: true,
      handoff: true,
      activeTurnId: null,
      blockedTurnId: "turn-completed-without-finalize",
    });
    expect(
      codexTurnSettlementDisposition({
        requestedBrowserSessionId: "browser_other",
        bindingBrowserSessionId: "browser_conversation",
        activeTurnId: "turn-1",
        blockedTurnId: null,
        leaseActor: "agent",
        leaseTurnId: "turn-1",
      }),
    ).toEqual({
      settled: false,
      handoff: false,
      activeTurnId: "turn-1",
      blockedTurnId: null,
    });
  });
});
