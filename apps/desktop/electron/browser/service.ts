import {
  BaseWindow,
  nativeImage,
  session,
  WebContentsView,
  type DownloadItem,
  type Session,
  type WebContents,
} from "electron";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { browserError, browserErrorMessage } from "./errors";
import { realpath, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  BROWSER_SERVICE_VERSION,
  agentControlName,
  browserControlDetail,
  isAgentControlFamily,
  isBrowserElementRef,
  isBrowserProductId,
  isBrowserToolName,
  type AgentControlFamily,
  type BrowserAppearance,
  type BrowserConfirmationDecision,
  type BrowserConfirmationRequest,
  type BrowserAgentPointer,
  type BrowserJsonValue,
  type BrowserRiskCategory,
  type BrowserSessionAcquireRequest,
  type BrowserSessionAcquireResponse,
  type BrowserSessionOwner,
  type BrowserSessionReleaseRequest,
  type BrowserSessionReleaseResponse,
  type BrowserSessionState,
  type BrowserSessionStopResponse,
  type BrowserToolInvokeRequest,
  type BrowserToolName,
  type BrowserToolResult,
} from "@zeros/protocol/browser-tools";

import type { AgentControlPresenter } from "../agent-control/overlay";
import { rendererProcessOwners } from "../renderer-process-owners";
import { parseBrowserAnnotations, type BrowserAnnotation } from "./annotations";
import {
  createBrowserAppearanceController,
  type BrowserAppearanceController,
} from "./appearance";
import {
  persistBrowserScreenshot,
  persistBrowserTrace,
  type BrowserTraceEvent,
} from "./artifacts";
import {
  BrowserConfirmationBroker,
  classifyBrowserClick,
  classifyBrowserInput,
  classifyBrowserKey,
  type BrowserKeyTarget,
} from "./confirmations";
import {
  allocateBrowserDownload,
  clearStagedBrowserUploads,
  discardStagedBrowserUpload,
  pruneBrowserDownloads,
  stageBrowserUpload,
  type StagedBrowserUpload,
} from "./files";
import {
  browserAgentActionStillOwnsPage,
  cancelBrowserTitleCandidate,
  browserAgentWorkingOverlayScript as agentWorkingOverlayScript,
  browserAgentPointerOverlayScript as agentPointerOverlayScript,
  browserAgentNavigationDisposition,
  browserActionLabel,
  browserControlBarDisposition,
  browserInputStopsAgent,
  browserSurfaceIsPictureInPicture,
  commitBrowserTitleCandidate,
  browserElementActionLabel,
  browserFaviconNavigationDisposition,
  browserFaviconFallbackNeeded,
  browserDomMarkers,
  browserInputDisposition,
  browserInputTargetStillMatches,
  browserNavigationPublishStatus,
  browserOperationNeedsReadySettlement,
  browserPolicySnapshotIsCurrent,
  browserSessionShouldRemainAlive,
  browserSurfaceShouldBeVisible,
  captureBrowserSurface,
  browserSurfaceHoverAfterAttach,
  browserSurfaceDetachAllowed,
  browserViewportAfterExplicitResize,
  browserViewportPresentation,
  browserServiceInvocationBlockedReason,
  createSharedBrowserWaiter,
  dispatchBrowserUserNavigation,
  fetchBrowserFaviconDataUrl,
  normalizeBrowserViewBounds,
  normalizedBrowserFaviconMime,
  orderedBrowserFaviconCandidates,
  normalizeCodexPageNavigateResult,
  parseBrowserKeyChord,
  queueBrowserTitleCandidate,
  safeBrowserSvgFavicon,
  usableBrowserDocument,
  type BrowserViewBounds,
} from "./surface";
import {
  startCodexBrowserUsePipe,
  type CodexBrowserUsePipeHandle,
  type CodexBrowserUseRequest,
} from "../codex-browser-use-pipe";
import {
  codexBrowserIabInfo,
  codexFinalizeDisposition,
  type CodexTabDisposition,
  codexNativePreapprovedNavigationOrigin,
  codexNativeTabMatches,
  codexNativeUserTab,
  codexTurnSettlementDisposition,
  codexUserTabClaimMatches,
  consumeCodexDownloadAuthorization,
  releaseCodexNativeControl,
  unsupportedCodexBrowserMethodMessage,
} from "./codex-native-contract";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_SESSIONS = 8;
const IDLE_SESSION_MS = 20 * 60_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const USEFUL_DOCUMENT_TIMEOUT_MS = 3_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const AGENT_ACTIVITY_LINGER_MS = 1_800;
const AGENT_INPUT_READY_TIMEOUT_MS = 1_500;
const PAGE_FRAME_TIMEOUT_MS = 1_000;
// Electron runs context isolation in world 999 and reserves 1 << 20 upward
// for extensions.
const AGENT_PAGE_WORLD_ID = 1_000;
const BROWSER_TITLE_SETTLE_MS = 300;
const MAX_FAVICON_BYTES = 192 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_STAGED_UPLOADS = 10;
const MAX_CODEX_BROWSER_BINDINGS = 64;
const BROWSER_USE_BOOTSTRAP_TIMEOUT_MS = 10_000;
const BROWSER_USE_CDP_TIMEOUT_MS = 30_000;
const BROWSER_USE_CDP_MAX_TIMEOUT_MS = 120_000;
const MIN_VIEWPORT = { width: 320, height: 320 };
const MAX_VIEWPORT = { width: 2_560, height: 1_800 };

interface BrowserDownloadArtifact {
  kind: "browser-download";
  path: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  downloadedAt: number;
}

interface BrowserLease {
  view: WebContentsView;
  parkingWindow: BaseWindow;
  /** The same native view moves between its hidden parking host and the
   * trusted workbench rectangle. It is never mirrored into an iframe. */
  attachedTo: BaseWindow;
  browserSession: Session;
  viewport: { width: number; height: number };
  /** Full-page aspect retained while PiP temporarily owns the native view. */
  sourceViewport: { width: number; height: number };
  /** Last explicit document title. Retained across did-navigate so Chromium's
   * transient hostname fallback never leaks into the tab strip. */
  displayTitle: string;
  pendingDisplayTitle: string | null;
  displayTitleGeneration: number;
  displayTitleTimer: ReturnType<typeof setTimeout> | null;
  actor: "agent" | "user";
  pointer: BrowserAgentPointer | null;
  faviconDataUrl: string | null;
  /** Origin associated with faviconDataUrl, so a prior site's icon never
   * flashes beside a cross-origin destination. */
  faviconOrigin: string | null;
  faviconGeneration: number;
  faviconResolvingGeneration: number | null;
  actionSequence: number;
  action: BrowserSessionState["action"] | null;
  agentActivityUntil: number;
  navigationApproval: "always-ask" | "always-allow";
  /** One action-scoped origin that already passed the website gate. */
  preapprovedNavigationOrigin: string | null;
  /** Deduplicates repeated will-navigate events while the inline card waits. */
  guardedNavigationUrl: string | null;
  /** Monotonic count lets a top-level tool distinguish an expected aborted
   * load (the host intercepted a redirect) from an ordinary navigation error. */
  guardedNavigationSequence: number;
  pendingUrl: string | null;
  status: BrowserSessionState["status"];
  currentTool: BrowserSessionState["tool"] | undefined;
  confirmationDepth: number;
  userInputGeneration: number;
  /** Synchronous native input dispatch must pass the same lock that rejects
   * real user input while the agent owns the page. */
  agentInputDepth: number;
  /** Random host namespaces prevent untrusted page markup from pre-seeding a
   * fixed ref or overlay marker. The ref attribute rotates on every snapshot. */
  refAttribute: string;
  pointerOverlayId: string;
  annotationOverlayId: string;
  workingOverlayId: string;
  workingOverlayVisible: boolean;
  /** Native guest hover cannot bubble into the renderer DOM. Publish it so
   * PiP chrome can reveal while the pointer is anywhere over the live page. */
  surfaceHovered: boolean;
  surfaceId: string | null;
  consoleErrors: string[];
  networkErrors: string[];
  downloads: BrowserDownloadArtifact[];
  activeDownloads: Set<DownloadItem>;
  stagedUploads: StagedBrowserUpload[];
  /** One exact URL already approved by the official Browser plugin's MCP
   * elicitation. Consumed by the next matching Electron download only. */
  codexApprovedDownloadUrl: string | null;
  /** Retention explicitly requested through Tab.markDeliverable/Handoff for
   * the current native turn. */
  codexTabDisposition: CodexTabDisposition;
  pendingHostActions: Set<Promise<void>>;
  /** A host action can settle before the caller reaches its bounded wait.
   * Retain failures explicitly instead of losing them when the promise leaves
   * the pending set. Only actions started during an invocation are recorded. */
  hostActionFailures: unknown[];
  trace: BrowserTraceEvent[];
  disposeNetworkHandlers: () => void;
  disposePermissionHandlers: () => void;
  disposeDownloadHandler: () => void;
  /** Native Codex Browser plugin state. Kept on the same lease so the exact
   * WebContents becomes a normal user-controlled browser tab after finalize. */
  browserUseReady: Promise<void> | null;
  browserUseSocket: CodexBrowserUseRequest["socket"] | null;
  browserUseTurnId: string | null;
  disposeBrowserUseDebugger: () => void;
  appearance: BrowserAppearanceController;
}

interface BrowserSessionRecord {
  id: string;
  owner: BrowserSessionOwner;
  ownerKey: string;
  canonicalWorkspaceRoot: string;
  touchedAt: number;
  expires: NodeJS.Timeout;
  lease: BrowserLease | null;
  /** Serialize actions from reconnecting/provider-switched executions that
   * share this conversation-owned browser session. */
  operationTail: Promise<void>;
  activeOperations: number;
  /** Stop invalidates both the current action and calls queued behind it. */
  interruptionGeneration: number;
  /** The Browser tab's page color scheme, kept here so a page reopened after
   * a close gets it too. `null` follows the Zeros appearance. */
  appearance: BrowserAppearance | null;
  /** The agent that last drove the page, named on its control bar. */
  agent: AgentControlFamily | null;
}

interface CodexBrowserBinding {
  browserSessionId: string;
  touchedAt: number;
  activeTurnId: string | null;
  blockedTurnId: string | null;
}

export interface ZerosBrowserServiceOptions {
  artifactRoot: string;
  onSessionState?: (state: BrowserSessionState) => void;
  onConfirmationRequest?: (request: BrowserConfirmationRequest) => void;
  onConfirmationSettled?: (confirmationId: string) => void;
  /** Prevent all browser work when no trusted product surface is available. */
  isTrustedSurfaceAvailable?: () => boolean;
  /** Shows which agent controls an attached page, with Stop. */
  agentControl?: AgentControlPresenter;
  /** The staged Zeros browser is open, so pages get its control bar and Esc
   * takes them back. Open when omitted. */
  zerosBrowserAvailable?: () => boolean;
  /** The user took a page back with Esc or its control bar. The trusted
   * Browser chrome's own Stop goes through `stopBrowserAction` instead. */
  onUserStoppedAgent?: (stop: {
    browserSessionId: string;
    conversationId: string;
  }) => void;
  maxSessions?: number;
  idleSessionMs?: number;
}

export interface ZerosBrowserServiceHandle {
  baseUrl: string;
  token: string;
  /** Discovery endpoint consumed by Codex's official bundled Browser plugin. */
  codexBrowserUsePipePath: string;
  acquire(owner: BrowserSessionOwner): Promise<BrowserSessionAcquireResponse>;
  release(workspaceId: string, conversationId: string): boolean;
  invoke(request: BrowserToolInvokeRequest): Promise<BrowserToolResult>;
  attach(
    browserSessionId: string,
    target: BaseWindow,
    bounds: BrowserViewBounds,
    surfaceId: string,
  ): BrowserSessionState | null;
  /** Synchronous compositor handoff used by overlay-open IPC. The renderer
   * still follows with the ordinary async detach for acknowledgement. */
  park(browserSessionId: string, surfaceId: string): boolean;
  detach(browserSessionId: string, surfaceId: string): boolean;
  capture(browserSessionId: string): Promise<string | null>;
  /** Applies a Browser tab's page color scheme; `null` follows Zeros. */
  setAppearance(
    browserSessionId: string,
    appearance: BrowserAppearance | null,
  ): boolean;
  control(
    browserSessionId: string,
    tool: "open" | "back" | "forward" | "reload",
    args?: BrowserJsonValue,
  ): Promise<BrowserToolResult>;
  /** Destroy every live ephemeral Chromium profile without deleting durable
   * conversation ownership or explicit browser artifacts. Per-session and
   * global site-grant clearing is reached through `clearSession` on the
   * confirmation broker and `revokeConfirmationSurface` respectively. */
  clearBrowsingData(): Promise<number>;
  setUiPreferences(preferences: {
    /** Some agent may use the in-app browser. Off closes every page. */
    browserEnabled: boolean;
    /** Codex may drive pages through OpenAI's Browser plugin. Defaults on. */
    codexNativeEnabled?: boolean;
    showAgentCursor: boolean;
    navigationApproval: "always-ask" | "always-allow";
  }): void;
  /** Re-reads `zerosBrowserAvailable` for every open page's control bar. */
  refreshAgentControl(): void;
  stopBrowserAction(browserSessionId: string): boolean;
  /** Stop from the page's control bar; also reports `onUserStoppedAgent`. */
  stopFromControlBar(browserSessionId: string): boolean;
  close(browserSessionId: string): boolean;
  sessionStates(): BrowserSessionState[];
  confirmationRequests(): BrowserConfirmationRequest[];
  respondToConfirmation(
    confirmationId: string,
    decision: BrowserConfirmationDecision,
  ): boolean;
  revokeConfirmationSurface(): Promise<number>;
  stop(): Promise<void>;
}

function snapshotScript(
  refAttribute: string,
  refScope: string,
  previousRefAttribute: string,
): string {
  return String.raw`(() => {
  const refAttribute = ${JSON.stringify(refAttribute)};
  const refScope = ${JSON.stringify(refScope)};
  const previousRefAttribute = ${JSON.stringify(previousRefAttribute)};
  if (previousRefAttribute !== refAttribute) {
    for (const previous of document.querySelectorAll("[" + previousRefAttribute + "]")) previous.removeAttribute(previousRefAttribute);
  }
  let counter = 0;
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };
  const nameOf = (element) => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (label) return label;
    }
    const aria = element.getAttribute("aria-label")?.trim();
    if (aria) return aria;
    if (element.labels?.length) {
      const label = Array.from(element.labels).map((item) => item.textContent || "").join(" ").trim();
      if (label) return label;
    }
    return (element.innerText || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("name") || "").trim();
  };
  const roleOf = (element) => element.getAttribute("role") || ({
    A: "link", BUTTON: "button", INPUT: element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox",
    TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button"
  }[element.tagName] || (element.isContentEditable ? "textbox" : "interactive"));
  const selector = "a[href],button,input:not([type=hidden]),textarea,select,summary,[role],[contenteditable=true]";
  const elements = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
  let scanned = 0;
  let element;
  while ((element = walker.nextNode()) && elements.length < 300 && scanned < 20000) {
    scanned += 1;
    if (!element.matches(selector) || !visible(element)) continue;
    counter += 1;
    const ref = "b" + counter + "_" + refScope;
    element.setAttribute(refAttribute, ref);
    const type = element.getAttribute("type") || undefined;
    const value = type === "password" || type === "file" ? undefined : ("value" in element ? String(element.value).slice(0, 300) : undefined);
    elements.push({
      ref,
      role: roleOf(element),
      name: nameOf(element).replace(/\s+/g, " ").slice(0, 300),
      type,
      value,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      checked: "checked" in element ? Boolean(element.checked) : undefined,
      href: element.tagName === "A" ? element.href : undefined
    });
  }
  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 24000),
    elements
  };
})()`;
}

/** Start the Zeros-owned isolated browser runtime. The HTTP transport is an
 * internal main↔engine seam: loopback-only, per-boot bearer authenticated, and
 * keyed exclusively by Zeros workspace/conversation/browser-session ids. */
