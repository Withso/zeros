export interface CodexNativeTabIdentity {
  browserSessionId: string;
  webContentsId: number;
}

export interface CodexNativeUserTabState {
  title: string;
  touchedAt: number;
  url: string;
}

export interface CodexNativeControlState {
  disposeBrowserUseDebugger(): void;
  browserUseSocket: unknown;
  browserUseTurnId: string | null;
  codexApprovedDownloadUrl: string | null;
  actor: "agent" | "user";
  pointer: unknown;
  action: unknown;
  agentActivityUntil: number;
  workingOverlayVisible: boolean;
  userInputGeneration: number;
}

export interface CodexTurnSettlementState {
  requestedBrowserSessionId: string;
  bindingBrowserSessionId: string;
  activeTurnId: string | null;
  blockedTurnId: string | null;
  leaseActor: "agent" | "user" | null;
  leaseTurnId: string | null;
}

/** Browser metadata consumed directly by OpenAI's bundled browser-client.
 * Generic IAB backends omit claiming/finalization from their public facade;
 * Zeros implements both, so advertise the exact API member overrides. */
export function codexBrowserIabInfo(nativeSessionId: string) {
  return {
    type: "iab" as const,
    name: "Zeros Browser",
    family: "chrome",
    capabilities: { browser: [], tab: [] },
    apiSupportOverrides: {
      "BrowserUser.claimTab": true,
      "Tab.markDeliverable": true,
      "Tab.markHandoff": true,
      "Tabs.finalize": true,
    },
    metadata: {
      codexSessionId: nativeSessionId,
      codexAppBuildFlavor: "prod",
      host: "zeros",
    },
  };
}

export function codexFinalizeKeepsTab(
  params: Record<string, unknown>,
  identity: CodexNativeTabIdentity,
): boolean {
  // Older clients can end a turn without a keep field. Preserve the exact page
  // for a safe user handoff rather than destroying potentially useful work.
  if (!("keep" in params)) return true;
  if (!Array.isArray(params.keep)) return false;
  return params.keep.some((entry) => codexNativeTabMatches(entry, identity));
}

export type CodexTabDisposition = "deliverable" | "handoff" | null;

/** The official API supports both markDeliverable/markHandoff and an explicit
 * finalize keep list. Either retention signal keeps the same claimed tab. */
export function codexFinalizeDisposition(
  params: Record<string, unknown>,
  identity: CodexNativeTabIdentity,
  marked: CodexTabDisposition,
): "keep" | "close" {
  return marked || codexFinalizeKeepsTab(params, identity) ? "keep" : "close";
}

export function codexNativeTabMatches(
  value: unknown,
  identity: CodexNativeTabIdentity,
): boolean {
  if (typeof value === "string" || typeof value === "number") {
    return (
      String(value) === String(identity.webContentsId) ||
      String(value) === identity.browserSessionId
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  for (const key of [
    "tabId",
    "tab_id",
    "id",
    "providerTabId",
    "provider_tab_id",
  ]) {
    if (codexNativeTabMatches(candidate[key], identity)) return true;
  }
  return (
    candidate.tab !== value && codexNativeTabMatches(candidate.tab, identity)
  );
}

/** The current official IAB command handler coerces a claimed user-tab id to
 * a positive integer before it reaches `claimUserTab`. Keep the public value a
 * string (as the Browser API declares), but derive it from the live native tab
 * rather than the durable conversation token. The host still authenticates
 * the Codex session and matches this id against that conversation's lease. */
export function codexNativeUserTab(
  identity: CodexNativeTabIdentity,
  state: CodexNativeUserTabState,
) {
  const nativeId = String(identity.webContentsId);
  return {
    id: nativeId,
    providerTabId: nativeId,
    url: state.url,
    title: state.title,
    lastOpened: new Date(state.touchedAt).toISOString(),
  };
}

export function codexUserTabClaimMatches(
  value: unknown,
  identity: CodexNativeTabIdentity,
): boolean {
  return (
    (typeof value === "string" || typeof value === "number") &&
    String(value) === String(identity.webContentsId)
  );
}

export function consumeCodexDownloadAuthorization(
  authorizedUrl: string | null,
  candidateUrl: string,
): { authorized: boolean; remaining: string | null } {
  if (authorizedUrl !== null && authorizedUrl === candidateUrl) {
    return { authorized: true, remaining: null };
  }
  return { authorized: false, remaining: authorizedUrl };
}

/** `navigate_tab_url` is origin-checked and elicited by OpenAI's Browser
 * plugin before its IAB implementation emits `Page.navigate`. This exact
 * origin remains useful for command diagnostics; while the official turn owns
 * the tab, Electron defers all top-level origin prompts to that provider gate
 * so redirect/click navigation cannot produce a second Zeros card. */
export function codexNativePreapprovedNavigationOrigin(
  method: string,
  commandParams: Record<string, unknown>,
): string | null {
  if (method !== "Page.navigate") return null;
  const rawUrl = commandParams.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** Release every host-side ownership handle while preserving the exact
 * WebContents. Both native finalize and the user-facing Stop button use this
 * transition so a retained page cannot look interactive while a debugger,
 * socket, or stale download grant still belongs to the previous Codex turn. */
export function releaseCodexNativeControl(
  state: CodexNativeControlState,
): void {
  state.disposeBrowserUseDebugger();
  state.browserUseSocket = null;
  state.browserUseTurnId = null;
  state.codexApprovedDownloadUrl = null;
  state.actor = "user";
  state.pointer = null;
  state.action = null;
  state.agentActivityUntil = 0;
  state.workingOverlayVisible = false;
  state.userInputGeneration += 1;
}

/** Decide the app-server terminal-turn fallback without weakening native
 * ownership. A replacement thread cannot settle an older binding, and a
 * stopped turn remains blocked so a late request from that same turn cannot
 * reclaim the page after handoff. */
export function codexTurnSettlementDisposition(
  state: CodexTurnSettlementState,
): {
  settled: boolean;
  handoff: boolean;
  activeTurnId: string | null;
  blockedTurnId: string | null;
} {
  if (state.requestedBrowserSessionId !== state.bindingBrowserSessionId) {
    return {
      settled: false,
      handoff: false,
      activeTurnId: state.activeTurnId,
      blockedTurnId: state.blockedTurnId,
    };
  }
  return {
    settled: true,
    handoff:
      state.leaseActor === "agent" &&
      state.activeTurnId !== null &&
      state.leaseTurnId === state.activeTurnId,
    activeTurnId: null,
    // Cleared lazily only when a different native turn arrives. This keeps a
    // cancelled or just-completed turn's straggling MCP request from taking
    // control back after the app-server has declared it terminal.
    blockedTurnId: state.blockedTurnId ?? state.activeTurnId,
  };
}

/** The official browser-client detects optional wire methods by comparing this
 * exact failure string, then transparently falls back to executeCdp. */
export function unsupportedCodexBrowserMethodMessage(method: string): string {
  return `No handler registered for method: ${method}`;
}