export async function startZerosBrowserService(
  options: ZerosBrowserServiceOptions,
): Promise<ZerosBrowserServiceHandle> {
  if (!isAbsolute(options.artifactRoot)) {
    throw browserError("Zeros browser artifact root must be absolute.");
  }
  await clearStagedBrowserUploads(options.artifactRoot);
  const token = randomBytes(32).toString("base64url");
  const records = new Map<string, BrowserSessionRecord>();
  const ownerSessions = new Map<string, string>();
  const codexBrowserSessions = new Map<string, CodexBrowserBinding>();
  const cleanupTasks = new Set<Promise<void>>();
  let browserUiEnabled = true;
  let codexNativeEnabled = true;
  let browserPolicyGeneration = 0;
  let showAgentCursor = true;
  let navigationApproval: "always-ask" | "always-allow" = "always-ask";
  const maxSessions = boundedPositiveInteger(
    options.maxSessions ?? MAX_SESSIONS,
    "session limit",
  );
  const idleSessionMs = boundedPositiveInteger(
    options.idleSessionMs ?? IDLE_SESSION_MS,
    "idle timeout",
  );
  const confirmations = new BrowserConfirmationBroker({
    onRequest: (request) => {
      if (options.isTrustedSurfaceAvailable?.() === false) {
        queueMicrotask(() => confirmations.respond(request.id, "deny"));
        return;
      }
      options.onConfirmationRequest?.(request);
    },
    onSettled: options.onConfirmationSettled,
  });

  const scheduleLeaseCleanup = (lease: BrowserLease): Promise<void> => {
    const cleanup = destroyLease(lease).catch(() => undefined);
    cleanupTasks.add(cleanup);
    void cleanup.finally(() => cleanupTasks.delete(cleanup));
    return cleanup;
  };

  const destroyRecord = (record: BrowserSessionRecord): void => {
    clearTimeout(record.expires);
    confirmations.clearSession(record.id);
    if (record.lease) void scheduleLeaseCleanup(record.lease);
    record.lease = null;
    records.delete(record.id);
    if (ownerSessions.get(record.ownerKey) === record.id) {
      ownerSessions.delete(record.ownerKey);
    }
    for (const [nativeSessionId, binding] of codexBrowserSessions) {
      if (binding.browserSessionId === record.id) {
        codexBrowserSessions.delete(nativeSessionId);
      }
    }
    publishState(options, record, "closed");
  };

  const touchRecord = (record: BrowserSessionRecord): void => {
    record.touchedAt = Date.now();
    clearTimeout(record.expires);
    record.expires = setTimeout(() => {
      if (records.get(record.id) !== record) return;
      const lease = record.lease;
      if (
        browserSessionShouldRemainAlive({
          activeOperations: record.activeOperations,
          surfaceAttached: Boolean(
            lease && lease.attachedTo !== lease.parkingWindow,
          ),
        })
      ) {
        touchRecord(record);
        return;
      }
      destroyRecord(record);
    }, idleSessionMs);
    record.expires.unref?.();
  };

  const acquire = async (
    owner: BrowserSessionOwner,
  ): Promise<BrowserSessionAcquireResponse> => {
    const normalizedOwner = await normalizeOwner(owner);
    const key = ownerKey(normalizedOwner);
    const existingId = ownerSessions.get(key);
    const existing = existingId ? records.get(existingId) : undefined;
    if (existing) {
      // A workspace restore may move the same durable workspace identity to a
      // new path. The identity owns the lease; the canonical path is mutable
      // upload-boundary metadata and must follow the engine-authoritative row.
      if (existing.canonicalWorkspaceRoot !== normalizedOwner.workspaceRoot) {
        existing.owner = normalizedOwner;
        existing.canonicalWorkspaceRoot = normalizedOwner.workspaceRoot;
      }
      touchRecord(existing);
      return {
        version: BROWSER_SERVICE_VERSION,
        browserSessionId: existing.id,
        capabilities: { codexIab: true },
      };
    }

    if (records.size >= maxSessions) {
      const oldest = [...records.values()]
        .filter((candidate) => {
          const lease = candidate.lease;
          return !browserSessionShouldRemainAlive({
            activeOperations: candidate.activeOperations,
            surfaceAttached: Boolean(
              lease && lease.attachedTo !== lease.parkingWindow,
            ),
          });
        })
        .sort((left, right) => left.touchedAt - right.touchedAt)[0];
      if (!oldest) {
        throw browserError(
          "Every isolated browser session is currently busy or visible.",
        );
      }
      destroyRecord(oldest);
    }
    const id = `browser_${randomBytes(18).toString("base64url")}`;
    const expires = setTimeout(() => undefined, idleSessionMs);
    expires.unref?.();
    const record: BrowserSessionRecord = {
      id,
      owner: normalizedOwner,
      ownerKey: key,
      canonicalWorkspaceRoot: normalizedOwner.workspaceRoot,
      touchedAt: Date.now(),
      expires,
      lease: null,
      operationTail: Promise.resolve(),
      activeOperations: 0,
      interruptionGeneration: 0,
      appearance: null,
      agent: null,
    };
    records.set(id, record);
    ownerSessions.set(key, id);
    touchRecord(record);
    return {
      version: BROWSER_SERVICE_VERSION,
      browserSessionId: id,
      capabilities: { codexIab: true },
    };
  };

  const release = (workspaceId: string, conversationId: string): boolean => {
    if (
      !isBrowserProductId(workspaceId) ||
      !isBrowserProductId(conversationId)
    ) {
      return false;
    }
    const id = ownerSessions.get(ownerIdentityKey(workspaceId, conversationId));
    const record = id ? records.get(id) : undefined;
    if (!record) return false;
    destroyRecord(record);
    return true;
  };

  const invokeAs = async (
    request: BrowserToolInvokeRequest,
    actor: "agent" | "user",
  ): Promise<BrowserToolResult> => {
    const blocked = () =>
      browserServiceInvocationBlockedReason({
        browserEnabled: browserUiEnabled,
        trustedSurfaceAvailable:
          options.isTrustedSurfaceAvailable?.() !== false,
      });
    const initialBlock = blocked();
    if (initialBlock) return failure(initialBlock);
    const policyGeneration = browserPolicyGeneration;
    if (
      request.version !== BROWSER_SERVICE_VERSION ||
      !isBrowserProductId(request.browserSessionId) ||
      !isBrowserToolName(request.tool)
    ) {
      return failure("Invalid Zeros browser tool request.");
    }
    const record = records.get(request.browserSessionId);
    if (!record) return failure("The Zeros browser session is unavailable.");
    const interruptionGeneration = record.interruptionGeneration;
    touchRecord(record);
    const previous = record.operationTail;
    let release!: () => void;
    record.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    record.activeOperations += 1;
    await previous;
    try {
      const queuedBlock = blocked();
      if (queuedBlock) return failure(queuedBlock);
      if (
        !browserPolicySnapshotIsCurrent(
          policyGeneration,
          browserPolicyGeneration,
        )
      ) {
        return failure("Browser use changed in Settings; retry the action.");
      }
      if (records.get(record.id) !== record) {
        return failure("The Zeros browser session is unavailable.");
      }
      if (interruptionGeneration !== record.interruptionGeneration) {
        return failure("Browser work was stopped by the user.");
      }
      if (record.lease) record.lease.actor = actor;
      // An unnamed caller must not inherit the previous agent's name.
      if (actor === "agent") record.agent = request.agent ?? null;
      const result = await executeTool(
        record,
        request.tool,
        request.arguments,
        {
          options,
          confirmations,
          actor,
          showAgentCursor,
          navigationApproval,
          interrupted: () =>
            interruptionGeneration !== record.interruptionGeneration,
          stopFromPage: stopFromControlBar,
        },
      );
      if (
        record.lease &&
        (record.lease.pendingHostActions.size > 0 ||
          record.lease.hostActionFailures.length > 0)
      ) {
        await waitForHostActions(record.lease, false);
      }
      if (
        record.lease &&
        browserOperationNeedsReadySettlement(record.lease.status)
      ) {
        publishState(options, record, "ready", request.tool);
      }
      return result;
    } catch (error) {
      if (record.lease && !record.lease.view.webContents.isDestroyed()) {
        publishState(options, record, "ready", request.tool);
      }
      return failure(browserErrorMessage(error));
    } finally {
      record.activeOperations -= 1;
      release();
    }
  };
  const invoke = (request: BrowserToolInvokeRequest) =>
    invokeAs(request, "agent");

  // Stop the agent's current action and keep the page. Shared by the trusted
  // Browser tab Stop button (IPC) and the engine's per-turn cancel route.
  const stopBrowserAction = (browserSessionId: string): boolean => {
    if (!isBrowserProductId(browserSessionId)) return false;
    const record = records.get(browserSessionId);
    if (!record) return false;
    for (const binding of codexBrowserSessions.values()) {
      if (binding.browserSessionId === browserSessionId) {
        binding.blockedTurnId = binding.activeTurnId;
      }
    }
    record.interruptionGeneration += 1;
    confirmations.clearSession(record.id);
    const lease = record.lease;
    if (!lease || lease.view.webContents.isDestroyed()) return false;
    lease.view.webContents.stop();
    for (const item of lease.activeDownloads) item.cancel();
    releaseCodexNativeControl(lease);
    void lease.view.webContents
      .executeJavaScript(
        `${agentPointerCleanupScript(lease.pointerOverlayId)};${agentWorkingOverlayScript(lease.workingOverlayId, false)}`,
        true,
      )
      .catch(() => undefined);
    publishState(options, record, "ready");
    return true;
  };

  // The user took the page back from inside it (Esc) or from its control
  // bar. Unlike the trusted Browser chrome, neither can settle the provider's
  // pending Browser approval itself, so main relays the stop to the renderer.
  const stopFromControlBar = (browserSessionId: string): boolean => {
    const record = records.get(browserSessionId);
    if (!record || !stopBrowserAction(browserSessionId)) return false;
    options.onUserStoppedAgent?.({
      browserSessionId,
      conversationId: record.owner.conversationId,
    });
    return true;
  };

  const controlAsUser = (
    browserSessionId: string,
    tool: "open" | "back" | "forward" | "reload",
    rawArguments: BrowserJsonValue,
  ): BrowserToolResult => {
    const blocked = browserServiceInvocationBlockedReason({
      browserEnabled: browserUiEnabled,
      trustedSurfaceAvailable:
        options.isTrustedSurfaceAvailable?.() !== false,
    });
    if (blocked) return failure(blocked);
    if (!isBrowserProductId(browserSessionId)) {
      return failure("Invalid Zeros browser control request.");
    }
    const record = records.get(browserSessionId);
    const lease = record?.lease;
    if (!record || !lease || lease.view.webContents.isDestroyed()) {
      return failure("The Zeros browser session is unavailable.");
    }
    // A trusted chrome click may arrive just after the renderer has painted an
    // agent-owned state. Do not race an active provider input/navigation.
    if (
      lease.actor === "agent" ||
      record.activeOperations > 0 ||
      lease.status === "working" ||
      lease.status === "awaiting-confirmation"
    ) {
      return failure("Wait for the agent to finish using the browser.");
    }

    const args = asRecord(rawArguments);
    let url: string | undefined;
    if (tool === "open") {
      try {
        url = normalizeWebUrl(requireString(args.url, "url"));
      } catch (error) {
        return failure(browserErrorMessage(error));
      }
    }

    const contents = lease.view.webContents;
    if (
      (tool === "back" && !contents.navigationHistory.canGoBack()) ||
      (tool === "forward" && !contents.navigationHistory.canGoForward())
    ) {
      return success({ accepted: false, browserSessionId });
    }

    lease.actor = "user";
    lease.pointer = null;
    lease.action = null;
    lease.agentActivityUntil = 0;
    lease.currentTool = tool;
    lease.pendingUrl = url ?? null;
    recordTrace(lease, "tool", tool);
    touchRecord(record);
    let dispatched = false;
    try {
      dispatched = dispatchBrowserUserNavigation({
        tool,
        ...(url ? { url } : {}),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
        open: (targetUrl) => {
          // Chromium starts loading before any semantic snapshot work.
          // Lifecycle events publish committed URL/title/history later.
          void contents.loadURL(targetUrl).then(
            () => {
              if (record.lease !== lease || contents.isDestroyed()) return;
              if (lease.pendingUrl === targetUrl) lease.pendingUrl = null;
              publishState(options, record, "ready", tool);
            },
            () => {
              if (record.lease !== lease || contents.isDestroyed()) return;
              if (lease.pendingUrl === targetUrl) lease.pendingUrl = null;
              publishState(options, record, "ready", tool);
            },
          );
        },
        back: () => contents.navigationHistory.goBack(),
        forward: () => contents.navigationHistory.goForward(),
        reload: () => contents.reload(),
      });
    } catch (error) {
      lease.pendingUrl = null;
      return failure(browserErrorMessage(error));
    }
    if (!dispatched) {
      lease.pendingUrl = null;
      lease.currentTool = undefined;
      return success({ accepted: false, browserSessionId });
    }
    publishState(options, record, "ready", tool);
    return success({
      accepted: true,
      browserSessionId,
      ...(url ? { url } : {}),
    });
  };

  const server: Server = createServer(async (request, response) => {
    setJsonHeaders(response);
    if (!tokenMatches(request, token)) {
      sendJson(response, 401, {
        error: "Zeros browser service request rejected.",
      });
      return;
    }
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        request.method === "POST" &&
        url.pathname === "/v1/providers/codex/register"
      ) {
        const body = asRecord(await readJsonBody(request));
        const browserSessionId = String(body.browserSessionId ?? "");
        const nativeSessionId = String(body.nativeSessionId ?? "");
        if (
          body.version !== BROWSER_SERVICE_VERSION ||
          !isBrowserProductId(browserSessionId) ||
          !browserSessionId.startsWith("browser_") ||
          !validNativeBrowserSessionId(nativeSessionId) ||
          !records.has(browserSessionId)
        ) {
          throw browserError("Invalid native Codex browser binding.");
        }
        // A conversation has one live provider session. Revoking an older
        // thread here prevents a stale app-server process from reclaiming the
        // browser after a resume/rebuild has installed its replacement.
        for (const [existingId, binding] of codexBrowserSessions) {
          if (binding.browserSessionId === browserSessionId) {
            codexBrowserSessions.delete(existingId);
          }
        }
        codexBrowserSessions.set(nativeSessionId, {
          browserSessionId,
          touchedAt: Date.now(),
          activeTurnId: null,
          blockedTurnId: null,
        });
        pruneCodexBrowserBindings(codexBrowserSessions);
        sendJson(response, 200, { registered: true });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/providers/codex/turn-ended"
      ) {
        const body = asRecord(await readJsonBody(request));
        const browserSessionId = String(body.browserSessionId ?? "");
        const nativeSessionId = String(body.nativeSessionId ?? "");
        if (
          body.version !== BROWSER_SERVICE_VERSION ||
          !isBrowserProductId(browserSessionId) ||
          !browserSessionId.startsWith("browser_") ||
          !validNativeBrowserSessionId(nativeSessionId)
        ) {
          throw browserError("Invalid native Codex turn settlement.");
        }
        const binding = codexBrowserSessions.get(nativeSessionId);
        const record = binding
          ? records.get(binding.browserSessionId)
          : undefined;
        if (!binding || !record) {
          if (binding) codexBrowserSessions.delete(nativeSessionId);
          sendJson(response, 200, {
            version: BROWSER_SERVICE_VERSION,
            settled: false,
          });
          return;
        }
        const lease =
          record.lease && !record.lease.view.webContents.isDestroyed()
            ? record.lease
            : null;
        const disposition = codexTurnSettlementDisposition({
          requestedBrowserSessionId: browserSessionId,
          bindingBrowserSessionId: binding.browserSessionId,
          activeTurnId: binding.activeTurnId,
          blockedTurnId: binding.blockedTurnId,
          leaseActor: lease?.actor ?? null,
          leaseTurnId: lease?.browserUseTurnId ?? null,
        });
        if (disposition.settled) {
          // Publish terminal ownership before any await so a racing request
          // from the just-completed turn is rejected immediately.
          binding.activeTurnId = disposition.activeTurnId;
          binding.blockedTurnId = disposition.blockedTurnId;
          binding.touchedAt = Date.now();
          if (disposition.handoff && lease) {
            await handBrowserLeaseToUser(record, lease, options);
          }
          touchRecord(record);
        }
        sendJson(response, 200, {
          version: BROWSER_SERVICE_VERSION,
          settled: disposition.settled,
        });
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sessions/acquire"
      ) {
        const body = asRecord(await readJsonBody(request));
        const parsed: BrowserSessionAcquireRequest = {
          version: body.version as 1,
          owner: asRecord(body.owner) as unknown as BrowserSessionOwner,
        };
        if (parsed.version !== BROWSER_SERVICE_VERSION) {
          throw browserError("Unsupported Zeros browser service version.");
        }
        sendJson(response, 200, await acquire(parsed.owner));
        return;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/v1/sessions/release"
      ) {
        const body = asRecord(await readJsonBody(request));
        const parsed: BrowserSessionReleaseRequest = {
          version: body.version as 1,
          workspaceId:
            body.workspaceId as BrowserSessionReleaseRequest["workspaceId"],
          conversationId:
            body.conversationId as BrowserSessionReleaseRequest["conversationId"],
        };
        if (
          parsed.version !== BROWSER_SERVICE_VERSION ||
          !isBrowserProductId(parsed.workspaceId) ||
          !isBrowserProductId(parsed.conversationId)
        ) {
          throw browserError("Invalid Zeros browser release owner.");
        }
        const result: BrowserSessionReleaseResponse = {
          version: BROWSER_SERVICE_VERSION,
          released: release(parsed.workspaceId, parsed.conversationId),
        };
        sendJson(response, 200, result);
        return;
      }
      const stopMatch = /^\/v1\/sessions\/([^/]+)\/stop$/.exec(url.pathname);
      if (stopMatch && request.method === "POST") {
        const body = asRecord(await readJsonBody(request));
        if (body.version !== BROWSER_SERVICE_VERSION) {
          throw browserError("Unsupported Zeros browser service version.");
        }
        const result: BrowserSessionStopResponse = {
          version: BROWSER_SERVICE_VERSION,
          stopped: stopBrowserAction(decodeURIComponent(stopMatch[1]!)),
        };
        sendJson(response, 200, result);
        return;
      }
      const match = /^\/v1\/sessions\/([^/]+)(?:\/invoke)?$/.exec(url.pathname);
      if (
        match &&
        request.method === "POST" &&
        url.pathname.endsWith("/invoke")
      ) {
        const browserSessionId = decodeURIComponent(match[1]!);
        const body = asRecord(await readJsonBody(request));
        sendJson(
          response,
          200,
          await invoke({
            version: body.version as 1,
            browserSessionId,
            tool: body.tool as BrowserToolName,
            arguments: (body.arguments ?? {}) as BrowserJsonValue,
            ...(isAgentControlFamily(body.agent) ? { agent: body.agent } : {}),
          }),
        );
        return;
      }
      if (
        match &&
        request.method === "DELETE" &&
        !url.pathname.endsWith("/invoke")
      ) {
        const browserSessionId = decodeURIComponent(match[1]!);
        const record = records.get(browserSessionId);
        if (record) destroyRecord(record);
        response.statusCode = 204;
        response.end();
        return;
      }
      sendJson(response, 404, {
        error: "Zeros browser service route not found.",
      });
    } catch (error) {
      sendJson(response, 400, {
        error: browserErrorMessage(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw browserError("Zeros browser service did not bind a loopback port.");
  }
  let browserUsePipe!: CodexBrowserUsePipeHandle;
  try {
    browserUsePipe = await startCodexBrowserUsePipe({
      onRequest: (request) =>
        handleCodexBrowserUseRequest(request, {
          sessions: codexBrowserSessions,
          records,
          options,
          confirmations,
          pipe: () => browserUsePipe,
          browserEnabled: () => browserUiEnabled,
          codexNativeEnabled: () => codexNativeEnabled,
          trustedSurfaceAvailable: () =>
            options.isTrustedSurfaceAvailable?.() !== false,
          showAgentCursor: () => showAgentCursor,
          navigationApproval: () => navigationApproval,
          touchRecord,
          scheduleLeaseCleanup,
          stopFromPage: stopFromControlBar,
        }),
    });
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    codexBrowserUsePipePath: browserUsePipe.path,
    acquire,
    release,
    invoke,
    attach(browserSessionId, target, bounds, surfaceId) {
      if (
        !browserUiEnabled ||
        !isBrowserProductId(browserSessionId) ||
        !isBrowserSurfaceId(surfaceId) ||
        target.isDestroyed()
      ) {
        return null;
      }
      const safeBounds = normalizeBrowserViewBounds(bounds);
      const record = records.get(browserSessionId);
      const lease = record?.lease;
      if (
        !safeBounds ||
        !record ||
        !lease ||
        lease.view.webContents.isDestroyed()
      ) {
        return null;
      }
      const surfaceChanged =
        lease.attachedTo !== target || lease.surfaceId !== surfaceId;
      if (lease.attachedTo !== target && !lease.attachedTo.isDestroyed()) {
        lease.attachedTo.contentView.removeChildView(lease.view);
      }
      // Re-adding an existing child raises it above sibling native views. This
      // is required after other workbench surfaces have been activated.
      target.contentView.addChildView(lease.view);
      lease.attachedTo = target;
      lease.surfaceId = surfaceId;
      lease.surfaceHovered = browserSurfaceHoverAfterAttach(
        surfaceChanged,
        lease.surfaceHovered,
      );
      const pictureInPicture = browserSurfaceIsPictureInPicture(surfaceId);
      const presentation = browserViewportPresentation(
        safeBounds,
        lease.sourceViewport,
        pictureInPicture,
      );
      lease.viewport = presentation.viewport;
      // A full workbench rectangle IS the browser viewport the page renders at,
      // so it becomes the source a later PiP rehost scales down. Without this
      // the compact card would keep reflowing the page to the lease's creation
      // default instead of preserving the layout the user was just looking at.
      if (!pictureInPicture) {
        lease.sourceViewport = { ...presentation.viewport };
      }
      lease.view.webContents.setZoomFactor(presentation.zoomFactor);
      lease.view.setBounds(safeBounds);
      lease.view.setVisible(
        browserSurfaceShouldBeVisible({
          attachedToTrustedWindow: true,
          confirmationDepth: lease.confirmationDepth,
        }),
      );
      touchRecord(record);
      const state = sessionState(record);
      // Re-adding the page above raised it over its control bar.
      syncAgentControlBar(options, record, state, true);
      return state;
    },
    park(browserSessionId, surfaceId) {
      const record = records.get(browserSessionId);
      const lease = record?.lease;
      if (
        !lease ||
        lease.view.webContents.isDestroyed() ||
        !isBrowserSurfaceId(surfaceId) ||
        !browserSurfaceDetachAllowed(lease.surfaceId, surfaceId)
      ) {
        return false;
      }
      parkLease(lease);
      touchRecord(record);
      publishState(options, record, lease.status, lease.currentTool);
      return true;
    },
    detach(browserSessionId, surfaceId) {
      const record = records.get(browserSessionId);
      const lease = record?.lease;
      if (
        !lease ||
        lease.view.webContents.isDestroyed() ||
        !isBrowserSurfaceId(surfaceId) ||
        !browserSurfaceDetachAllowed(lease.surfaceId, surfaceId)
      ) {
        return false;
      }
      parkLease(lease);
      if (record) {
        touchRecord(record);
        // Publish the native mouse-leave edge even though parking itself is a
        // presentation transition. PiP latches its hover toolbar until React
        // receives leave, then needs this false→true edge for the next native
        // hover after reattachment.
        publishState(options, record, lease.status, lease.currentTool);
      }
      return true;
    },
    async capture(browserSessionId) {
      const record = records.get(browserSessionId);
      const lease = record?.lease;
      if (!lease || lease.view.webContents.isDestroyed()) return null;
      return captureBrowserSurface(lease.view.webContents, MAX_RESPONSE_BYTES);
    },
    setAppearance(browserSessionId, appearance) {
      const record = records.get(browserSessionId);
      if (!record) return false;
      record.appearance = appearance;
      void record.lease?.appearance.set(appearance);
      return true;
    },
    control(browserSessionId, tool, args = {}) {
      return Promise.resolve(controlAsUser(browserSessionId, tool, args));
    },
    async clearBrowsingData() {
      // Clearing data is also a control-boundary reset. Invalidate current and
      // queued work before closing WebContents so nothing can resume against a
      // newly acquired profile after this promise resolves.
      confirmations.revokeConfirmationSurface();
      for (const binding of codexBrowserSessions.values()) {
        binding.blockedTurnId = binding.activeTurnId;
      }
      const cleanup: Promise<void>[] = [];
      let cleared = 0;
      for (const record of records.values()) {
        record.interruptionGeneration += 1;
        const lease = record.lease;
        if (!lease) continue;
        record.lease = null;
        cleared += 1;
        cleanup.push(scheduleLeaseCleanup(lease));
        publishState(options, record, "closed");
      }
      await Promise.allSettled(cleanup);
      return cleared;
    },
    setUiPreferences(preferences) {
      const wasEnabled = browserUiEnabled;
      if (browserUiEnabled !== preferences.browserEnabled) {
        browserPolicyGeneration += 1;
      }
      browserUiEnabled = preferences.browserEnabled;
      const nativeWasEnabled = codexNativeEnabled;
      codexNativeEnabled = preferences.codexNativeEnabled !== false;
      if (nativeWasEnabled && !codexNativeEnabled) {
        // Pages stay open for the Zeros tools; only plugin work in flight ends.
        for (const binding of codexBrowserSessions.values()) {
          binding.blockedTurnId = binding.activeTurnId;
        }
      }
      showAgentCursor = preferences.showAgentCursor;
      navigationApproval = preferences.navigationApproval;
      if (wasEnabled && !browserUiEnabled) {
        for (const binding of codexBrowserSessions.values()) {
          binding.blockedTurnId = binding.activeTurnId;
        }
        for (const record of records.values()) {
          record.interruptionGeneration += 1;
          const lease = record.lease;
          confirmations.clearSession(record.id);
          if (!lease) continue;
          record.lease = null;
          void scheduleLeaseCleanup(lease);
          publishState(options, record, "closed");
        }
      }
      for (const record of records.values()) {
        if (record.lease) {
          record.lease.navigationApproval = navigationApproval;
        }
      }
      if (showAgentCursor) return;
      for (const record of records.values()) {
        const lease = record.lease;
        if (!lease || lease.view.webContents.isDestroyed()) continue;
        lease.pointer = null;
        void lease.view.webContents
          .executeJavaScript(
            agentPointerCleanupScript(lease.pointerOverlayId),
            true,
          )
          .catch(() => undefined);
      }
    },
    refreshAgentControl() {
      for (const record of records.values()) {
        if (record.lease) syncAgentControlBar(options, record, sessionState(record));
      }
    },
    stopBrowserAction,
    stopFromControlBar,
    close(browserSessionId) {
      const record = records.get(browserSessionId);
      if (!record) return false;
      destroyRecord(record);
      return true;
    },
    sessionStates() {
      return [...records.values()]
        .map((record) => sessionState(record))
        .filter((state) => state.status !== "closed");
    },
    confirmationRequests() {
      return confirmations.pendingRequests();
    },
    respondToConfirmation(confirmationId, decision) {
      return confirmations.respond(confirmationId, decision);
    },
    async revokeConfirmationSurface() {
      const denied = confirmations.revokeConfirmationSurface();
      for (const binding of codexBrowserSessions.values()) {
        binding.blockedTurnId = binding.activeTurnId;
      }
      const cleanup: Promise<void>[] = [];
      for (const record of records.values()) {
        record.interruptionGeneration += 1;
        const lease = record.lease;
        if (!lease) continue;
        record.lease = null;
        cleanup.push(scheduleLeaseCleanup(lease));
        publishState(options, record, "closed");
      }
      await Promise.allSettled(cleanup);
      return denied;
    },
    async stop() {
      confirmations.stop();
      for (const record of [...records.values()]) destroyRecord(record);
      await Promise.allSettled([browserUsePipe.stop(), ...cleanupTasks]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface CodexBrowserUseContext {
  sessions: Map<string, CodexBrowserBinding>;
  records: Map<string, BrowserSessionRecord>;
  options: ZerosBrowserServiceOptions;
  confirmations: BrowserConfirmationBroker;
  pipe(): CodexBrowserUsePipeHandle;
  browserEnabled(): boolean;
  /** "Use Codex's built-in browser". Off leaves Codex the Zeros tools. */
  codexNativeEnabled(): boolean;
  trustedSurfaceAvailable(): boolean;
  showAgentCursor(): boolean;
  navigationApproval(): "always-ask" | "always-allow";
  touchRecord(record: BrowserSessionRecord): void;
  scheduleLeaseCleanup(lease: BrowserLease): Promise<void>;
  /** The user pressed Esc in an agent-controlled page. */
  stopFromPage(browserSessionId: string): void;
}

/** Native IAB backend consumed by Codex's official bundled Browser plugin.
 * The plugin continues to own its Browser skill, `node_repl.js` tool calls,
 * Playwright facade, batching, and result metadata. Zeros owns only the secure
 * Electron tab and its visible user/agent handoff. */
async function handleCodexBrowserUseRequest(
  request: CodexBrowserUseRequest,
  context: CodexBrowserUseContext,
): Promise<unknown> {
  const binding = context.sessions.get(request.sessionId);
  if (!binding) {
    throw browserError(
      "Browser turn does not belong to this Zeros conversation.",
    );
  }
  const record = context.records.get(binding.browserSessionId);
  if (!record) {
    context.sessions.delete(request.sessionId);
    throw browserError("The conversation browser session is unavailable.");
  }
  if (binding.blockedTurnId === request.turnId) {
    throw browserError("Browser work was stopped by the user.");
  }
  if (binding.blockedTurnId && binding.blockedTurnId !== request.turnId) {
    binding.blockedTurnId = null;
  }
  binding.activeTurnId = request.turnId;
  binding.touchedAt = Date.now();
  context.touchRecord(record);

  if (request.method === "getInfo") {
    return codexBrowserIabInfo(request.sessionId);
  }
  if (request.method === "ping") return "pong";
  if (!context.browserEnabled()) {
    throw browserError("Browser use is disabled in Settings.");
  }
  if (!context.codexNativeEnabled()) {
    throw browserError(
      "Codex’s built-in browser is turned off in Settings > Browser.",
    );
  }
  if (!context.trustedSurfaceAvailable()) {
    throw browserError("Browser use needs an open trusted Zeros window.");
  }

  const interruptedAtStart = record.interruptionGeneration;
  const interrupted = () =>
    binding.blockedTurnId === request.turnId ||
    record.interruptionGeneration !== interruptedAtStart ||
    context.records.get(record.id) !== record;
  const currentLease = (): BrowserLease | null => {
    const lease = record.lease;
    return lease && !lease.view.webContents.isDestroyed() ? lease : null;
  };
  const requireLease = (): BrowserLease => {
    const lease = currentLease();
    if (!lease) throw browserError("Browser tab is no longer available.");
    context.touchRecord(record);
    return lease;
  };
  const controlledTab = (lease: BrowserLease) => ({
    id: lease.view.webContents.id,
    url: lease.view.webContents.getURL() || "about:blank",
    title: lease.view.webContents.getTitle() || "New tab",
    active: true,
  });
  const userTab = (lease: BrowserLease) =>
    codexNativeUserTab(
      {
        browserSessionId: record.id,
        webContentsId: lease.view.webContents.id,
      },
      {
        url: lease.view.webContents.getURL() || "about:blank",
        title: lease.view.webContents.getTitle() || "New tab",
        touchedAt: record.touchedAt,
      },
    );
  const beginNativeWork = async (
    lease: BrowserLease,
    tool: BrowserToolName,
    label: string,
  ) => {
    if (lease.browserUseTurnId !== request.turnId) {
      lease.codexTabDisposition = null;
    }
    lease.actor = "agent";
    record.agent = "codex";
    lease.browserUseTurnId = request.turnId;
    lease.browserUseSocket = request.socket;
    lease.navigationApproval = context.navigationApproval();
    lease.agentActivityUntil = Date.now() + AGENT_ACTIVITY_LINGER_MS;
    lease.action = {
      sequence: ++lease.actionSequence,
      kind: tool,
      label,
      startedAt: Date.now(),
    };
    if (!context.showAgentCursor() && lease.pointer) {
      lease.pointer = null;
      await lease.view.webContents
        .executeJavaScript(
          agentPointerCleanupScript(lease.pointerOverlayId),
          true,
        )
        .catch(() => undefined);
    }
    publishState(context.options, record, "working", tool);
  };
  const ensureLease = async (): Promise<BrowserLease> => {
    let lease = currentLease();
    if (!lease) {
      lease = createLease(record, {
        options: context.options,
        confirmations: context.confirmations,
        actor: "agent",
        showAgentCursor: context.showAgentCursor(),
        navigationApproval: context.navigationApproval(),
        interrupted,
        stopFromPage: context.stopFromPage,
      });
      record.lease = lease;
    }
    await beginNativeWork(lease, "open", "Opening browser");
    try {
      await ensureCodexBrowserUseReady(lease);
      ensureCodexBrowserUseDebugger(lease, context.pipe());
    } catch (error) {
      if (record.lease === lease) {
        record.lease = null;
        context.confirmations.clearSession(record.id);
        publishState(context.options, record, "closed", "renderer-crash");
        await context.scheduleLeaseCleanup(lease);
      }
      throw error;
    }
    return lease;
  };

  record.activeOperations += 1;
  try {
    switch (request.method) {
      case "getTabs": {
        const lease = currentLease();
        return lease && lease.actor === "agent" ? [controlledTab(lease)] : [];
      }
      case "getUserTabs": {
        const lease = currentLease();
        return lease && lease.actor === "user" ? [userTab(lease)] : [];
      }
      case "getUserHistory":
        // Browsing history is intentionally scoped to the visible retained tab;
        // Zeros never exposes a user-wide history database to an agent.
        return [];
      case "createTab": {
        const lease = await ensureLease();
        return controlledTab(lease);
      }
      case "claimUserTab": {
        const lease = requireLease();
        if (lease.actor !== "user") {
          throw browserError(
            "The browser tab is already controlled by the agent.",
          );
        }
        // The official IAB command layer currently accepts only a positive
        // numeric string here. It still came from this conversation's fresh
        // getUserTabs result, and both native session and lease are checked.
        if (
          !codexUserTabClaimMatches(request.params.tabId, {
            browserSessionId: record.id,
            webContentsId: lease.view.webContents.id,
          })
        ) {
          throw browserError(
            "Browser tab does not belong to this Zeros conversation.",
          );
        }
        await beginNativeWork(lease, "snapshot", "Resuming browser");
        await ensureCodexBrowserUseReady(lease);
        ensureCodexBrowserUseDebugger(lease, context.pipe());
        return controlledTab(lease);
      }
      case "attach": {
        const lease = requireLease();
        assertCodexBrowserTab(request.params, record, lease);
        await beginNativeWork(lease, "snapshot", "Inspecting page");
        ensureCodexBrowserUseDebugger(lease, context.pipe());
        return {};
      }
      case "detach": {
        const lease = requireLease();
        assertCodexBrowserTab(request.params, record, lease);
        return {};
      }
      case "getCommittedTabUrl": {
        // The official client checks URL policy and origin consent against
        // this before every guarded command. It is only a read, so it never
        // claims the page or publishes agent activity.
        const lease = requireLease();
        assertCodexBrowserTab(request.params, record, lease);
        await ensureCodexBrowserUseReady(lease);
        if (currentLease() !== lease) {
          throw browserError("Browser tab is no longer available.");
        }
        return lease.view.webContents.getURL() || undefined;
      }
      case "focusTab": {
        const lease = requireLease();
        assertCodexBrowserTab(request.params, record, lease);
        await beginNativeWork(lease, "snapshot", "Inspecting page");
        return {};
      }
      case "nameSession":
        return {};
      case "markTab": {
        const lease = requireLease();
        assertCodexBrowserTab(request.params, record, lease);
        const status = request.params.status;
        if (status !== "deliverable" && status !== "handoff") {
          throw browserError("Unsupported browser tab disposition.");
        }
        lease.codexTabDisposition = status;
        return {};
      }
      case "finalizeTabs": {
        const lease = currentLease();
        if (lease) {
          if (
            codexFinalizeDisposition(
              request.params,
              {
                browserSessionId: record.id,
                webContentsId: lease.view.webContents.id,
              },
              lease.codexTabDisposition,
            ) === "keep"
          ) {
            await handBrowserLeaseToUser(record, lease, context.options);
          } else {
            record.lease = null;
            context.confirmations.clearSession(record.id);
            publishState(context.options, record, "closed");
            await context.scheduleLeaseCleanup(lease);
          }
        }
        binding.activeTurnId = null;
        binding.blockedTurnId = null;
        return {};
      }
      case "turnEnded": {
        const lease = currentLease();
        // A timeout or kernel reset can bypass tabs.finalize(). Never leave the
        // page locked; retain its exact URL/history and return it to the user.
        if (lease) await handBrowserLeaseToUser(record, lease, context.options);
        binding.activeTurnId = null;
        binding.blockedTurnId = null;
        return {};
      }
      case "isFullCdpEnabled":
        return false;
      case "moveMouse": {
        const lease = requireLease();
        assertCodexBrowserTab(request.params, record, lease);
        await beginNativeWork(lease, "click", "Moving on page");
        ensureCodexBrowserUseDebugger(lease, context.pipe());
        const x = finiteNumberField(request.params, "x");
        const y = finiteNumberField(request.params, "y");
        if (context.showAgentCursor()) {
          await updateAgentPointer(lease, x, y, "move");
          publishState(context.options, record, "working", "click");
        }
        await preparePageForAgent(lease.view.webContents);
        lease.agentInputDepth += 1;
        try {
          await withTimeout(
            lease.view.webContents.debugger.sendCommand(
              "Input.dispatchMouseEvent",
              { type: "mouseMoved", x, y },
            ),
            BROWSER_USE_CDP_TIMEOUT_MS,
            nativeBrowserCommandTimeoutMessage("Input.dispatchMouseEvent"),
          );
        } finally {
          lease.agentInputDepth = Math.max(0, lease.agentInputDepth - 1);
        }
        if (interrupted())
          throw browserError("Browser work was stopped by the user.");
        return {};
      }
      case "executeCdp": {
        const lease = requireLease();
        const target = asRecord(request.params.target);
        assertCodexBrowserTab(target, record, lease);
        const method = requireNativeBrowserMethod(request.params.method);
        const commandParams = asRecord(request.params.commandParams);
        if (method === "Page.close" || method === "Target.closeTarget") {
          record.lease = null;
          context.confirmations.clearSession(record.id);
          publishState(context.options, record, "closed");
          await context.scheduleLeaseCleanup(lease);
          return {};
        }
        const activity = nativeBrowserActivity(method, commandParams);
        await beginNativeWork(lease, activity.tool, activity.label);
        ensureCodexBrowserUseDebugger(lease, context.pipe());
        const pointer = pointerFromNativeCdpCommand(method, commandParams);
        if (pointer && context.showAgentCursor()) {
          await updateAgentPointer(lease, pointer.x, pointer.y, pointer.action);
          publishState(context.options, record, "working", activity.tool);
        } else if (
          context.showAgentCursor() &&
          lease.pointer &&
          (method === "Input.dispatchKeyEvent" || method === "Input.insertText")
        ) {
          await updateAgentPointer(
            lease,
            lease.pointer.x,
            lease.pointer.y,
            "type",
          );
        }
        const sessionId =
          typeof target.sessionId === "string" ? target.sessionId : undefined;
        const timeoutMs = browserUseCommandTimeout(request.params.timeoutMs);
        const inputCommand = method.startsWith("Input.");
        if (inputCommand) await preparePageForAgent(lease.view.webContents);
        // OpenAI's Browser plugin has already applied URL policy, site-status,
        // and origin-consent checks before its high-level navigate command is
        // lowered to Page.navigate. Scope this preapproval to that one CDP
        // dispatch so Electron does not ask twice. Any redirect to another
        // origin, page-authored navigation, or click still hits the host gate.
        const nativePreapprovedOrigin = codexNativePreapprovedNavigationOrigin(
          method,
          commandParams,
        );
        const previousPreapproval = lease.preapprovedNavigationOrigin;
        if (nativePreapprovedOrigin) {
          lease.preapprovedNavigationOrigin = nativePreapprovedOrigin;
        }
        if (inputCommand) lease.agentInputDepth += 1;
        try {
          let result: unknown;
          if (method === "Page.captureScreenshot") {
            result = await captureNativeBrowserScreenshot(
              lease,
              commandParams,
              sessionId,
              timeoutMs,
            );
          } else {
            const previousUrl = lease.view.webContents.getURL();
            result = await withTimeout(
              lease.view.webContents.debugger.sendCommand(
                method,
                commandParams,
                sessionId,
              ),
              timeoutMs,
              nativeBrowserCommandTimeoutMessage(method),
            );
            if (
              method === "Page.navigate" &&
              asRecord(result).errorText === "net::ERR_ABORTED"
            ) {
              // A guarded cross-origin redirect is completed by a host action
              // after the superseded Page.navigate request reports ABORTED.
              // Wait for that permission/navigation transaction first, then
              // give unguarded redirects a short commit window. A blocked or
              // unchanged document retains errorText and remains a real error.
              if (
                lease.pendingHostActions.size > 0 ||
                lease.hostActionFailures.length > 0
              ) {
                await waitForHostActions(lease, false);
              }
              result = await normalizeCodexPageNavigateAfterRedirect(
                lease.view.webContents,
                result,
                {
                  requestedUrl: String(commandParams.url ?? ""),
                  previousUrl,
                },
              );
            }
          }
          if (
            lease.pendingHostActions.size > 0 ||
            lease.hostActionFailures.length > 0
          ) {
            await waitForHostActions(lease, false);
          }
          if (interrupted()) {
            throw browserError("Browser work was stopped by the user.");
          }
          return result;
        } catch (error) {
          if (isNativeBrowserCommandTimeout(error) && record.lease === lease) {
            binding.blockedTurnId = request.turnId;
            await handBrowserLeaseToUser(record, lease, context.options);
          }
          throw error;
        } finally {
          if (
            nativePreapprovedOrigin &&
            lease.preapprovedNavigationOrigin === nativePreapprovedOrigin
          ) {
            lease.preapprovedNavigationOrigin = previousPreapproval;
          }
          if (inputCommand) {
            lease.agentInputDepth = Math.max(0, lease.agentInputDepth - 1);
          }
        }
      }
      case "attachTarget":
      case "detachTarget":
        return {};
      case "allowDownload": {
        const lease = requireLease();
        assertCodexBrowserTab(request.params, record, lease);
        lease.codexApprovedDownloadUrl = normalizeWebUrl(
          requireString(request.params.url, "url"),
        );
        return {};
      }
      default:
        // The official client treats only this exact text as "not
        // implemented" and then uses its fallback: a cached CDP expression is
        // resent in full through executeCdp (so Zeros never caches page code),
        // and optional reads, host-only commands and credential-target
        // protection fail closed. Any other text is a hard command failure.
        throw browserError(
          unsupportedCodexBrowserMethodMessage(request.method),
        );
    }
  } finally {
    record.activeOperations = Math.max(0, record.activeOperations - 1);
  }
}

async function ensureCodexBrowserUseReady(lease: BrowserLease): Promise<void> {
  if (lease.browserUseReady) return await lease.browserUseReady;
  const contents = lease.view.webContents;
  const pending = (async () => {
    if (contents.isDestroyed()) {
      throw browserError("Browser tab is no longer available.");
    }
    // A detached WebContentsView does not necessarily commit a renderer before
    // its first navigation. Browser-client evaluates the initial document, so
    // create a real blank document before accepting CDP commands.
    if (!contents.getURL() || contents.getURL() === "about:blank") {
      await withTimeout(
        contents.loadURL("about:blank"),
        BROWSER_USE_BOOTSTRAP_TIMEOUT_MS,
        "Native browser initialization timed out.",
      );
    }
  })();
  lease.browserUseReady = pending;
  try {
    await pending;
  } catch (error) {
    if (lease.browserUseReady === pending) lease.browserUseReady = null;
    throw error;
  }
}

const NOOP = () => undefined;

function ensureCodexBrowserUseDebugger(
  lease: BrowserLease,
  pipe: CodexBrowserUsePipeHandle,
): void {
  const contents = lease.view.webContents;
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  if (lease.disposeBrowserUseDebugger !== NOOP) return;
  const onMessage = (
    _event: Electron.Event,
    method: string,
    params: unknown,
    sessionId?: string,
  ) => {
    const socket = lease.browserUseSocket;
    if (!socket) return;
    pipe.notify(
      "onCDPEvent",
      {
        source: {
          tabId: contents.id,
          ...(sessionId ? { sessionId } : {}),
        },
        method,
        params: asRecord(params),
      },
      socket,
    );
  };
  const onDetach = () => {
    const socket = lease.browserUseSocket;
    if (socket) pipe.notify("onCDPDetach", { tabId: contents.id }, socket);
  };
  contents.debugger.on("message", onMessage);
  contents.debugger.on("detach", onDetach);
  lease.disposeBrowserUseDebugger = () => {
    contents.debugger.off("message", onMessage);
    contents.debugger.off("detach", onDetach);
    if (!contents.isDestroyed() && contents.debugger.isAttached()) {
      contents.debugger.detach();
    }
    lease.disposeBrowserUseDebugger = NOOP;
  };
}

async function handBrowserLeaseToUser(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  options: ZerosBrowserServiceOptions,
): Promise<void> {
  if (record.lease !== lease || lease.view.webContents.isDestroyed()) return;
  releaseCodexNativeControl(lease);
  await lease.view.webContents
    .executeJavaScript(
      `${agentPointerCleanupScript(lease.pointerOverlayId)};${agentWorkingOverlayScript(lease.workingOverlayId, false)}`,
      true,
    )
    .catch(() => undefined);
  // A fresh native turn can start while the cleanup script is awaiting the
  // renderer. Never overwrite that newer turn's working state with the older
  // handoff's ready publication.
  if (
    record.lease === lease &&
    lease.actor === "user" &&
    lease.browserUseTurnId === null
  ) {
    publishState(options, record, "ready");
  }
}

async function captureNativeBrowserScreenshot(
  lease: BrowserLease,
  commandParams: Record<string, unknown>,
  sessionId: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  try {
    return await withTimeout(
      lease.view.webContents.debugger.sendCommand(
        "Page.captureScreenshot",
        commandParams,
        sessionId,
      ),
      Math.min(5_000, timeoutMs),
      "Native browser screenshot timed out.",
    );
  } catch {
    // Electron's compositor capture remains available when a hidden/detached
    // target cannot provide a raw CDP screenshot.
  }
  const clip = asRecord(commandParams.clip);
  const hasClip =
    Number.isFinite(Number(clip.x)) &&
    Number.isFinite(Number(clip.y)) &&
    Number.isFinite(Number(clip.width)) &&
    Number.isFinite(Number(clip.height));
  const image = await withTimeout(
    lease.view.webContents.capturePage(
      hasClip
        ? {
            x: Math.max(0, Math.round(Number(clip.x))),
            y: Math.max(0, Math.round(Number(clip.y))),
            width: Math.max(1, Math.round(Number(clip.width))),
            height: Math.max(1, Math.round(Number(clip.height))),
          }
        : undefined,
      { stayHidden: true, stayAwake: true },
    ),
    timeoutMs,
    nativeBrowserCommandTimeoutMessage("Page.captureScreenshot"),
  );
  const format = commandParams.format === "jpeg" ? "jpeg" : "png";
  const data =
    format === "jpeg"
      ? image.toJPEG(
          Math.min(
            100,
            Math.max(0, Math.round(Number(commandParams.quality ?? 80))),
          ),
        )
      : image.toPNG();
  return { data: data.toString("base64") };
}

function nativeBrowserActivity(
  method: string,
  params: Record<string, unknown>,
): { tool: BrowserToolName; label: string } {
  if (method === "Page.navigate")
    return { tool: "open", label: "Opening website" };
  if (method === "Page.captureScreenshot") {
    return { tool: "screenshot", label: "Capturing page" };
  }
  if (method === "Input.dispatchMouseEvent") {
    return String(params.type ?? "") === "mouseWheel"
      ? { tool: "scroll", label: "Scrolling page" }
      : { tool: "click", label: "Interacting with page" };
  }
  if (method.startsWith("Input.")) {
    return { tool: "type", label: "Typing in page" };
  }
  if (method === "Page.reload")
    return { tool: "reload", label: "Reloading page" };
  if (method.startsWith("Page.get") || method.startsWith("DOM.")) {
    return { tool: "snapshot", label: "Inspecting page" };
  }
  return { tool: "snapshot", label: "Browsing page" };
}

function pointerFromNativeCdpCommand(
  method: string,
  params: Record<string, unknown>,
): { x: number; y: number; action: BrowserAgentPointer["action"] } | null {
  if (method !== "Input.dispatchMouseEvent") return null;
  const x = Number(params.x);
  const y = Number(params.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const type = String(params.type ?? "");
  return {
    x,
    y,
    action:
      type === "mouseMoved"
        ? "move"
        : type === "mouseWheel"
          ? "scroll"
          : "click",
  };
}

function assertCodexBrowserTab(
  value: unknown,
  record: BrowserSessionRecord,
  lease: BrowserLease,
): void {
  if (
    !codexNativeTabMatches(value, {
      browserSessionId: record.id,
      webContentsId: lease.view.webContents.id,
    })
  ) {
    throw browserError(
      "Browser tab does not belong to this Zeros conversation.",
    );
  }
}

function browserUseCommandTimeout(value: unknown): number {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return BROWSER_USE_CDP_TIMEOUT_MS;
  }
  return Math.min(
    BROWSER_USE_CDP_MAX_TIMEOUT_MS,
    Math.max(1_000, Math.round(timeout)),
  );
}

function nativeBrowserCommandTimeoutMessage(method: string): string {
  return `Native browser command timed out: ${method}`;
}

function isNativeBrowserCommandTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Native browser command timed out:")
  );
}

function requireNativeBrowserMethod(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(value)
  ) {
    throw browserError("Invalid native browser method.");
  }
  return value;
}

function finiteNumberField(
  value: Record<string, unknown>,
  key: string,
): number {
  const result = Number(value[key]);
  if (!Number.isFinite(result)) throw browserError(`Invalid ${key}.`);
  return result;
}

function validNativeBrowserSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function pruneCodexBrowserBindings(
  bindings: Map<string, CodexBrowserBinding>,
): void {
  while (bindings.size > MAX_CODEX_BROWSER_BINDINGS) {
    const oldest = [...bindings.entries()].sort(
      (left, right) => left[1].touchedAt - right[1].touchedAt,
    )[0];
    if (!oldest) return;
    bindings.delete(oldest[0]);
  }
}

async function executeTool(
  record: BrowserSessionRecord,
  tool: BrowserToolName,
  rawArguments: BrowserJsonValue,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
    actor: "agent" | "user";
    showAgentCursor: boolean;
    navigationApproval: "always-ask" | "always-allow";
    interrupted: () => boolean;
    stopFromPage: (browserSessionId: string) => void;
  },
): Promise<BrowserToolResult> {
  const args = asRecord(rawArguments);
  let lease = record.lease;
  if (!lease) {
    if (tool === "close") {
      return success({
        finalized: true,
        retained: false,
        browserSessionId: record.id,
      });
    }
    if (tool !== "open")
      return failure("Open a URL before using this browser action.");
    lease = createLease(record, context);
    record.lease = lease;
  }
  if (lease.view.webContents.isDestroyed()) {
    record.lease = null;
    return failure(
      "The isolated browser renderer is unavailable; open the page again.",
    );
  }
  lease.navigationApproval = context.navigationApproval;
  if (tool === "close") {
    context.confirmations.clearSession(record.id);
    lease.actor = "user";
    lease.pointer = null;
    lease.action = null;
    lease.agentActivityUntil = 0;
    lease.workingOverlayVisible = false;
    lease.browserUseTurnId = null;
    await lease.view.webContents
      .executeJavaScript(
        `${agentPointerCleanupScript(lease.pointerOverlayId)};${agentWorkingOverlayScript(lease.workingOverlayId, false)}`,
        true,
      )
      .catch(() => undefined);
    publishState(context.options, record, "ready", tool);
    return success({
      finalized: true,
      retained: true,
      browserSessionId: record.id,
      url: lease.view.webContents.getURL(),
      title: lease.view.webContents.getTitle(),
    });
  }
  lease.actor = context.actor;
  if (context.actor === "user" && lease.pointer) {
    lease.pointer = null;
    void lease.view.webContents
      .executeJavaScript(
        agentPointerCleanupScript(lease.pointerOverlayId),
        true,
      )
      .catch(() => undefined);
  }
  lease.action = {
    sequence: ++lease.actionSequence,
    kind: tool,
    label: browserActionLabel(tool, rawArguments).slice(0, 160),
    startedAt: Date.now(),
  };
  if (context.actor === "agent") {
    lease.agentActivityUntil = Date.now() + AGENT_ACTIVITY_LINGER_MS;
  }
  recordTrace(lease, "tool", tool);
  publishState(context.options, record, "working", tool);
  assertBrowserActionNotInterrupted(context);

  switch (tool) {
    case "open": {
      resizeLease(lease, args.width, args.height);
      const url = normalizeWebUrl(requireString(args.url, "url"));
      if (
        !(await confirmBrowserNavigation(record, lease, context, url, tool))
      ) {
        return failure("Opening this website was denied by the user.");
      }
      lease.pendingUrl = url;
      publishState(context.options, record, "working", tool);
      const guardedNavigationSequence = lease.guardedNavigationSequence;
      let navigationError: unknown;
      try {
        await loadBrowserUrl(lease.view.webContents, url);
      } catch (error) {
        navigationError = error;
      } finally {
        lease.pendingUrl = null;
      }
      await waitForHostActions(lease);
      if (
        navigationError &&
        lease.guardedNavigationSequence === guardedNavigationSequence
      ) {
        throw navigationError;
      }
      assertBrowserActionNotInterrupted(context);
      await waitForUsefulPageContent(lease.view.webContents);
      assertBrowserActionNotInterrupted(context);
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "snapshot": {
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "click": {
      const ref = requireRef(args.ref);
      const inspectedUserInputGeneration = lease.userInputGeneration;
      const inspected = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectClickScript(lease.refAttribute, ref),
          true,
        ),
      );
      if (inspected.ok !== true) {
        return failure(String(inspected.error ?? "Click failed."));
      }
      enrichBrowserAction(
        lease,
        "click",
        browserElementActionLabel("click", String(inspected.safeLabel ?? "")),
      );
      publishState(context.options, record, "working", tool);
      const inspectedHref =
        typeof inspected.href === "string" ? inspected.href : null;
      const targetUrl = safeNormalizedWebUrl(inspectedHref);
      if (
        targetUrl &&
        new URL(targetUrl).origin !==
          new URL(normalizeWebUrl(lease.view.webContents.getURL())).origin &&
        !(await confirmBrowserNavigation(
          record,
          lease,
          context,
          targetUrl,
          tool,
        ))
      ) {
        return failure("Opening this website was denied by the user.");
      }
      const category = classifyBrowserClick({
        label: String(inspected.label ?? ""),
        tagName: String(inspected.tagName ?? ""),
        inputType: String(inspected.inputType ?? ""),
        submitsForm: inspected.submitsForm === true,
      });
      if (
        category &&
        !(await confirmBrowserAction(
          record,
          lease,
          context,
          category,
          String(inspected.label || "Submit information to this site"),
          tool,
        ))
      ) {
        return failure("The browser action was denied by the user.");
      }
      if (
        context.actor === "agent" &&
        !browserAgentActionStillOwnsPage(
          inspectedUserInputGeneration,
          lease.userInputGeneration,
        )
      ) {
        return failure(
          "The user took control of the browser; take a new snapshot before retrying.",
        );
      }
      lease.actor = context.actor;
      const preapprovedOrigin = targetUrl ? new URL(targetUrl).origin : null;
      if (preapprovedOrigin) {
        lease.preapprovedNavigationOrigin = preapprovedOrigin;
      }
      try {
        if (context.actor === "agent" && context.showAgentCursor) {
          await updateAgentPointer(
            lease,
            Number(inspected.x),
            Number(inspected.y),
            "click",
          );
          publishState(context.options, record, "working", tool);
          await delay(120);
        }
        const prepared = asRecord(
          await lease.view.webContents.executeJavaScript(
            prepareClickScript(lease.refAttribute, ref, inspectedHref),
            true,
          ),
        );
        if (prepared.ok !== true)
          return failure(String(prepared.error ?? "Click failed."));
        const clickX = Number(prepared.x);
        const clickY = Number(prepared.y);
        if (context.actor === "agent" && context.showAgentCursor) {
          await updateAgentPointer(lease, clickX, clickY, "click");
          publishState(context.options, record, "working", tool);
        }
        await dispatchAgentClick(lease, clickX, clickY, {
          refAttribute: lease.refAttribute,
          ref,
          inspectedHref,
        });
        await settleAfterAction(lease.view.webContents);
        assertBrowserActionNotInterrupted(context);
        await waitForHostActions(lease);
        assertBrowserActionNotInterrupted(context);
        const result = await snapshotResult(lease);
        assertBrowserActionNotInterrupted(context);
        publishState(context.options, record, "ready", tool);
        return result;
      } finally {
        if (lease.preapprovedNavigationOrigin === preapprovedOrigin) {
          lease.preapprovedNavigationOrigin = null;
        }
      }
    }
    case "type": {
      const ref = requireRef(args.ref);
      const text = requireString(args.text, "text");
      if (text.length > 20_000)
        return failure("Text exceeds 20,000 characters.");
      const inspectedUserInputGeneration = lease.userInputGeneration;
      const inspected = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectInputScript(lease.refAttribute, ref),
          true,
        ),
      );
      if (inspected.ok !== true) {
        return failure(String(inspected.error ?? "Typing failed."));
      }
      enrichBrowserAction(
        lease,
        "type",
        browserElementActionLabel("type", String(inspected.label ?? "")),
      );
      publishState(context.options, record, "working", tool);
      if (context.actor === "agent" && context.showAgentCursor) {
        await updateAgentPointer(
          lease,
          Number(inspected.x),
          Number(inspected.y),
          "type",
        );
        publishState(context.options, record, "working", tool);
        await delay(120);
      }
      assertBrowserActionNotInterrupted(context);
      const category = classifyBrowserInput(String(inspected.inputType ?? ""));
      if (category === "file-upload") {
        return failure("Use the browser upload tool for file inputs.");
      }
      if (
        category &&
        !(await confirmBrowserAction(
          record,
          lease,
          context,
          category,
          String(inspected.label || "Enter a password"),
          tool,
        ))
      ) {
        return failure("The browser action was denied by the user.");
      }
      if (
        context.actor === "agent" &&
        !browserAgentActionStillOwnsPage(
          inspectedUserInputGeneration,
          lease.userInputGeneration,
        )
      ) {
        return failure(
          "The user took control of the browser; take a new snapshot before retrying.",
        );
      }
      assertBrowserActionNotInterrupted(context);
      const currentInput = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectInputScript(lease.refAttribute, ref),
          true,
        ),
      );
      if (
        currentInput.ok !== true ||
        !browserInputTargetStillMatches(
          inputTargetFingerprint(inspected),
          inputTargetFingerprint(currentInput),
        )
      ) {
        return failure(
          "The input changed while browser approval was pending; take a new snapshot before retrying.",
        );
      }
      lease.actor = context.actor;
      const typed = asRecord(
        await lease.view.webContents.executeJavaScript(
          typeScript(
            lease.refAttribute,
            ref,
            text,
            args.clear !== false,
            category === "authentication",
          ),
          true,
        ),
      );
      if (typed.ok !== true)
        return failure(String(typed.error ?? "Typing failed."));
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "key": {
      const chord = parseBrowserKeyChord(requireString(args.key, "key"));
      if (!chord) {
        return failure(
          "Unsupported key. Use a named key such as Enter, Escape, Tab or ArrowDown, or one character, with optional Shift/Control/Alt/Meta.",
        );
      }
      const ref = args.ref === undefined ? null : requireRef(args.ref);
      const inspectedUserInputGeneration = lease.userInputGeneration;
      const focused = asRecord(
        await lease.view.webContents.executeJavaScript(
          focusForKeyScript(lease.refAttribute, ref),
          true,
        ),
      );
      if (focused.ok !== true) {
        return failure(String(focused.error ?? "The key could not be sent."));
      }
      if (
        chord.text &&
        chord.keyCode !== "Enter" &&
        focused.password === true
      ) {
        return failure("Use the browser type tool for password fields.");
      }
      if (ref && context.actor === "agent" && context.showAgentCursor) {
        await updateAgentPointer(
          lease,
          Number(focused.x),
          Number(focused.y),
          "type",
        );
        publishState(context.options, record, "working", tool);
      }
      const keyTarget = browserKeyTarget(focused);
      const risk = classifyBrowserKey(chord.keyCode, keyTarget);
      if (
        risk &&
        !(await confirmBrowserAction(
          record,
          lease,
          context,
          risk.category,
          risk.label,
          tool,
        ))
      ) {
        return failure("The browser action was denied by the user.");
      }
      if (
        context.actor === "agent" &&
        !browserAgentActionStillOwnsPage(
          inspectedUserInputGeneration,
          lease.userInputGeneration,
        )
      ) {
        return failure(
          "The user took control of the browser; take a new snapshot before retrying.",
        );
      }
      if (risk) {
        assertBrowserActionNotInterrupted(context);
        const current = asRecord(
          await lease.view.webContents.executeJavaScript(
            focusForKeyScript(lease.refAttribute, ref),
            true,
          ),
        );
        if (
          current.ok !== true ||
          !sameBrowserKeyTarget(keyTarget, browserKeyTarget(current))
        ) {
          return failure(
            "The focused element changed while browser approval was pending; take a new snapshot before retrying.",
          );
        }
      }
      await preparePageForAgent(lease.view.webContents);
      assertBrowserActionNotInterrupted(context);
      lease.actor = context.actor;
      lease.agentInputDepth += 1;
      try {
        const contents = lease.view.webContents;
        contents.sendInputEvent({
          type: "keyDown",
          keyCode: chord.keyCode,
          modifiers: chord.modifiers,
        });
        if (chord.text) {
          contents.sendInputEvent({
            type: "char",
            keyCode: chord.text,
            modifiers: chord.modifiers,
          });
        }
        contents.sendInputEvent({
          type: "keyUp",
          keyCode: chord.keyCode,
          modifiers: chord.modifiers,
        });
        await delay(30);
      } finally {
        lease.agentInputDepth = Math.max(0, lease.agentInputDepth - 1);
      }
      await settleAfterAction(lease.view.webContents);
      assertBrowserActionNotInterrupted(context);
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "select": {
      const ref = requireRef(args.ref);
      const value =
        args.value === undefined ? null : requireString(args.value, "value");
      const label =
        args.label === undefined ? null : requireString(args.label, "label");
      if (value === null && label === null) {
        return failure("Choose an option by value or label.");
      }
      const selected = asRecord(
        await lease.view.webContents.executeJavaScript(
          selectOptionScript(lease.refAttribute, ref, value, label),
          true,
        ),
      );
      if (selected.ok !== true) {
        return failure(String(selected.error ?? "Choosing an option failed."));
      }
      if (context.actor === "agent" && context.showAgentCursor) {
        await updateAgentPointer(
          lease,
          Number(selected.x),
          Number(selected.y),
          "click",
        );
        publishState(context.options, record, "working", tool);
      }
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "wait": {
      const text =
        args.text === undefined
          ? null
          : requireString(args.text, "text").slice(0, 500);
      const seconds =
        args.seconds === undefined ? (text ? 10 : 1) : Number(args.seconds);
      if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 10) {
        return failure("Wait between 0.1 and 10 seconds.");
      }
      const deadline = Date.now() + Math.round(seconds * 1_000);
      let found = text === null;
      while (Date.now() < deadline) {
        assertBrowserActionNotInterrupted(context);
        if (text !== null) {
          found = await lease.view.webContents
            .executeJavaScript(
              `(document.body?.innerText || "").includes(${JSON.stringify(text)})`,
              true,
            )
            .then((value) => value === true)
            .catch(() => false);
          if (found) break;
        }
        await delay(Math.max(0, Math.min(250, deadline - Date.now())));
      }
      assertBrowserActionNotInterrupted(context);
      if (!found) {
        publishState(context.options, record, "ready", tool);
        return failure(
          `The text did not appear within ${seconds} seconds; take a new snapshot.`,
        );
      }
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "scroll": {
      const x =
        args.x === undefined ? 0 : boundedInteger(args.x, "x", -10_000, 10_000);
      const y =
        args.y === undefined ? 0 : boundedInteger(args.y, "y", -10_000, 10_000);
      if (x === 0 && y === 0) {
        return failure("Scroll requires a non-zero x or y distance.");
      }
      if (context.actor === "agent" && context.showAgentCursor) {
        await updateAgentPointer(
          lease,
          lease.viewport.width - 36,
          Math.round(lease.viewport.height / 2),
          "scroll",
        );
        publishState(context.options, record, "working", tool);
      }
      await lease.view.webContents.executeJavaScript(
        `window.scrollBy({left:${JSON.stringify(x)},top:${JSON.stringify(y)},behavior:${JSON.stringify(agentScrollAnimates(lease))}&&!matchMedia("(prefers-reduced-motion: reduce)").matches?"smooth":"instant"});true`,
        true,
      );
      await delay(360);
      assertBrowserActionNotInterrupted(context);
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "upload": {
      const ref = requireRef(args.ref);
      const inspectedUserInputGeneration = lease.userInputGeneration;
      const inspected = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectInputScript(lease.refAttribute, ref),
          true,
        ),
      );
      if (inspected.ok !== true || inspected.inputType !== "file") {
        return failure(
          String(
            inspected.error ??
              "The selected element is not a file input; take a new snapshot.",
          ),
        );
      }
      enrichBrowserAction(
        lease,
        "upload",
        browserElementActionLabel("upload", String(inspected.label ?? "")),
      );
      publishState(context.options, record, "working", tool);
      if (context.actor === "agent" && context.showAgentCursor) {
        await updateAgentPointer(
          lease,
          Number(inspected.x),
          Number(inspected.y),
          "click",
        );
        publishState(context.options, record, "working", tool);
      }
      const upload = await stageBrowserUpload({
        requestedPath: requireString(args.path, "path"),
        workspaceRoot: record.canonicalWorkspaceRoot,
        root: context.options.artifactRoot,
        browserSessionId: record.id,
      });
      if (context.interrupted()) {
        await discardStagedBrowserUpload(upload);
        throw browserError("Browser work was stopped by the user.");
      }
      const label = `${String(inspected.label || "Choose file")}: ${upload.name} (${upload.size} bytes)`;
      let allowed: boolean;
      try {
        allowed = await confirmBrowserAction(
          record,
          lease,
          context,
          "file-upload",
          label,
          tool,
        );
      } catch (error) {
        await discardStagedBrowserUpload(upload);
        throw error;
      }
      if (!allowed) {
        await discardStagedBrowserUpload(upload);
        return failure("The browser file upload was denied by the user.");
      }
      if (
        context.actor === "agent" &&
        !browserAgentActionStillOwnsPage(
          inspectedUserInputGeneration,
          lease.userInputGeneration,
        )
      ) {
        await discardStagedBrowserUpload(upload);
        return failure(
          "The user took control of the browser; take a new snapshot before retrying.",
        );
      }
      assertBrowserActionNotInterrupted(context);
      const currentInput = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectInputScript(lease.refAttribute, ref),
          true,
        ),
      );
      if (
        currentInput.ok !== true ||
        !browserInputTargetStillMatches(
          inputTargetFingerprint(inspected),
          inputTargetFingerprint(currentInput),
        )
      ) {
        await discardStagedBrowserUpload(upload);
        return failure(
          "The file input changed while browser approval was pending; take a new snapshot before retrying.",
        );
      }
      lease.actor = context.actor;
      try {
        await setFileInput(
          lease.view.webContents,
          lease.refAttribute,
          ref,
          upload.path,
        );
      } catch (error) {
        await discardStagedBrowserUpload(upload);
        throw error;
      }
      if (context.interrupted()) {
        await discardStagedBrowserUpload(upload);
        throw browserError("Browser work was stopped by the user.");
      }
      lease.stagedUploads.push(upload);
      while (lease.stagedUploads.length > MAX_STAGED_UPLOADS) {
        const expired = lease.stagedUploads.shift();
        if (expired) await discardStagedBrowserUpload(expired);
      }
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "resize": {
      resizeLease(lease, args.width, args.height, true);
      const result = await snapshotResult(lease);
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "back":
      if (lease.view.webContents.navigationHistory.canGoBack()) {
        lease.view.webContents.navigationHistory.goBack();
      }
      await settleAfterAction(lease.view.webContents);
      assertBrowserActionNotInterrupted(context);
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      {
        const result = await snapshotResult(lease);
        assertBrowserActionNotInterrupted(context);
        publishState(context.options, record, "ready", tool);
        return result;
      }
    case "forward":
      if (lease.view.webContents.navigationHistory.canGoForward()) {
        lease.view.webContents.navigationHistory.goForward();
      }
      await settleAfterAction(lease.view.webContents);
      assertBrowserActionNotInterrupted(context);
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      {
        const result = await snapshotResult(lease);
        assertBrowserActionNotInterrupted(context);
        publishState(context.options, record, "ready", tool);
        return result;
      }
    case "reload":
      lease.view.webContents.reload();
      await settleAfterAction(lease.view.webContents);
      assertBrowserActionNotInterrupted(context);
      await waitForHostActions(lease);
      assertBrowserActionNotInterrupted(context);
      {
        const result = await snapshotResult(lease);
        assertBrowserActionNotInterrupted(context);
        publishState(context.options, record, "ready", tool);
        return result;
      }
    case "screenshot": {
      const annotations = parseBrowserAnnotations(args.annotations);
      const result = await screenshotResult(
        lease,
        context.options.artifactRoot,
        record.id,
        annotations,
        context.interrupted,
      );
      assertBrowserActionNotInterrupted(context);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "trace": {
      assertBrowserActionNotInterrupted(context);
      const artifact = await persistBrowserTrace({
        root: context.options.artifactRoot,
        browserSessionId: record.id,
        events: lease.trace,
        url: normalizeWebUrl(lease.view.webContents.getURL()),
        title: lease.view.webContents.getTitle(),
      });
      if (context.interrupted()) {
        await unlink(artifact.path).catch(() => undefined);
        throw browserError("Browser work was stopped by the user.");
      }
      publishState(context.options, record, "ready", tool);
      return success({ artifact });
    }
    default:
      return failure(`Unsupported Zeros browser tool: ${String(tool)}`);
  }
}

function assertBrowserActionNotInterrupted(context: {
  interrupted: () => boolean;
}): void {
  if (context.interrupted())
    throw browserError("Browser work was stopped by the user.");
}

function createLease(
  record: BrowserSessionRecord,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
    actor: "agent" | "user";
    showAgentCursor: boolean;
    navigationApproval: "always-ask" | "always-allow";
    interrupted: () => boolean;
    stopFromPage: (browserSessionId: string) => void;
  },
): BrowserLease {
  const domMarkers = browserDomMarkers(randomBytes(12).toString("hex"));
  const partition = `zeros-browser-${createHash("sha256")
    .update(record.id)
    .digest("hex")
    .slice(0, 24)}-${randomBytes(6).toString("hex")}`;
  // The partition is already memory-only (no `persist:` prefix). Keeping
  // Chromium's in-memory cache enabled avoids ERR_CACHE_MISS for fonts and
  // redirects while storage and cache are still cleared when the lease dies.
  const browserSession = session.fromPartition(partition);
  const view = new WebContentsView({
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
      disableDialogs: true,
      backgroundThrottling: false,
    },
  });
  rendererProcessOwners.track(view.webContents, "Browser tab");
  const parkingWindow = new BaseWindow({
    show: false,
    width: 1_440,
    height: 1_000,
  });
  parkingWindow.contentView.addChildView(view);
  // No view background color: Electron also paints it behind pages that set
  // no background of their own, so a dark color left them black-on-black.
  view.setBounds({ x: 0, y: 0, width: 1_440, height: 1_000 });
  view.webContents.setAudioMuted(true);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const lease: BrowserLease = {
    view,
    parkingWindow,
    attachedTo: parkingWindow,
    browserSession,
    viewport: { width: 1_440, height: 1_000 },
    sourceViewport: { width: 1_440, height: 1_000 },
    displayTitle: "Browser",
    pendingDisplayTitle: null,
    displayTitleGeneration: 0,
    displayTitleTimer: null,
    actor: context.actor,
    pointer: null,
    faviconDataUrl: null,
    faviconOrigin: null,
    faviconGeneration: 0,
    faviconResolvingGeneration: null,
    actionSequence: 0,
    action: null,
    agentActivityUntil: 0,
    navigationApproval: context.navigationApproval,
    preapprovedNavigationOrigin: null,
    guardedNavigationUrl: null,
    guardedNavigationSequence: 0,
    pendingUrl: null,
    status: "ready",
    currentTool: undefined,
    confirmationDepth: 0,
    userInputGeneration: 0,
    agentInputDepth: 0,
    refAttribute: domMarkers.refAttribute,
    pointerOverlayId: domMarkers.pointerId,
    annotationOverlayId: domMarkers.annotationId,
    workingOverlayId: `${domMarkers.pointerId}-working`,
    workingOverlayVisible: false,
    surfaceHovered: false,
    surfaceId: null,
    consoleErrors: [],
    networkErrors: [],
    downloads: [],
    activeDownloads: new Set(),
    stagedUploads: [],
    codexApprovedDownloadUrl: null,
    codexTabDisposition: null,
    pendingHostActions: new Set(),
    hostActionFailures: [],
    trace: [],
    disposeNetworkHandlers: () => undefined,
    disposePermissionHandlers: () => undefined,
    disposeDownloadHandler: () => undefined,
    browserUseReady: null,
    browserUseSocket: null,
    browserUseTurnId: null,
    disposeBrowserUseDebugger: NOOP,
    appearance: createBrowserAppearanceController({
      debugger: view.webContents.debugger,
      isAlive: () => !view.webContents.isDestroyed(),
    }),
  };
  if (record.appearance) void lease.appearance.set(record.appearance);

  const navigationDetail = (
    event: Electron.Event & {
      url?: string;
      isMainFrame?: boolean;
    },
    legacyUrl?: string,
    legacyIsMainFrame?: boolean,
  ) => ({
    url: event.url ?? legacyUrl ?? "",
    isMainFrame: event.isMainFrame ?? legacyIsMainFrame ?? true,
  });
  const guardTopLevelNavigation = (
    event: Electron.Event & { url?: string; isMainFrame?: boolean },
    legacyUrl?: string,
    _legacyIsInPlace?: boolean,
    legacyIsMainFrame?: boolean,
  ) => {
    const { url: rawUrl, isMainFrame } = navigationDetail(
      event,
      legacyUrl,
      legacyIsMainFrame,
    );
    if (!isMainFrame) return;
    if (rawUrl === "about:blank") return;
    const url = safeNormalizedWebUrl(rawUrl);
    if (!url) {
      event.preventDefault();
      return;
    }
    const targetOrigin = new URL(url).origin;
    const disposition = browserAgentNavigationDisposition({
      actor: lease.actor,
      currentOrigin: safeWebOrigin(
        lease.pendingUrl || view.webContents.getURL(),
      ),
      targetOrigin,
      isMainFrame,
      navigationApproval: lease.navigationApproval,
      siteAllowed: context.confirmations.isSiteAllowed(
        record.id,
        targetOrigin,
        "navigation",
        "open-site",
      ),
      preapprovedOrigin: lease.preapprovedNavigationOrigin,
      officialProviderOwnsOriginApproval: lease.browserUseTurnId !== null,
    });
    if (disposition === "allow") return;
    event.preventDefault();
    if (lease.guardedNavigationUrl === url) return;
    const guarded = runGuardedBrowserNavigation(record, lease, url, context);
    trackHostAction(lease, guarded, record.activeOperations > 0);
  };
  view.webContents.on("will-redirect", guardTopLevelNavigation);
  view.webContents.on("will-navigate", guardTopLevelNavigation);

  view.webContents.on("console-message", (details) => {
    if (details.level !== "warning" && details.level !== "error") return;
    const detail = `${details.level}: ${details.message}`
      .replace(/[\r\n]+/g, " ")
      .slice(0, 1_000);
    appendBounded(lease.consoleErrors, detail, 50);
    recordTrace(lease, "console", detail);
  });
  const publishNavigation = () => {
    if (record.lease !== lease || lease.view.webContents.isDestroyed()) return;
    recordTrace(
      lease,
      "navigation",
      redactDiagnosticUrl(view.webContents.getURL()),
    );
    publishState(
      context.options,
      record,
      browserNavigationPublishStatus({
        currentStatus: lease.status,
        activeOperations: record.activeOperations,
      }),
      lease.currentTool,
    );
  };
  const scheduleDisplayTitle = (title: string) => {
    const queued = queueBrowserTitleCandidate(
      {
        confirmed: lease.displayTitle,
        pending: lease.pendingDisplayTitle,
        generation: lease.displayTitleGeneration,
      },
      title,
    );
    if (queued.generation === lease.displayTitleGeneration) return;
    lease.pendingDisplayTitle = queued.pending;
    lease.displayTitleGeneration = queued.generation;
    const generation = queued.generation;
    if (lease.displayTitleTimer) clearTimeout(lease.displayTitleTimer);
    lease.displayTitleTimer = setTimeout(() => {
      lease.displayTitleTimer = null;
      if (
        record.lease !== lease ||
        view.webContents.isDestroyed() ||
        view.webContents.isLoading()
      ) {
        return;
      }
      const committed = commitBrowserTitleCandidate(
        {
          confirmed: lease.displayTitle,
          pending: lease.pendingDisplayTitle,
          generation: lease.displayTitleGeneration,
        },
        generation,
        view.webContents.isLoading(),
      );
      const changed = committed.confirmed !== lease.displayTitle;
      lease.displayTitle = committed.confirmed;
      lease.pendingDisplayTitle = committed.pending;
      if (changed) publishNavigation();
    }, BROWSER_TITLE_SETTLE_MS);
  };
  const publishCommittedNavigation = () => {
    if (record.lease !== lease || view.webContents.isDestroyed()) return;
    lease.pendingUrl = null;
    publishNavigation();
  };
  view.webContents.on("did-start-loading", publishNavigation);
  view.webContents.on("did-navigate", publishCommittedNavigation);
  view.webContents.on("did-navigate-in-page", publishCommittedNavigation);
  view.webContents.on(
    "did-fail-load",
    (_event, _errorCode, _errorDescription, _validatedUrl, isMainFrame) => {
      if (!isMainFrame || record.lease !== lease) return;
      lease.pendingUrl = null;
      publishNavigation();
    },
  );
  view.webContents.on("page-title-updated", (_event, title) => {
    if (record.lease !== lease) return;
    scheduleDisplayTitle(title);
  });
  view.webContents.on("did-stop-loading", () => {
    if (record.lease !== lease || view.webContents.isDestroyed()) return;
    scheduleDisplayTitle(
      lease.pendingDisplayTitle ?? view.webContents.getTitle(),
    );
    publishNavigation();
    if (
      !browserFaviconFallbackNeeded({
        hasFavicon: Boolean(lease.faviconDataUrl),
        currentGeneration: lease.faviconGeneration,
        resolvingGeneration: lease.faviconResolvingGeneration,
      })
    ) {
      return;
    }
    const generation = ++lease.faviconGeneration;
    lease.faviconResolvingGeneration = generation;
    const pageUrl = view.webContents.getURL();
    void resolveBrowserFavicon(
      browserSession,
      orderedBrowserFaviconCandidates(pageUrl),
      pageUrl,
    ).then((favicon) => {
      if (lease.faviconResolvingGeneration === generation) {
        lease.faviconResolvingGeneration = null;
      }
      if (
        !favicon ||
        record.lease !== lease ||
        generation !== lease.faviconGeneration ||
        lease.view.webContents.isDestroyed()
      ) {
        return;
      }
      lease.faviconDataUrl = favicon;
      lease.faviconOrigin = safeWebOrigin(view.webContents.getURL());
      publishState(context.options, record, lease.status, lease.currentTool);
    });
  });
  view.webContents.on("dom-ready", () => {
    if (record.lease !== lease || lease.actor !== "agent") return;
    void lease.view.webContents
      .executeJavaScript(
        `${agentWorkingOverlayScript(
          lease.workingOverlayId,
          true,
        )};${lease.pointer ? agentPointerOverlayScript(lease.pointerOverlayId, lease.pointer) : ""}`,
        true,
      )
      .catch(() => undefined);
  });
  view.webContents.on(
    "did-start-navigation",
    (event, legacyUrl, legacyIsInPlace, legacyIsMainFrame) => {
      const isMainFrame = event.isMainFrame ?? legacyIsMainFrame ?? true;
      const isSameDocument = event.isSameDocument ?? legacyIsInPlace ?? false;
      const targetUrl = event.url ?? legacyUrl ?? "";
      if (!isMainFrame || record.lease !== lease) return;
      if (lease.displayTitleTimer) {
        clearTimeout(lease.displayTitleTimer);
        lease.displayTitleTimer = null;
      }
      const cancelled = cancelBrowserTitleCandidate({
        confirmed: lease.displayTitle,
        pending: lease.pendingDisplayTitle,
        generation: lease.displayTitleGeneration,
      });
      lease.pendingDisplayTitle = cancelled.pending;
      lease.displayTitleGeneration = cancelled.generation;
      if (
        browserFaviconNavigationDisposition({
          currentOrigin: lease.faviconOrigin,
          targetUrl,
          isMainFrame,
          isSameDocument,
        }) === "reset"
      ) {
        lease.faviconGeneration += 1;
        lease.faviconResolvingGeneration = null;
        lease.faviconDataUrl = null;
        lease.faviconOrigin = null;
      }
    },
  );
  view.webContents.on("page-favicon-updated", (_event, faviconUrls) => {
    if (record.lease !== lease) return;
    const generation = ++lease.faviconGeneration;
    lease.faviconResolvingGeneration = generation;
    const pageUrl = view.webContents.getURL();
    void resolveBrowserFavicon(
      browserSession,
      orderedBrowserFaviconCandidates(pageUrl, faviconUrls),
      pageUrl,
    ).then((favicon) => {
      if (lease.faviconResolvingGeneration === generation) {
        lease.faviconResolvingGeneration = null;
      }
      if (
        !favicon ||
        record.lease !== lease ||
        generation !== lease.faviconGeneration ||
        lease.view.webContents.isDestroyed()
      ) {
        return;
      }
      lease.faviconDataUrl = favicon;
      lease.faviconOrigin = safeWebOrigin(pageUrl);
      publishState(context.options, record, lease.status, lease.currentTool);
    });
  });
  const markSurfaceHover = (
    _event: Electron.Event,
    mouse: Electron.MouseInputEvent,
  ) => {
    if (record.lease !== lease || lease.attachedTo === lease.parkingWindow)
      return;
    const hovered = mouse.type !== "mouseLeave";
    if (lease.surfaceHovered === hovered) return;
    lease.surfaceHovered = hovered;
    publishState(context.options, record, lease.status, lease.currentTool);
  };
  // Direct page input is locked for the whole provider-owned browser turn, so
  // this handler only ever blocks or steps aside — a page gesture is never a
  // takeover. Ownership returns to the user through the handoff paths that
  // publish `actor: "user"`: native finalize/turnEnded, Stop, and the semantic
  // `close` tool.
  const guardDirectPageInput = (event: Electron.Event) => {
    if (record.lease !== lease || lease.attachedTo === lease.parkingWindow) {
      return;
    }
    const disposition = browserInputDisposition({
      actor: lease.actor,
      agentDispatched: lease.agentInputDepth > 0,
    });
    if (disposition === "block") event.preventDefault();
  };
  const guardDirectPageKeys = (event: Electron.Event, input: Electron.Input) => {
    if (
      record.lease === lease &&
      lease.attachedTo !== lease.parkingWindow &&
      browserInputStopsAgent({
        actor: lease.actor,
        agentDispatched: lease.agentInputDepth > 0,
        type: input.type,
        key: input.key,
        meta: input.meta,
        control: input.control,
        alt: input.alt,
        zerosBrowser: context.options.zerosBrowserAvailable?.() ?? true,
      })
    ) {
      event.preventDefault();
      context.stopFromPage(record.id);
      return;
    }
    guardDirectPageInput(event);
  };
  view.webContents.on("before-input-event", guardDirectPageKeys);
  view.webContents.on("before-mouse-event", markSurfaceHover);
  view.webContents.on("before-mouse-event", guardDirectPageInput);
  view.webContents.on("render-process-gone", (_event, details) => {
    if (record.lease !== lease) return;
    recordTrace(
      lease,
      "renderer-crash",
      `${details.reason}:${details.exitCode}`,
    );
    context.confirmations.clearSession(record.id);
    record.lease = null;
    publishState(context.options, record, "closed", "renderer-crash");
    void destroyLease(lease);
  });

  lease.disposeNetworkHandlers = installNetworkHandlers(browserSession, lease);
  lease.disposePermissionHandlers = installPermissionHandlers(
    browserSession,
    record,
    lease,
    context,
  );
  const onDownload = (
    _event: Electron.Event,
    item: DownloadItem,
    contents: WebContents,
  ) => {
    if (contents !== view.webContents) {
      item.cancel();
      return;
    }
    lease.activeDownloads.add(item);
    trackHostAction(
      lease,
      handleBrowserDownload(record, lease, item, context).finally(() =>
        lease.activeDownloads.delete(item),
      ),
      record.activeOperations > 0,
    );
  };
  browserSession.on("will-download", onDownload);
  lease.disposeDownloadHandler = () =>
    browserSession.off("will-download", onDownload);
  return lease;
}

function installNetworkHandlers(
  browserSession: Session,
  lease: BrowserLease,
): () => void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  browserSession.webRequest.onErrorOccurred(filter, (details) => {
    if (details.webContentsId !== lease.view.webContents.id) return;
    const detail = `${details.error || "Network request failed"} ${redactDiagnosticUrl(details.url)}`;
    appendBounded(lease.networkErrors, detail, 50);
    recordTrace(lease, "network", detail);
  });
  browserSession.webRequest.onCompleted(filter, (details) => {
    if (
      details.webContentsId !== lease.view.webContents.id ||
      details.statusCode < 400
    )
      return;
    const detail = `HTTP ${details.statusCode} ${redactDiagnosticUrl(details.url)}`;
    appendBounded(lease.networkErrors, detail, 50);
    recordTrace(lease, "network", detail);
  });
  return () => {
    browserSession.webRequest.onErrorOccurred(null);
    browserSession.webRequest.onCompleted(null);
  };
}

function installPermissionHandlers(
  browserSession: Session,
  record: BrowserSessionRecord,
  lease: BrowserLease,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
  },
): () => void {
  browserSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) => {
      const origin = safeWebOrigin(requestingOrigin);
      return Boolean(
        origin &&
        context.confirmations.isSiteAllowed(
          record.id,
          origin,
          "browser-permission",
          permission,
        ),
      );
    },
  );
  browserSession.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (
        contents !== lease.view.webContents ||
        permission === "unknown" ||
        permission === "openExternal" ||
        permission === "fileSystem"
      ) {
        callback(false);
        return;
      }
      trackHostAction(
        lease,
        handleBrowserPermission(
          record,
          lease,
          permission,
          details.requestingUrl,
          callback,
          context,
        ),
        record.activeOperations > 0,
      );
    },
  );
  return () => {
    browserSession.setPermissionCheckHandler(null);
    browserSession.setPermissionRequestHandler(null);
  };
}

async function handleBrowserPermission(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  permission: string,
  requestingUrl: string,
  callback: (permissionGranted: boolean) => void,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
  },
): Promise<void> {
  const interruptionGeneration = record.interruptionGeneration;
  let url: string;
  try {
    url = normalizeWebUrl(requestingUrl || lease.view.webContents.getURL());
  } catch {
    callback(false);
    return;
  }
  const origin = new URL(url).origin;
  if (
    context.confirmations.isSiteAllowed(
      record.id,
      origin,
      "browser-permission",
      permission,
    )
  ) {
    callback(
      record.lease === lease &&
        record.interruptionGeneration === interruptionGeneration,
    );
    return;
  }
  beginBrowserConfirmation(record, lease, context.options, "permission");
  let allowed = false;
  try {
    const decision = await context.confirmations.confirm({
      browserSessionId: record.id,
      workspaceId: record.owner.workspaceId,
      conversationId: record.owner.conversationId,
      category: "browser-permission",
      scope: permission,
      origin,
      url,
      label: `Allow ${permissionLabel(permission)} for ${origin}`,
    });
    recordTrace(lease, "permission", `${permission}:${decision}`);
    allowed =
      decision !== "deny" &&
      record.lease === lease &&
      record.interruptionGeneration === interruptionGeneration;
  } finally {
    callback(allowed);
    endBrowserConfirmation(record, lease, context.options, "permission");
  }
}

async function handleBrowserDownload(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  item: DownloadItem,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
  },
): Promise<void> {
  const interruptionGeneration = record.interruptionGeneration;
  let url: string;
  try {
    url = normalizeWebUrl(item.getURL());
  } catch {
    item.cancel();
    return;
  }
  const target = allocateBrowserDownload({
    root: context.options.artifactRoot,
    browserSessionId: record.id,
    suggestedFilename: item.getFilename(),
  });
  item.setSavePath(target.path);
  item.pause();
  const advertisedBytes = item.getTotalBytes();
  if (advertisedBytes > MAX_DOWNLOAD_BYTES) {
    item.cancel();
    await unlink(target.path).catch(() => undefined);
    return;
  }
  const origin = new URL(url).origin;
  let disposeCompletion = () => undefined;
  const completed = new Promise<boolean>((resolve) => {
    const onUpdated = () => {
      if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) item.cancel();
    };
    const onDone = (_event: Electron.Event, state: string) => {
      disposeCompletion();
      resolve(state === "completed");
    };
    disposeCompletion = () => {
      item.off("updated", onUpdated);
      item.off("done", onDone);
    };
    item.on("updated", onUpdated);
    item.once("done", onDone);
  });
  const nativeAuthorization = consumeCodexDownloadAuthorization(
    lease.codexApprovedDownloadUrl,
    url,
  );
  lease.codexApprovedDownloadUrl = nativeAuthorization.remaining;
  let decision: BrowserConfirmationDecision = nativeAuthorization.authorized
    ? "allow-once"
    : "deny";
  if (!nativeAuthorization.authorized) {
    beginBrowserConfirmation(record, lease, context.options, "download");
    try {
      decision = await context.confirmations.confirm({
        browserSessionId: record.id,
        workspaceId: record.owner.workspaceId,
        conversationId: record.owner.conversationId,
        category: "download",
        origin,
        url,
        label: `Download ${item.getFilename() || "file"} from ${origin}`,
      });
    } catch (error) {
      item.cancel();
      disposeCompletion();
      await unlink(target.path).catch(() => undefined);
      throw error;
    } finally {
      endBrowserConfirmation(
        record,
        lease,
        context.options,
        "download",
        decision === "deny" ? "ready" : "working",
      );
    }
  }
  recordTrace(lease, "download", `${item.getFilename()}:${decision}`);
  if (
    decision === "deny" ||
    record.lease !== lease ||
    record.interruptionGeneration !== interruptionGeneration
  ) {
    item.cancel();
    await unlink(target.path).catch(() => undefined);
    disposeCompletion();
    return;
  }
  item.resume();
  let completedSuccessfully = false;
  try {
    completedSuccessfully = await withTimeout(
      completed,
      DOWNLOAD_TIMEOUT_MS,
      "Browser download timed out.",
    );
  } catch {
    item.cancel();
  } finally {
    disposeCompletion();
  }
  if (
    !completedSuccessfully ||
    record.lease !== lease ||
    record.interruptionGeneration !== interruptionGeneration
  ) {
    item.cancel();
    await unlink(target.path).catch(() => undefined);
    publishState(context.options, record, "ready", "download");
    return;
  }
  lease.downloads.push({
    kind: "browser-download",
    path: target.path,
    name: target.name,
    mimeType: item.getMimeType() || "application/octet-stream",
    size: item.getReceivedBytes(),
    url: redactDiagnosticUrl(url),
    downloadedAt: Date.now(),
  });
  while (lease.downloads.length > 40) {
    const expired = lease.downloads.shift();
    if (expired) await unlink(expired.path).catch(() => undefined);
  }
  await pruneBrowserDownloads(context.options.artifactRoot, record.id).catch(
    () => undefined,
  );
  publishState(context.options, record, "ready", "download");
}

async function confirmBrowserAction(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
  },
  category: BrowserRiskCategory,
  label: string,
  tool: BrowserToolName,
): Promise<boolean> {
  const url = normalizeWebUrl(lease.view.webContents.getURL());
  beginBrowserConfirmation(record, lease, context.options, tool);
  let decision: BrowserConfirmationDecision = "deny";
  try {
    decision = await context.confirmations.confirm({
      browserSessionId: record.id,
      workspaceId: record.owner.workspaceId,
      conversationId: record.owner.conversationId,
      category,
      origin: new URL(url).origin,
      url,
      label,
    });
    recordTrace(lease, "confirmation", `${category}:${decision}`);
  } finally {
    endBrowserConfirmation(
      record,
      lease,
      context.options,
      tool,
      decision === "deny" ? "ready" : "working",
    );
  }
  return decision !== "deny";
}

/** Website access is its own permission. For the retained trusted semantic
 * executor, “Always allow” skips only this navigation gate; payments,
 * publishing, uploads, and other consequences still flow through
 * confirmBrowserAction. Provider-native Codex semantic policy remains owned by
 * OpenAI's Browser skill. User-authored URL-bar navigation is an explicit
 * direct gesture and does not ask the user to approve themselves. */
async function confirmBrowserNavigation(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
    actor: "agent" | "user";
    navigationApproval: "always-ask" | "always-allow";
  },
  targetUrl: string,
  tool: BrowserToolName,
): Promise<boolean> {
  if (context.actor === "user" || context.navigationApproval === "always-allow")
    return true;
  const url = normalizeWebUrl(targetUrl);
  const origin = new URL(url).origin;
  if (
    context.confirmations.isSiteAllowed(
      record.id,
      origin,
      "navigation",
      "open-site",
    )
  ) {
    return true;
  }
  beginBrowserConfirmation(record, lease, context.options, tool);
  let decision: BrowserConfirmationDecision = "deny";
  try {
    decision = await context.confirmations.confirm({
      browserSessionId: record.id,
      workspaceId: record.owner.workspaceId,
      conversationId: record.owner.conversationId,
      category: "navigation",
      scope: "open-site",
      origin,
      url,
      label: `Allow Browser use to access ${origin}?`,
    });
    recordTrace(lease, "confirmation", `navigation:${decision}`);
  } finally {
    endBrowserConfirmation(
      record,
      lease,
      context.options,
      tool,
      decision === "deny" ? "ready" : "working",
    );
  }
  return decision !== "deny";
}

/** Page-authored top-level navigation (forms, scripted redirects, buttons)
 * has no href the host can safely approve before the click. Cancel it at the
 * Electron boundary, reuse the inline website Permission card, then replay the
 * exact normalized URL through the host only after approval. */
async function runGuardedBrowserNavigation(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  url: string,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
  },
): Promise<void> {
  const normalizedUrl = normalizeWebUrl(url);
  const targetOrigin = new URL(normalizedUrl).origin;
  const interruptionGeneration = record.interruptionGeneration;
  const previousPreapproval = lease.preapprovedNavigationOrigin;
  lease.guardedNavigationSequence += 1;
  lease.guardedNavigationUrl = normalizedUrl;
  const tool = isBrowserToolName(lease.currentTool)
    ? lease.currentTool
    : "click";
  try {
    const allowed = await confirmBrowserNavigation(
      record,
      lease,
      {
        options: context.options,
        confirmations: context.confirmations,
        actor: lease.actor,
        navigationApproval: lease.navigationApproval,
      },
      normalizedUrl,
      tool,
    );
    if (!allowed) {
      throw browserError("Opening this website was denied by the user.");
    }
    if (
      record.interruptionGeneration !== interruptionGeneration ||
      record.lease !== lease ||
      lease.view.webContents.isDestroyed()
    ) {
      throw browserError("Browser work was stopped by the user.");
    }
    lease.preapprovedNavigationOrigin = targetOrigin;
    lease.pendingUrl = normalizedUrl;
    publishState(context.options, record, "working", tool);
    try {
      await loadBrowserUrl(lease.view.webContents, normalizedUrl);
      if (record.interruptionGeneration !== interruptionGeneration) {
        throw browserError("Browser work was stopped by the user.");
      }
      await waitForUsefulPageContent(lease.view.webContents);
    } finally {
      lease.pendingUrl = null;
    }
  } finally {
    if (lease.guardedNavigationUrl === normalizedUrl) {
      lease.guardedNavigationUrl = null;
    }
    if (lease.preapprovedNavigationOrigin === targetOrigin) {
      lease.preapprovedNavigationOrigin = previousPreapproval;
    }
    if (
      record.lease === lease &&
      record.activeOperations === 0 &&
      !lease.view.webContents.isDestroyed()
    ) {
      publishState(
        context.options,
        record,
        lease.browserUseTurnId ? "working" : "ready",
        tool,
      );
    }
  }
}

function beginBrowserConfirmation(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  options: ZerosBrowserServiceOptions,
  tool: BrowserSessionState["tool"],
): void {
  lease.confirmationDepth += 1;
  lease.view.setVisible(
    browserSurfaceShouldBeVisible({
      attachedToTrustedWindow: lease.attachedTo !== lease.parkingWindow,
      confirmationDepth: lease.confirmationDepth,
    }),
  );
  publishState(options, record, "awaiting-confirmation", tool);
}

function endBrowserConfirmation(
  record: BrowserSessionRecord,
  lease: BrowserLease,
  options: ZerosBrowserServiceOptions,
  tool: BrowserSessionState["tool"],
  status: BrowserSessionState["status"] = "ready",
): void {
  lease.confirmationDepth = Math.max(0, lease.confirmationDepth - 1);
  if (
    record.lease === lease &&
    !lease.attachedTo.isDestroyed() &&
    !lease.view.webContents.isDestroyed()
  ) {
    lease.view.setVisible(
      browserSurfaceShouldBeVisible({
        attachedToTrustedWindow: lease.attachedTo !== lease.parkingWindow,
        confirmationDepth: lease.confirmationDepth,
      }),
    );
  }
  publishState(
    options,
    record,
    lease.confirmationDepth > 0 ? "awaiting-confirmation" : status,
    tool,
  );
}

async function snapshotResult(lease: BrowserLease): Promise<BrowserToolResult> {
  if (lease.view.webContents.isLoading())
    await waitForLoad(lease.view.webContents);
  // Every returned snapshot invalidates refs from the preceding one. Besides
  // preventing accidental reuse after DOM churn, rotating the random
  // attribute means page-authored legacy markers are never trusted.
  const previousRefAttribute = lease.refAttribute;
  const markers = browserDomMarkers(randomBytes(12).toString("hex"));
  lease.refAttribute = markers.refAttribute;
  const snapshot = await lease.view.webContents.executeJavaScript(
    snapshotScript(lease.refAttribute, markers.refScope, previousRefAttribute),
    true,
  );
  return success({
    ...asRecord(snapshot),
    consoleErrors: lease.consoleErrors.slice(-20),
    networkErrors: lease.networkErrors.slice(-20),
    downloads: lease.downloads.slice(-20),
  });
}

async function screenshotResult(
  lease: BrowserLease,
  artifactRoot: string,
  browserSessionId: string,
  annotations: BrowserAnnotation[],
  interrupted: () => boolean,
): Promise<BrowserToolResult> {
  if (lease.view.webContents.isLoading())
    await waitForLoad(lease.view.webContents);
  await preparePageForAgent(lease.view.webContents);
  // Agent chrome is visible in the shared page but is not website evidence.
  // Queue this after the working-state injection and restore it after capture,
  // so screenshots contain requested annotations but never the cyan tint or
  // Zeros cursor.
  await lease.view.webContents
    .executeJavaScript(
      agentDecorationVisibilityScript(
        [lease.workingOverlayId, lease.pointerOverlayId],
        false,
      ),
      true,
    )
    .catch(() => undefined);
  try {
    if (annotations.length > 0) {
      const result = asRecord(
        await lease.view.webContents.executeJavaScript(
          annotationOverlayScript(
            lease.refAttribute,
            lease.annotationOverlayId,
            annotations,
          ),
          true,
        ),
      );
      if (result.ok !== true) {
        return failure(String(result.error ?? "Screenshot annotation failed."));
      }
    }
    await waitForPageFrame(lease.view.webContents);
    const image = await lease.view.webContents.capturePage();
    if (interrupted())
      throw browserError("Browser work was stopped by the user.");
    const jpeg = image.toJPEG(85);
    const url = normalizeWebUrl(lease.view.webContents.getURL());
    const artifact = await persistBrowserScreenshot({
      root: artifactRoot,
      browserSessionId,
      jpeg,
      url,
      title: lease.view.webContents.getTitle(),
    });
    if (interrupted()) {
      await unlink(artifact.path).catch(() => undefined);
      throw browserError("Browser work was stopped by the user.");
    }
    return {
      version: BROWSER_SERVICE_VERSION,
      success: true,
      content: [
        { type: "text", text: boundedJson({ artifact, annotations }) },
        {
          type: "image",
          mimeType: "image/jpeg",
          data: jpeg.toString("base64"),
        },
      ],
    };
  } finally {
    if (annotations.length > 0 && !lease.view.webContents.isDestroyed()) {
      await lease.view.webContents
        .executeJavaScript(
          annotationCleanupScript(lease.annotationOverlayId),
          true,
        )
        .catch(() => undefined);
    }
    if (!lease.view.webContents.isDestroyed()) {
      await lease.view.webContents
        .executeJavaScript(
          agentDecorationVisibilityScript(
            [lease.workingOverlayId, lease.pointerOverlayId],
            true,
          ),
          true,
        )
        .catch(() => undefined);
    }
  }
}

/** Callers read the element's position right after scrolling it into view; a
 * page's own `scroll-behavior: smooth` would still be animating it there. */
const SCROLL_INTO_VIEW_OPTIONS = `{ block: "center", inline: "center", behavior: "instant" }`;

function inspectClickScript(refAttribute: string, ref: string): string {
  const selector = `[${refAttribute}="${ref}"]`;
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "The selected element is disabled." };
    element.scrollIntoView(${SCROLL_INTO_VIEW_OPTIONS});
    const rect = element.getBoundingClientRect();
    const form = element.closest("form");
    const inputType = String(element.getAttribute("type") || "").toLowerCase();
    const tagName = element.tagName;
    const submitsForm = Boolean(form && ((tagName === "BUTTON" && (!inputType || inputType === "submit")) || (tagName === "INPUT" && (inputType === "submit" || inputType === "image"))));
    const safeLabel = (element.getAttribute("aria-label") || element.innerText || element.title || element.name || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    const label = safeLabel || String(element.value || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    return {
      ok: true,
      label,
      safeLabel,
      tagName,
      inputType,
      submitsForm,
      href: element.tagName === "A" ? element.href : undefined,
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
    };
  })()`;
}

function prepareClickScript(
  refAttribute: string,
  ref: string,
  inspectedHref: string | null,
): string {
  const selector = `[${refAttribute}="${ref}"]`;
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    const inspectedHref = ${JSON.stringify(inspectedHref)};
    const currentHref = element.tagName === "A" ? element.href : null;
    if (currentHref !== inspectedHref) return { ok: false, error: "The link target changed; take a new snapshot before retrying." };
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "The selected element is disabled." };
    element.scrollIntoView(${SCROLL_INTO_VIEW_OPTIONS});
    if (element.tagName === "A" && element.hasAttribute("target")) element.removeAttribute("target");
    const rect = element.getBoundingClientRect();
    return {
      ok: true,
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
    };
  })()`;
}

function inspectInputScript(refAttribute: string, ref: string): string {
  const selector = `[${refAttribute}="${ref}"]`;
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    if (element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "The selected input is disabled or read-only." };
    element.scrollIntoView(${SCROLL_INTO_VIEW_OPTIONS});
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || rect.width <= 0 || rect.height <= 0) return { ok: false, error: "The selected input is no longer visible." };
    const inputType = String(element.getAttribute("type") || (element.isContentEditable ? "contenteditable" : "text")).toLowerCase();
    const label = (element.getAttribute("aria-label") || element.placeholder || element.name || element.labels?.[0]?.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    return {
      ok: true,
      tagName: element.tagName,
      inputType,
      label,
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
    };
  })()`;
}

function inputTargetFingerprint(value: Record<string, unknown>) {
  return {
    tagName: String(value.tagName ?? ""),
    inputType: String(value.inputType ?? ""),
    label: String(value.label ?? ""),
    x: Number(value.x),
    y: Number(value.y),
  };
}

async function updateAgentPointer(
  lease: BrowserLease,
  xValue: number,
  yValue: number,
  action: BrowserAgentPointer["action"],
): Promise<void> {
  const x = Math.max(
    0,
    Math.min(Math.max(0, lease.viewport.width - 1), xValue),
  );
  const y = Math.max(
    0,
    Math.min(Math.max(0, lease.viewport.height - 1), yValue),
  );
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  lease.pointer = { x, y, action, updatedAt: Date.now() };
  try {
    await withTimeout(
      lease.view.webContents.executeJavaScript(
        agentPointerOverlayScript(lease.pointerOverlayId, lease.pointer),
        true,
      ),
      1_000,
      "Agent pointer overlay timed out.",
    );
  } catch {
    // Decoration is cosmetic. Navigation can replace the document between
    // inspection and interaction; the next action reinstalls the overlay.
  }
}

/** Dispatch a trusted pointer sequence at the inspected element so sites that
 * rely on pointerdown/up, hover, or user activation behave like a real click.
 * The visual working treatment never participates in hit testing; the
 * main-process input gate remains the authoritative user-interaction lock. */
async function dispatchAgentClick(
  lease: BrowserLease,
  xValue: number,
  yValue: number,
  target: {
    refAttribute: string;
    ref: string;
    inspectedHref: string | null;
  },
): Promise<void> {
  const bounds = lease.view.getBounds();
  const x = Math.round(
    Math.max(0, Math.min(Math.max(0, bounds.width - 1), xValue)),
  );
  const y = Math.round(
    Math.max(0, Math.min(Math.max(0, bounds.height - 1), yValue)),
  );
  if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) {
    throw browserError("The browser click target is outside the viewport.");
  }
  await preparePageForAgent(lease.view.webContents);
  lease.agentInputDepth += 1;
  try {
    if (lease.actor !== "agent" || lease.view.webContents.isDestroyed()) {
      throw browserError("Browser work was stopped by the user.");
    }
    await dispatchAgentPointerMove(lease.view.webContents, x, y);
    // Hover handlers can move or cover a control. Yield once, then revalidate
    // the exact semantic ref and topmost hit target before the irreversible
    // mouse-down/up pair. This is also where the user sees the pointer arrive.
    await delay(40);
    const revalidated = asRecord(
      await lease.view.webContents.executeJavaScript(
        validateClickTargetScript(
          target.refAttribute,
          target.ref,
          target.inspectedHref,
          x,
          y,
        ),
        true,
      ),
    );
    if (revalidated.ok !== true) {
      throw browserError(
        String(revalidated.error ?? "The browser click target changed."),
      );
    }
    lease.view.webContents.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    lease.view.webContents.sendInputEvent({
      type: "mouseUp",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    // Keep the trusted-input marker and visual working state stable until
    // Chromium has consumed both queued events.
    await delay(30);
  } finally {
    lease.agentInputDepth = Math.max(0, lease.agentInputDepth - 1);
  }
}

/** A page parked in the hidden window drops mouse and key presses and cannot
 * be captured: its widget starts hidden there, and Electron's
 * `setBackgroundThrottling(false)` setter is what marks a hidden widget shown.
 * Navigation replaces the widget, so this runs before every agent input and
 * screenshot rather than once per lease. A new document also drops input while
 * Chromium holds its paint, until its first paint or a few hundred
 * milliseconds for a page that paints nothing. Waiting for the Paint Timing
 * entry, rather than polling a capture, keeps the compositor animating: once a
 * parked page is captured, its smooth scrolls stall. */
async function preparePageForAgent(webContents: WebContents): Promise<void> {
  if (webContents.isDestroyed()) return;
  webContents.setBackgroundThrottling(false);
  await withTimeout(
    webContents.executeJavaScriptInIsolatedWorld(
      AGENT_PAGE_WORLD_ID,
      [{ code: AGENT_INPUT_READY_SCRIPT }],
      false,
    ),
    AGENT_INPUT_READY_TIMEOUT_MS + 250,
    "The page did not become ready for input.",
  ).catch(() => undefined);
}

/** `capturePage` copies the frame the page drew last, which can predate a DOM
 * change made just before the capture. */
async function waitForPageFrame(webContents: WebContents): Promise<void> {
  if (webContents.isDestroyed()) return;
  await withTimeout(
    webContents.executeJavaScriptInIsolatedWorld(
      AGENT_PAGE_WORLD_ID,
      [
        {
          code: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        },
      ],
      false,
    ),
    PAGE_FRAME_TIMEOUT_MS,
    "The page did not draw a frame.",
  ).catch(() => undefined);
}

/** Resolves once the document has painted. A document that never paints is
 * remembered after one timeout so later input is not delayed again; the
 * isolated world keeps that flag and the Performance API out of page reach. */
const AGENT_INPUT_READY_SCRIPT = `(() => {
  if (window.__zerosInputReady || performance.getEntriesByType("paint").length > 0) return true;
  return new Promise((resolve) => {
    let timer = 0;
    const observer = new PerformanceObserver(() => finish());
    const finish = () => {
      observer.disconnect();
      clearTimeout(timer);
      window.__zerosInputReady = true;
      resolve(true);
    };
    observer.observe({ type: "paint" });
    timer = setTimeout(finish, ${AGENT_INPUT_READY_TIMEOUT_MS});
  });
})()`;

/** Smooth scrolling runs on the compositor, which stops animating a parked
 * page once it was captured or shown and parked again. The scroll would stall
 * and the snapshot report the old position; nobody watches a parked page. */
function agentScrollAnimates(lease: BrowserLease): boolean {
  return (
    lease.attachedTo !== lease.parkingWindow &&
    !lease.attachedTo.isDestroyed() &&
    lease.attachedTo.isVisible()
  );
}

/** `sendInputEvent` returns before the page handles a mouse move, which
 * Chromium holds for the page's next frame, so hover handlers could run after
 * the click target was revalidated. A CDP move resolves once the page has
 * handled it. The page has one CDP session, which Codex and the Appearance
 * override may share; only a session opened here is closed again. */
async function dispatchAgentPointerMove(
  webContents: WebContents,
  x: number,
  y: number,
): Promise<void> {
  const debug = webContents.debugger;
  const attachedHere = !debug.isAttached();
  if (attachedHere) debug.attach("1.3");
  try {
    await withTimeout(
      debug.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
      }),
      BROWSER_USE_CDP_TIMEOUT_MS,
      "The page did not respond to the pointer.",
    );
  } finally {
    if (attachedHere && debug.isAttached()) debug.detach();
  }
}

function validateClickTargetScript(
  refAttribute: string,
  ref: string,
  inspectedHref: string | null,
  expectedX: number,
  expectedY: number,
): string {
  const selector = `[${refAttribute}="${ref}"]`;
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: "The click target disappeared; take a new snapshot." };
    const currentHref = element.tagName === "A" ? element.href : null;
    if (currentHref !== ${JSON.stringify(inspectedHref)}) return { ok: false, error: "The link target changed; take a new snapshot before retrying." };
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "The selected element is disabled." };
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { ok: false, error: "The click target is no longer visible." };
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    if (Math.abs(x - ${JSON.stringify(expectedX)}) > 4 || Math.abs(y - ${JSON.stringify(expectedY)}) > 4) return { ok: false, error: "The click target moved; take a new snapshot before retrying." };
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) return { ok: false, error: "The click target became obscured; take a new snapshot before retrying." };
    return { ok: true };
  })()`;
}

function agentPointerCleanupScript(overlayId: string): string {
  return `document.getElementById(${JSON.stringify(overlayId)})?.remove()`;
}

function agentDecorationVisibilityScript(
  overlayIds: readonly string[],
  visible: boolean,
): string {
  return `(() => {
    for (const id of ${JSON.stringify(overlayIds)}) {
      const element = document.getElementById(id);
      if (element) element.style.visibility = ${JSON.stringify(visible ? "" : "hidden")};
    }
    return true;
  })()`;
}

function typeScript(
  refAttribute: string,
  ref: string,
  text: string,
  clear: boolean,
  redactValue: boolean,
): string {
  const selector = `[${refAttribute}="${ref}"]`;
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    const text = ${JSON.stringify(text)};
    element.scrollIntoView(${SCROLL_INTO_VIEW_OPTIONS});
    element.focus();
    if (element.isContentEditable) {
      if (${clear}) element.textContent = "";
      element.textContent = (element.textContent || "") + text;
    } else if ("value" in element) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      const next = ${clear} ? text : String(element.value || "") + text;
      if (setter) setter.call(element, next); else element.value = next;
    } else return { ok: false, error: "The selected element does not accept text." };
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: ${redactValue} ? "[redacted]" : ("value" in element ? String(element.value).slice(0, 300) : String(element.textContent || "").slice(0, 300)) };
  })()`;
}

/** Focus the referenced element (or keep the current focus) and describe the
 * element the key then reaches, which need not be the referenced one: focus
 * follows open shadow roots and same-origin frames, and a frame Zeros can't
 * read is reported as opaque. Described like a click target, plus whether
 * text goes into it and, for a form field, its form's default button. A
 * typing field's value is never read. */
function focusForKeyScript(refAttribute: string, ref: string | null): string {
  const selector = ref ? `[${refAttribute}="${ref}"]` : null;
  return `(() => {
    const selector = ${JSON.stringify(selector)};
    let element = null;
    if (selector) {
      element = document.querySelector(selector);
      if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "The selected element is disabled." };
      element.scrollIntoView(${SCROLL_INTO_VIEW_OPTIONS});
      if (typeof element.focus === "function") element.focus();
    }
    const clean = (value) => String(value || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    const labelOf = (node) => clean(node.getAttribute("aria-label") || node.innerText || node.title || node.name) || clean(node.value);
    let target = document.activeElement;
    let opaque = false;
    for (let depth = 0; target && depth < 16; depth += 1) {
      if (target.shadowRoot && target.shadowRoot.activeElement) {
        target = target.shadowRoot.activeElement;
      } else if (target.tagName === "IFRAME" || target.tagName === "FRAME") {
        let inner = null;
        try { inner = target.contentDocument; } catch {}
        if (!inner) { opaque = true; break; }
        target = inner.activeElement;
      } else break;
    }
    if (target && !opaque && (target === target.ownerDocument.body || target === target.ownerDocument.documentElement)) target = null;
    const tagName = target ? target.tagName : "";
    const inputType = target ? String(target.getAttribute("type") || "").toLowerCase() : "";
    const field = tagName === "SELECT" || (tagName === "INPUT" && !["submit", "image", "button", "reset", "file"].includes(inputType));
    const typing = Boolean(target) && !opaque && (Boolean(target.isContentEditable) || tagName === "TEXTAREA" || (field && inputType !== "checkbox" && inputType !== "radio"));
    const owner = target && !opaque ? (target.form || (target.closest ? target.closest("form") : null)) : null;
    const submitsForm = Boolean(owner && ((tagName === "BUTTON" && (!inputType || inputType === "submit")) || (tagName === "INPUT" && (inputType === "submit" || inputType === "image"))));
    const form = field ? owner : null;
    const submit = form ? form.querySelector('button[type=submit],input[type=submit],input[type=image],button:not([type])') : null;
    const anchor = element || (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
    const rect = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, top: innerHeight / 2, width: 0, height: 0 };
    return {
      ok: true,
      target: Boolean(target),
      opaque,
      password: tagName === "INPUT" && inputType === "password",
      tagName,
      inputType,
      label: target && !typing && !opaque ? labelOf(target) : "",
      submitsForm,
      typing,
      implicitSubmit: Boolean(form),
      submitLabel: submit ? labelOf(submit) || clean(submit.alt) : "",
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
    };
  })()`;
}

function browserKeyTarget(
  value: Record<string, unknown>,
): BrowserKeyTarget | null {
  if (value.target !== true) return null;
  return {
    label: String(value.label ?? ""),
    tagName: String(value.tagName ?? ""),
    inputType: String(value.inputType ?? ""),
    submitsForm: value.submitsForm === true,
    typing: value.typing === true,
    implicitSubmit: value.implicitSubmit === true,
    submitLabel: String(value.submitLabel ?? ""),
    opaque: value.opaque === true,
  };
}

function sameBrowserKeyTarget(
  approved: BrowserKeyTarget | null,
  current: BrowserKeyTarget | null,
): boolean {
  return JSON.stringify(approved) === JSON.stringify(current);
}

function selectOptionScript(
  refAttribute: string,
  ref: string,
  value: string | null,
  label: string | null,
): string {
  const selector = `[${refAttribute}="${ref}"]`;
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    if (element.tagName !== "SELECT") return { ok: false, error: "The selected element is not a dropdown; use click for custom menus." };
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "The selected input is disabled or read-only." };
    const value = ${JSON.stringify(value)};
    const label = ${JSON.stringify(label)};
    const normalize = (text) => String(text || "").trim().replace(/\\s+/g, " ");
    const options = Array.from(element.options);
    const index = options.findIndex((option) => !option.disabled && ((value !== null && option.value === value) || (label !== null && normalize(option.text) === normalize(label))));
    if (index < 0) return { ok: false, error: "No option matches. Options: " + options.slice(0, 40).map((option) => normalize(option.text).slice(0, 60)).join(" | ") };
    element.scrollIntoView(${SCROLL_INTO_VIEW_OPTIONS});
    element.focus();
    element.selectedIndex = index;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    const rect = element.getBoundingClientRect();
    return {
      ok: true,
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
    };
  })()`;
}

async function setFileInput(
  webContents: WebContents,
  refAttribute: string,
  ref: string,
  filePath: string,
): Promise<void> {
  const debug = webContents.debugger;
  const attachedHere = !debug.isAttached();
  if (attachedHere) debug.attach("1.3");
  try {
    const document = (await debug.sendCommand("DOM.getDocument", {
      depth: 0,
      pierce: true,
    })) as { root?: { nodeId?: number } };
    const nodeId = document.root?.nodeId;
    if (!nodeId) throw browserError("The browser document is unavailable.");
    const match = (await debug.sendCommand("DOM.querySelector", {
      nodeId,
      selector: `[${refAttribute}="${ref}"]`,
    })) as { nodeId?: number };
    if (!match.nodeId) throw browserError("Unknown or stale browser ref.");
    await debug.sendCommand("DOM.setFileInputFiles", {
      nodeId: match.nodeId,
      files: [filePath],
    });
  } finally {
    if (attachedHere && debug.isAttached()) debug.detach();
  }
}

function annotationOverlayScript(
  refAttribute: string,
  overlayId: string,
  annotations: BrowserAnnotation[],
): string {
  return `(() => {
    const overlayId = ${JSON.stringify(overlayId)};
    const refAttribute = ${JSON.stringify(refAttribute)};
    document.getElementById(overlayId)?.remove();
    const root = document.createElement("div");
    root.id = overlayId;
    root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const annotations = ${JSON.stringify(annotations)};
    for (const annotation of annotations) {
      const element = document.querySelector('[' + refAttribute + '="' + annotation.ref + '"]');
      if (!element) { root.remove(); return { ok: false, error: "Unknown or stale annotation ref " + annotation.ref + "; take a new snapshot." }; }
      const rect = element.getBoundingClientRect();
      const badge = document.createElement("div");
      badge.textContent = annotation.label;
      badge.style.cssText = "position:absolute;background:#e5484d;color:white;border:1px solid white;border-radius:3px;padding:2px 5px;font:600 12px sans-serif;box-shadow:0 1px 4px #000;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      badge.style.left = Math.max(0, Math.min(innerWidth - 40, rect.left)) + "px";
      badge.style.top = Math.max(0, Math.min(innerHeight - 24, rect.top)) + "px";
      root.appendChild(badge);
    }
    document.documentElement.appendChild(root);
    return { ok: true };
  })()`;
}

function annotationCleanupScript(overlayId: string): string {
  return `document.getElementById(${JSON.stringify(overlayId)})?.remove()`;
}

async function normalizeOwner(
  owner: BrowserSessionOwner,
): Promise<BrowserSessionOwner> {
  if (
    !owner ||
    !isBrowserProductId(owner.workspaceId) ||
    !isBrowserProductId(owner.conversationId) ||
    typeof owner.workspaceRoot !== "string" ||
    !isAbsolute(owner.workspaceRoot)
  ) {
    throw browserError("Invalid Zeros browser owner.");
  }
  const workspaceRoot = await realpath(owner.workspaceRoot);
  return {
    workspaceId: owner.workspaceId,
    conversationId: owner.conversationId,
    workspaceRoot,
  };
}

function ownerKey(owner: BrowserSessionOwner): string {
  return ownerIdentityKey(owner.workspaceId, owner.conversationId);
}

function ownerIdentityKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}\u0000${conversationId}`;
}

function publishState(
  options: ZerosBrowserServiceOptions,
  record: BrowserSessionRecord,
  status: BrowserSessionState["status"],
  tool?: BrowserSessionState["tool"],
): BrowserSessionState {
  const lease = record.lease;
  // Revocation can resolve a parked confirmation while its lease is being
  // destroyed. Never let that late continuation publish "ready" after the
  // authoritative closed event and resurrect a renderer-side session.
  if (!lease && status !== "closed") return sessionState(record, "closed");
  const effectiveStatus =
    lease && lease.confirmationDepth > 0 && status !== "closed"
      ? "awaiting-confirmation"
      : status;
  if (lease) {
    const previousStatus = lease.status;
    lease.status = effectiveStatus;
    if (tool !== undefined) lease.currentTool = tool;
    if (
      lease.actor === "agent" &&
      effectiveStatus === "ready" &&
      (previousStatus === "working" ||
        previousStatus === "awaiting-confirmation")
    ) {
      lease.agentActivityUntil = Date.now() + AGENT_ACTIVITY_LINGER_MS;
    }
    const visuallyWorking =
      lease.actor === "agent" && effectiveStatus !== "closed";
    if (
      lease.workingOverlayVisible !== visuallyWorking &&
      !lease.view.webContents.isDestroyed()
    ) {
      lease.workingOverlayVisible = visuallyWorking;
      void lease.view.webContents
        .executeJavaScript(
          agentWorkingOverlayScript(lease.workingOverlayId, visuallyWorking),
          true,
        )
        .catch(() => undefined);
    }
  }
  const state = sessionState(record, effectiveStatus, tool);
  options.onSessionState?.(state);
  syncAgentControlBar(options, record, state);
  return state;
}

function syncAgentControlBar(
  options: ZerosBrowserServiceOptions,
  record: BrowserSessionRecord,
  state: BrowserSessionState,
  raise = false,
): void {
  const presenter = options.agentControl;
  if (!presenter) return;
  const lease = record.lease;
  if (!lease || lease.view.webContents.isDestroyed()) {
    presenter.dispose(record.id);
    return;
  }
  const attachedToTrustedWindow =
    lease.attachedTo !== lease.parkingWindow && !lease.attachedTo.isDestroyed();
  const disposition = browserControlBarDisposition({
    actor: lease.actor,
    status: state.status,
    attachedToTrustedWindow,
    surfaceId: lease.surfaceId,
    zerosBrowser: options.zerosBrowserAvailable?.() ?? true,
  });
  if (disposition !== "show") {
    presenter.hide(record.id, { immediate: disposition === "remove" });
    return;
  }
  presenter.show(record.id, {
    title: record.agent ? agentControlName(record.agent) : "Agent",
    detail: browserControlDetail(state),
    window: lease.attachedTo,
    above: lease.view,
    bounds: lease.view.getBounds(),
    raise,
  });
}

function sessionState(
  record: BrowserSessionRecord,
  status = record.lease?.status ?? "closed",
  tool = record.lease?.currentTool,
): BrowserSessionState {
  const lease = record.lease;
  const contents = lease?.view.webContents;
  const rawUrl =
    lease?.pendingUrl ??
    (contents && !contents.isDestroyed() ? contents.getURL() : "");
  const rawTitle = lease?.displayTitle ?? "Browser";
  return {
    browserSessionId: record.id,
    workspaceId: record.owner.workspaceId,
    conversationId: record.owner.conversationId,
    url: rawUrl.slice(0, 8_192),
    title: rawTitle.trim().slice(0, 512) || "Browser",
    loading: Boolean(
      lease?.pendingUrl ||
      (contents && !contents.isDestroyed() && contents.isLoading()),
    ),
    ...(contents && !contents.isDestroyed()
      ? {
          canGoBack: contents.navigationHistory.canGoBack(),
          canGoForward: contents.navigationHistory.canGoForward(),
        }
      : {}),
    status,
    ...(lease ? { actor: lease.actor } : {}),
    ...(lease?.pointer ? { pointer: lease.pointer } : {}),
    ...(lease?.faviconDataUrl && lease.faviconOrigin === safeWebOrigin(rawUrl)
      ? { faviconDataUrl: lease.faviconDataUrl }
      : {}),
    ...(lease ? { sourceViewport: lease.sourceViewport } : {}),
    ...(lease?.action ? { action: lease.action } : {}),
    ...(lease && lease.agentActivityUntil > 0
      ? { agentActivityUntil: lease.agentActivityUntil }
      : {}),
    ...(lease &&
    lease.actor === "agent" &&
    (status === "working" || status === "awaiting-confirmation")
      ? { cancellable: true }
      : {}),
    ...(lease ? { surfaceHovered: lease.surfaceHovered } : {}),
    ...(tool ? { tool } : {}),
  };
}

function resizeLease(
  lease: BrowserLease,
  rawWidth: unknown,
  rawHeight: unknown,
  required = false,
): void {
  if (!required && rawWidth === undefined && rawHeight === undefined) return;
  const width =
    rawWidth === undefined
      ? lease.viewport.width
      : boundedInteger(
          rawWidth,
          "width",
          MIN_VIEWPORT.width,
          MAX_VIEWPORT.width,
        );
  const height =
    rawHeight === undefined
      ? lease.viewport.height
      : boundedInteger(
          rawHeight,
          "height",
          MIN_VIEWPORT.height,
          MAX_VIEWPORT.height,
        );
  lease.sourceViewport = { width, height };
  lease.viewport = browserViewportAfterExplicitResize(
    lease.viewport,
    { width, height },
    lease.attachedTo === lease.parkingWindow,
  );
  if (lease.attachedTo === lease.parkingWindow) {
    // A PiP may have been parked while its hover toolbar is visible. An
    // explicit Browser resize is semantic page state, not presentation: clear
    // the temporary PiP zoom before applying the requested CSS viewport.
    lease.view.webContents.setZoomFactor(1);
    lease.sourceViewport = { ...lease.viewport };
    lease.view.setBounds({ x: 0, y: 0, ...lease.viewport });
  }
}

async function destroyLease(lease: BrowserLease): Promise<void> {
  if (lease.displayTitleTimer) clearTimeout(lease.displayTitleTimer);
  lease.displayTitleTimer = null;
  // First, so releasing Codex's debugger below cannot schedule a reapply.
  lease.appearance.dispose();
  lease.disposeBrowserUseDebugger();
  lease.disposeNetworkHandlers();
  lease.disposePermissionHandlers();
  lease.disposeDownloadHandler();
  for (const item of lease.activeDownloads) item.cancel();
  lease.activeDownloads.clear();
  lease.view.setVisible(false);
  if (!lease.attachedTo.isDestroyed()) {
    lease.attachedTo.contentView.removeChildView(lease.view);
  }
  if (!lease.view.webContents.isDestroyed()) {
    lease.view.webContents.close({ waitForBeforeUnload: false });
  }
  await Promise.allSettled([
    lease.browserSession.clearStorageData(),
    lease.browserSession.clearCache(),
  ]);
  await Promise.allSettled(
    lease.stagedUploads.splice(0).map(discardStagedBrowserUpload),
  );
  if (!lease.parkingWindow.isDestroyed()) lease.parkingWindow.destroy();
}

function parkLease(lease: BrowserLease): void {
  const renderedBounds = lease.view.getBounds();
  lease.surfaceHovered = false;
  lease.view.setVisible(false);
  if (!lease.attachedTo.isDestroyed()) {
    lease.attachedTo.contentView.removeChildView(lease.view);
  }
  if (lease.parkingWindow.isDestroyed()) return;
  lease.parkingWindow.contentView.addChildView(lease.view);
  lease.attachedTo = lease.parkingWindow;
  lease.surfaceId = null;
  lease.view.setBounds({
    x: 0,
    y: 0,
    width: renderedBounds.width,
    height: renderedBounds.height,
  });
  lease.view.setVisible(
    browserSurfaceShouldBeVisible({
      attachedToTrustedWindow: false,
      confirmationDepth: lease.confirmationDepth,
    }),
  );
}

function isBrowserSurfaceId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function recordTrace(lease: BrowserLease, type: string, detail: string): void {
  lease.trace.push({
    at: Date.now(),
    type: type.slice(0, 80),
    detail: detail.replace(/\s+/g, " ").slice(0, 2_000),
  });
  if (lease.trace.length > 2_000) lease.trace.shift();
}

function enrichBrowserAction(
  lease: BrowserLease,
  tool: "click" | "type" | "upload",
  label: string,
): void {
  if (!lease.action || lease.action.kind !== tool) return;
  lease.action = { ...lease.action, label: label.slice(0, 160) };
}

function trackHostAction(
  lease: BrowserLease,
  action: Promise<void>,
  retainFailure: boolean,
): void {
  lease.pendingHostActions.add(action);
  void action
    .catch((error) => {
      if (retainFailure) {
        lease.hostActionFailures.push(error);
        while (lease.hostActionFailures.length > 16) {
          lease.hostActionFailures.shift();
        }
      }
    })
    .finally(() => lease.pendingHostActions.delete(action));
}

async function waitForHostActions(
  lease: BrowserLease,
  allowEventTurn = true,
): Promise<void> {
  if (allowEventTurn) await delay(100);
  while (lease.pendingHostActions.size > 0) {
    await Promise.allSettled([...lease.pendingHostActions]);
  }
  const firstFailure = lease.hostActionFailures.shift();
  lease.hostActionFailures.length = 0;
  if (firstFailure !== undefined) {
    throw firstFailure instanceof Error
      ? firstFailure
      : new Error(String(firstFailure ?? "Browser host action failed."));
  }
}

async function settleAfterAction(webContents: WebContents): Promise<void> {
  await delay(75);
  if (webContents.isLoading()) await waitForLoad(webContents);
  await waitForUsefulPageContent(webContents);
}

async function loadBrowserUrl(
  webContents: WebContents,
  url: string,
): Promise<void> {
  try {
    await withTimeout(
      webContents.loadURL(url),
      NAVIGATION_TIMEOUT_MS,
      "Page navigation timed out.",
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Page navigation timed out."
    ) {
      const usable = await browserDocumentIsUsable(webContents);
      webContents.stop();
      if (usable) return;
    }
    throw error;
  }
}

/** Wait for client-rendered pages to expose useful content so `open` and
 * navigation actions already return a meaningful snapshot. This removes the
 * former open→empty result→snapshot retry pattern without imposing an
 * unbounded network-idle wait on long-lived pages. */
async function waitForUsefulPageContent(
  webContents: WebContents,
): Promise<void> {
  const deadline = Date.now() + USEFUL_DOCUMENT_TIMEOUT_MS;
  while (!webContents.isDestroyed()) {
    try {
      const ready = await webContents.executeJavaScript(
        `Boolean(document.body && ((document.body.innerText || "").trim().length > 0 || document.querySelector("a,button,input,textarea,select,[role],[contenteditable=true]")))`,
        true,
      );
      if (ready === true) return;
    } catch {
      // A navigation can replace the execution context between polls.
    }
    if (Date.now() >= deadline) return;
    await delay(100);
  }
}

async function resolveBrowserFavicon(
  browserSession: Session,
  candidates: readonly string[],
  pageUrl?: string,
): Promise<string | null> {
  for (const candidate of candidates.slice(0, 4)) {
    const embedded = validatedFaviconDataUrl(candidate);
    if (embedded) return embedded;
    const resolved = await fetchBrowserFaviconDataUrl({
      url: candidate,
      ...(pageUrl ? { pageUrl } : {}),
      fetch: (requestUrl, init) => browserSession.fetch(requestUrl, init),
      maximumBytes: MAX_FAVICON_BYTES,
      normalizeRaster: (bytes) => {
        const image = nativeImage.createFromBuffer(bytes);
        if (image.isEmpty()) return null;
        const size = image.getSize();
        const normalized =
          size.width > 64 || size.height > 64
            ? image.resize({ width: 32, height: 32, quality: "best" })
            : image;
        return normalized.toPNG();
      },
    });
    if (resolved) return resolved;
  }
  return null;
}

function validatedFaviconDataUrl(value: string): string | null {
  if (value.length > Math.ceil((MAX_FAVICON_BYTES * 4) / 3) + 100) return null;
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(value);
  const mime = match ? normalizedBrowserFaviconMime(match[1] ?? null) : null;
  if (!match || !mime) return null;
  try {
    const bytes = Buffer.from(match[2]!, "base64");
    if (mime === "image/svg+xml" && !safeBrowserSvgFavicon(bytes)) return null;
    return bytes.byteLength > 0 && bytes.byteLength <= MAX_FAVICON_BYTES
      ? value
      : null;
  } catch {
    return null;
  }
}

const waitForSharedNativeLoad = createSharedBrowserWaiter(
  waitForSingleNativeLoad,
);

async function waitForLoad(webContents: WebContents): Promise<void> {
  if (!webContents.isLoading()) return;
  return waitForSharedNativeLoad(webContents);
}

async function waitForSingleNativeLoad(
  webContents: WebContents,
): Promise<void> {
  let cleanup = () => undefined;
  try {
    await withTimeout(
      new Promise<void>((resolve) => {
        const done = () => {
          cleanup();
          resolve();
        };
        cleanup = () => {
          webContents.off("did-finish-load", done);
          webContents.off("did-fail-load", done);
          webContents.off("did-stop-loading", done);
        };
        webContents.once("did-finish-load", done);
        webContents.once("did-fail-load", done);
        webContents.once("did-stop-loading", done);
        // Loading may finish between the outer check and registration.
        if (!webContents.isLoading()) done();
      }),
      NAVIGATION_TIMEOUT_MS,
      "Page navigation timed out.",
    );
  } catch (error) {
    const usable = await browserDocumentIsUsable(webContents);
    webContents.stop();
    if (!usable) throw error;
  } finally {
    cleanup();
  }
}

async function browserDocumentIsUsable(
  webContents: WebContents,
): Promise<boolean> {
  if (webContents.isDestroyed()) return false;
  try {
    const readiness = asRecord(
      await withTimeout(
        webContents.executeJavaScript(
          `({ readyState: document.readyState, hasDocumentElement: Boolean(document.documentElement) })`,
          true,
        ),
        1_000,
        "Browser document readiness timed out.",
      ),
    );
    return usableBrowserDocument({
      url: webContents.getURL(),
      readyState: String(readiness.readyState ?? ""),
      hasDocumentElement: readiness.hasDocumentElement === true,
    });
  } catch {
    return false;
  }
}

async function normalizeCodexPageNavigateAfterRedirect(
  webContents: WebContents,
  result: unknown,
  context: { requestedUrl: string; previousUrl: string },
): Promise<unknown> {
  const deadline = Date.now() + 1_500;
  while (!webContents.isDestroyed()) {
    const normalized = normalizeCodexPageNavigateResult(result, {
      ...context,
      currentUrl: webContents.getURL(),
      usableDocument: await browserDocumentIsUsable(webContents),
    });
    if (asRecord(normalized).errorText !== "net::ERR_ABORTED") {
      return normalized;
    }
    if (Date.now() >= deadline) return result;
    await delay(50);
  }
  return result;
}

function normalizeWebUrl(value: string): string {
  if (value.length > 8_192) throw browserError("Browser URL is too long.");
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw browserError(
      "Browser navigation requires a credential-free HTTP(S) URL.",
    );
  }
  return url.href;
}

function safeNormalizedWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return normalizeWebUrl(value);
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeWebOrigin(value: string): string | null {
  try {
    return new URL(normalizeWebUrl(value)).origin;
  } catch {
    return null;
  }
}

function redactDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[invalid URL]";
  }
}

function permissionLabel(permission: string): string {
  return permission
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .toLocaleLowerCase();
}

function requireRef(value: unknown): string {
  if (!isBrowserElementRef(value)) {
    throw browserError("Browser element ref is invalid.");
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw browserError(`Browser ${name} must be a non-empty string.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw browserError(
      `Browser ${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw browserError(`Zeros browser ${label} is invalid.`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function success(value: unknown): BrowserToolResult {
  return {
    version: BROWSER_SERVICE_VERSION,
    success: true,
    content: [{ type: "text", text: boundedJson(value) }],
  };
}

function failure(text: string): BrowserToolResult {
  return {
    version: BROWSER_SERVICE_VERSION,
    success: false,
    content: [{ type: "text", text: text.slice(0, 4_000) }],
  };
}

function boundedJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_RESPONSE_BYTES) {
    throw browserError("Zeros browser response exceeded its size limit.");
  }
  return serialized;
}

function appendBounded(target: string[], value: string, maximum: number): void {
  target.push(value.slice(0, 1_000));
  while (target.length > maximum) target.shift();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_REQUEST_BYTES)
      throw browserError("Zeros browser request is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenMatches(request: IncomingMessage, expected: string): boolean {
  const supplied = request.headers.authorization;
  if (typeof supplied !== "string" || !supplied.startsWith("Bearer "))
    return false;
  const actual = Buffer.from(supplied.slice(7));
  const expectedBytes = Buffer.from(expected);
  return (
    actual.length === expectedBytes.length &&
    timingSafeEqual(actual, expectedBytes)
  );
}

function setJsonHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-type", "application/json; charset=utf-8");
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const serialized = JSON.stringify(value);
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES
  ) {
    response.statusCode = 500;
    response.end(
      JSON.stringify({
        error: "Zeros browser response exceeded its size limit.",
      }),
    );
    return;
  }
  response.statusCode = status;
  response.end(serialized);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
