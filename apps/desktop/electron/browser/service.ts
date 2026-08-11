import {
  BaseWindow,
  session,
  WebContentsView,
  type DownloadItem,
  type Session,
  type WebContents,
} from "electron";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  isBrowserProductId,
  isBrowserToolName,
  type BrowserConfirmationDecision,
  type BrowserConfirmationRequest,
  type BrowserJsonValue,
  type BrowserRiskCategory,
  type BrowserSessionAcquireRequest,
  type BrowserSessionAcquireResponse,
  type BrowserSessionOwner,
  type BrowserSessionState,
  type BrowserToolInvokeRequest,
  type BrowserToolName,
  type BrowserToolResult,
} from "@zeros/protocol/browser-tools";

import { parseBrowserAnnotations, type BrowserAnnotation } from "./annotations";
import {
  persistBrowserScreenshot,
  persistBrowserTrace,
  type BrowserTraceEvent,
} from "./artifacts";
import {
  BrowserConfirmationBroker,
  classifyBrowserClick,
  classifyBrowserInput,
} from "./confirmations";
import {
  allocateBrowserDownload,
  clearStagedBrowserUploads,
  discardStagedBrowserUpload,
  pruneBrowserDownloads,
  stageBrowserUpload,
  type StagedBrowserUpload,
} from "./files";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_SESSIONS = 8;
const IDLE_SESSION_MS = 20 * 60_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_STAGED_UPLOADS = 10;
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
  browserSession: Session;
  viewport: { width: number; height: number };
  consoleErrors: string[];
  networkErrors: string[];
  downloads: BrowserDownloadArtifact[];
  stagedUploads: StagedBrowserUpload[];
  pendingHostActions: Set<Promise<void>>;
  trace: BrowserTraceEvent[];
  disposeNetworkHandlers: () => void;
  disposePermissionHandlers: () => void;
  disposeDownloadHandler: () => void;
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
}

export interface ZerosBrowserServiceOptions {
  artifactRoot: string;
  onSessionState?: (state: BrowserSessionState) => void;
  onConfirmationRequest?: (request: BrowserConfirmationRequest) => void;
  /** Prevent all browser work when no trusted product surface is available. */
  isTrustedSurfaceAvailable?: () => boolean;
  maxSessions?: number;
  idleSessionMs?: number;
}

export interface ZerosBrowserServiceHandle {
  baseUrl: string;
  token: string;
  acquire(owner: BrowserSessionOwner): Promise<BrowserSessionAcquireResponse>;
  invoke(request: BrowserToolInvokeRequest): Promise<BrowserToolResult>;
  close(browserSessionId: string): boolean;
  respondToConfirmation(
    confirmationId: string,
    decision: BrowserConfirmationDecision,
  ): boolean;
  revokeConfirmationSurface(): Promise<number>;
  stop(): Promise<void>;
}

const SNAPSHOT_SCRIPT = String.raw`(() => {
  const counterAttribute = "data-zeros-browser-ref-counter";
  const refAttribute = "data-zeros-browser-ref";
  const root = document.documentElement;
  let counter = Number(root.getAttribute(counterAttribute) || "0");
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
  const candidates = Array.from(document.querySelectorAll("a[href],button,input:not([type=hidden]),textarea,select,summary,[role],[contenteditable=true]"));
  const elements = [];
  for (const element of candidates) {
    if (elements.length >= 300 || !visible(element)) continue;
    let ref = element.getAttribute(refAttribute);
    if (!ref) {
      counter += 1;
      ref = "b" + counter;
      element.setAttribute(refAttribute, ref);
    }
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
  root.setAttribute(counterAttribute, String(counter));
  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 24000),
    elements
  };
})()`;

/** Start the Zeros-owned isolated browser runtime. The HTTP transport is an
 * internal main↔engine seam: loopback-only, per-boot bearer authenticated, and
 * keyed exclusively by Zeros workspace/conversation/browser-session ids. */
export async function startZerosBrowserService(
  options: ZerosBrowserServiceOptions,
): Promise<ZerosBrowserServiceHandle> {
  if (!isAbsolute(options.artifactRoot)) {
    throw new Error("Zeros browser artifact root must be absolute.");
  }
  await clearStagedBrowserUploads(options.artifactRoot);
  const token = randomBytes(32).toString("base64url");
  const records = new Map<string, BrowserSessionRecord>();
  const ownerSessions = new Map<string, string>();
  const cleanupTasks = new Set<Promise<void>>();
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
    publishState(options, record, "closed");
  };

  const touchRecord = (record: BrowserSessionRecord): void => {
    record.touchedAt = Date.now();
    clearTimeout(record.expires);
    record.expires = setTimeout(() => {
      if (records.get(record.id) !== record) return;
      if (record.activeOperations > 0) {
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
      };
    }

    if (records.size >= maxSessions) {
      const oldest = [...records.values()]
        .filter((candidate) => candidate.activeOperations === 0)
        .sort((left, right) => left.touchedAt - right.touchedAt)[0];
      if (!oldest) {
        throw new Error("Every isolated browser session is currently busy.");
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
    };
    records.set(id, record);
    ownerSessions.set(key, id);
    touchRecord(record);
    return { version: BROWSER_SERVICE_VERSION, browserSessionId: id };
  };

  const invoke = async (
    request: BrowserToolInvokeRequest,
  ): Promise<BrowserToolResult> => {
    if (options.isTrustedSurfaceAvailable?.() === false) {
      return failure(
        "Open the trusted Zeros window before using browser automation.",
      );
    }
    if (
      request.version !== BROWSER_SERVICE_VERSION ||
      !isBrowserProductId(request.browserSessionId) ||
      !isBrowserToolName(request.tool)
    ) {
      return failure("Invalid Zeros browser tool request.");
    }
    const record = records.get(request.browserSessionId);
    if (!record) return failure("The Zeros browser session is unavailable.");
    touchRecord(record);
    const previous = record.operationTail;
    let release!: () => void;
    record.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    record.activeOperations += 1;
    await previous;
    try {
      if (records.get(record.id) !== record) {
        return failure("The Zeros browser session is unavailable.");
      }
      return await executeTool(record, request.tool, request.arguments, {
        options,
        confirmations,
      });
    } catch (error) {
      if (record.lease && !record.lease.view.webContents.isDestroyed()) {
        publishState(options, record, "ready", request.tool);
      }
      return failure(error instanceof Error ? error.message : String(error));
    } finally {
      record.activeOperations -= 1;
      release();
    }
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
        url.pathname === "/v1/sessions/acquire"
      ) {
        const body = asRecord(await readJsonBody(request));
        const parsed: BrowserSessionAcquireRequest = {
          version: body.version as 1,
          owner: asRecord(body.owner) as unknown as BrowserSessionOwner,
        };
        if (parsed.version !== BROWSER_SERVICE_VERSION) {
          throw new Error("Unsupported Zeros browser service version.");
        }
        sendJson(response, 200, await acquire(parsed.owner));
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
        error: error instanceof Error ? error.message : String(error),
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
    throw new Error("Zeros browser service did not bind a loopback port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token,
    acquire,
    invoke,
    close(browserSessionId) {
      const record = records.get(browserSessionId);
      if (!record) return false;
      destroyRecord(record);
      return true;
    },
    respondToConfirmation(confirmationId, decision) {
      return confirmations.respond(confirmationId, decision);
    },
    async revokeConfirmationSurface() {
      const denied = confirmations.revokeConfirmationSurface();
      const cleanup: Promise<void>[] = [];
      for (const record of records.values()) {
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
      await Promise.allSettled([...cleanupTasks]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function executeTool(
  record: BrowserSessionRecord,
  tool: BrowserToolName,
  rawArguments: BrowserJsonValue,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
  },
): Promise<BrowserToolResult> {
  const args = asRecord(rawArguments);
  if (tool === "close") {
    const closing = record.lease;
    record.lease = null;
    context.confirmations.clearSession(record.id);
    if (closing) await destroyLease(closing);
    publishState(context.options, record, "closed", tool);
    return success({ closed: true, browserSessionId: record.id });
  }

  let lease = record.lease;
  if (!lease) {
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
  recordTrace(lease, "tool", tool);
  publishState(context.options, record, "working", tool);

  switch (tool) {
    case "open": {
      resizeLease(lease, args.width, args.height);
      const url = normalizeWebUrl(requireString(args.url, "url"));
      await withTimeout(
        lease.view.webContents.loadURL(url),
        NAVIGATION_TIMEOUT_MS,
        "Page navigation timed out.",
      );
      const result = await snapshotResult(lease);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "snapshot": {
      const result = await snapshotResult(lease);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "click": {
      const ref = requireRef(args.ref);
      const inspected = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectClickScript(ref),
          true,
        ),
      );
      if (inspected.ok !== true) {
        return failure(String(inspected.error ?? "Click failed."));
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
      const clicked = asRecord(
        await lease.view.webContents.executeJavaScript(clickScript(ref), true),
      );
      if (clicked.ok !== true)
        return failure(String(clicked.error ?? "Click failed."));
      await settleAfterAction(lease.view.webContents);
      await waitForHostActions(lease);
      const result = await snapshotResult(lease);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "type": {
      const ref = requireRef(args.ref);
      const text = requireString(args.text, "text");
      if (text.length > 20_000)
        return failure("Text exceeds 20,000 characters.");
      const inspected = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectInputScript(ref),
          true,
        ),
      );
      if (inspected.ok !== true) {
        return failure(String(inspected.error ?? "Typing failed."));
      }
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
      const typed = asRecord(
        await lease.view.webContents.executeJavaScript(
          typeScript(
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
      const result = await snapshotResult(lease);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "upload": {
      const ref = requireRef(args.ref);
      const inspected = asRecord(
        await lease.view.webContents.executeJavaScript(
          inspectInputScript(ref),
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
      const upload = await stageBrowserUpload({
        requestedPath: requireString(args.path, "path"),
        workspaceRoot: record.canonicalWorkspaceRoot,
        root: context.options.artifactRoot,
        browserSessionId: record.id,
      });
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
      try {
        await setFileInput(lease.view.webContents, ref, upload.path);
      } catch (error) {
        await discardStagedBrowserUpload(upload);
        throw error;
      }
      lease.stagedUploads.push(upload);
      while (lease.stagedUploads.length > MAX_STAGED_UPLOADS) {
        const expired = lease.stagedUploads.shift();
        if (expired) await discardStagedBrowserUpload(expired);
      }
      const result = await snapshotResult(lease);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "resize": {
      resizeLease(lease, args.width, args.height, true);
      const result = await snapshotResult(lease);
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "back":
      if (lease.view.webContents.navigationHistory.canGoBack()) {
        lease.view.webContents.navigationHistory.goBack();
      }
      await settleAfterAction(lease.view.webContents);
      publishState(context.options, record, "ready", tool);
      return snapshotResult(lease);
    case "forward":
      if (lease.view.webContents.navigationHistory.canGoForward()) {
        lease.view.webContents.navigationHistory.goForward();
      }
      await settleAfterAction(lease.view.webContents);
      publishState(context.options, record, "ready", tool);
      return snapshotResult(lease);
    case "reload":
      lease.view.webContents.reload();
      await settleAfterAction(lease.view.webContents);
      publishState(context.options, record, "ready", tool);
      return snapshotResult(lease);
    case "screenshot": {
      const annotations = parseBrowserAnnotations(args.annotations);
      const result = await screenshotResult(
        lease,
        context.options.artifactRoot,
        record.id,
        annotations,
      );
      publishState(context.options, record, "ready", tool);
      return result;
    }
    case "trace": {
      const artifact = await persistBrowserTrace({
        root: context.options.artifactRoot,
        browserSessionId: record.id,
        events: lease.trace,
        url: normalizeWebUrl(lease.view.webContents.getURL()),
        title: lease.view.webContents.getTitle(),
      });
      publishState(context.options, record, "ready", tool);
      return success({ artifact });
    }
    default:
      return failure(`Unsupported Zeros browser tool: ${String(tool)}`);
  }
}

function createLease(
  record: BrowserSessionRecord,
  context: {
    options: ZerosBrowserServiceOptions;
    confirmations: BrowserConfirmationBroker;
  },
): BrowserLease {
  const partition = `zeros-browser-${createHash("sha256")
    .update(record.id)
    .digest("hex")
    .slice(0, 24)}`;
  const browserSession = session.fromPartition(partition, { cache: false });
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
  const parkingWindow = new BaseWindow({
    show: false,
    width: 1_440,
    height: 1_000,
  });
  parkingWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1_440, height: 1_000 });
  view.setBackgroundColor("#111111");
  view.webContents.setAudioMuted(true);
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const blockUnsafeNavigation = (event: Electron.Event, url: string) => {
    if (url === "about:blank") return;
    try {
      normalizeWebUrl(url);
    } catch {
      event.preventDefault();
    }
  };
  view.webContents.on("will-navigate", blockUnsafeNavigation);
  view.webContents.on("will-redirect", blockUnsafeNavigation);

  const lease: BrowserLease = {
    view,
    parkingWindow,
    browserSession,
    viewport: { width: 1_440, height: 1_000 },
    consoleErrors: [],
    networkErrors: [],
    downloads: [],
    stagedUploads: [],
    pendingHostActions: new Set(),
    trace: [],
    disposeNetworkHandlers: () => undefined,
    disposePermissionHandlers: () => undefined,
    disposeDownloadHandler: () => undefined,
  };

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
    publishState(context.options, record, "ready");
  };
  view.webContents.on("did-navigate", publishNavigation);
  view.webContents.on("did-navigate-in-page", publishNavigation);
  view.webContents.on("page-title-updated", publishNavigation);
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
    trackHostAction(lease, handleBrowserDownload(record, lease, item, context));
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
    callback(true);
    return;
  }
  publishState(context.options, record, "awaiting-confirmation", "permission");
  const decision = await context.confirmations.confirm({
    browserSessionId: record.id,
    category: "browser-permission",
    scope: permission,
    origin,
    url,
    label: `Allow ${permissionLabel(permission)} for ${origin}`,
  });
  recordTrace(lease, "permission", `${permission}:${decision}`);
  callback(decision !== "deny");
  publishState(context.options, record, "ready", "permission");
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
  publishState(context.options, record, "awaiting-confirmation", "download");
  const decision = await context.confirmations.confirm({
    browserSessionId: record.id,
    category: "download",
    origin,
    url,
    label: `Download ${item.getFilename() || "file"} from ${origin}`,
  });
  recordTrace(lease, "download", `${item.getFilename()}:${decision}`);
  if (decision === "deny") {
    item.cancel();
    await unlink(target.path).catch(() => undefined);
    publishState(context.options, record, "ready", "download");
    return;
  }
  const completed = new Promise<boolean>((resolve) => {
    const onUpdated = () => {
      if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) item.cancel();
    };
    item.on("updated", onUpdated);
    item.once("done", (_event, state) => {
      item.off("updated", onUpdated);
      resolve(state === "completed");
    });
  });
  item.resume();
  if (!(await completed)) {
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
  publishState(context.options, record, "awaiting-confirmation", tool);
  lease.view.setVisible(false);
  const decision = await context.confirmations.confirm({
    browserSessionId: record.id,
    category,
    origin: new URL(url).origin,
    url,
    label,
  });
  recordTrace(lease, "confirmation", `${category}:${decision}`);
  if (!lease.parkingWindow.isDestroyed()) lease.view.setVisible(true);
  publishState(
    context.options,
    record,
    decision === "deny" ? "ready" : "working",
    tool,
  );
  return decision !== "deny";
}

async function snapshotResult(lease: BrowserLease): Promise<BrowserToolResult> {
  if (lease.view.webContents.isLoading())
    await waitForLoad(lease.view.webContents);
  const snapshot = await lease.view.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT,
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
): Promise<BrowserToolResult> {
  if (lease.view.webContents.isLoading())
    await waitForLoad(lease.view.webContents);
  if (annotations.length > 0) {
    const result = asRecord(
      await lease.view.webContents.executeJavaScript(
        annotationOverlayScript(annotations),
        true,
      ),
    );
    if (result.ok !== true) {
      return failure(String(result.error ?? "Screenshot annotation failed."));
    }
  }
  let jpeg: Buffer;
  try {
    const image = await lease.view.webContents.capturePage();
    jpeg = image.toJPEG(85);
  } finally {
    if (annotations.length > 0 && !lease.view.webContents.isDestroyed()) {
      await lease.view.webContents
        .executeJavaScript(annotationCleanupScript(), true)
        .catch(() => undefined);
    }
  }
  const url = normalizeWebUrl(lease.view.webContents.getURL());
  const artifact = await persistBrowserScreenshot({
    root: artifactRoot,
    browserSessionId,
    jpeg,
    url,
    title: lease.view.webContents.getTitle(),
  });
  return {
    version: BROWSER_SERVICE_VERSION,
    success: true,
    content: [
      { type: "text", text: boundedJson({ artifact, annotations }) },
      { type: "image", mimeType: "image/jpeg", data: jpeg.toString("base64") },
    ],
  };
}

function inspectClickScript(ref: string): string {
  return `(() => {
    const element = document.querySelector('[data-zeros-browser-ref="${ref}"]');
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "The selected element is disabled." };
    const form = element.closest("form");
    const inputType = String(element.getAttribute("type") || "").toLowerCase();
    const tagName = element.tagName;
    const submitsForm = Boolean(form && ((tagName === "BUTTON" && (!inputType || inputType === "submit")) || (tagName === "INPUT" && (inputType === "submit" || inputType === "image"))));
    const label = (element.getAttribute("aria-label") || element.innerText || element.value || element.title || element.name || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    return { ok: true, label, tagName, inputType, submitsForm };
  })()`;
}

function clickScript(ref: string): string {
  return `(() => {
    const element = document.querySelector('[data-zeros-browser-ref="${ref}"]');
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return { ok: true };
  })()`;
}

function inspectInputScript(ref: string): string {
  return `(() => {
    const element = document.querySelector('[data-zeros-browser-ref="${ref}"]');
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    const inputType = String(element.getAttribute("type") || (element.isContentEditable ? "contenteditable" : "text")).toLowerCase();
    const label = (element.getAttribute("aria-label") || element.placeholder || element.name || element.labels?.[0]?.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300);
    return { ok: true, inputType, label };
  })()`;
}

function typeScript(
  ref: string,
  text: string,
  clear: boolean,
  redactValue: boolean,
): string {
  return `(() => {
    const element = document.querySelector('[data-zeros-browser-ref="${ref}"]');
    if (!element) return { ok: false, error: "Unknown or stale browser ref; take a new snapshot." };
    const text = ${JSON.stringify(text)};
    element.scrollIntoView({ block: "center", inline: "center" });
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

async function setFileInput(
  webContents: WebContents,
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
    if (!nodeId) throw new Error("The browser document is unavailable.");
    const match = (await debug.sendCommand("DOM.querySelector", {
      nodeId,
      selector: `[data-zeros-browser-ref="${ref}"]`,
    })) as { nodeId?: number };
    if (!match.nodeId) throw new Error("Unknown or stale browser ref.");
    await debug.sendCommand("DOM.setFileInputFiles", {
      nodeId: match.nodeId,
      files: [filePath],
    });
  } finally {
    if (attachedHere && debug.isAttached()) debug.detach();
  }
}

function annotationOverlayScript(annotations: BrowserAnnotation[]): string {
  return `(() => {
    document.getElementById("__zeros-browser-annotations")?.remove();
    const root = document.createElement("div");
    root.id = "__zeros-browser-annotations";
    root.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    const annotations = ${JSON.stringify(annotations)};
    for (const annotation of annotations) {
      const element = document.querySelector('[data-zeros-browser-ref="' + annotation.ref + '"]');
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

function annotationCleanupScript(): string {
  return `document.getElementById("__zeros-browser-annotations")?.remove()`;
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
    throw new Error("Invalid Zeros browser owner.");
  }
  const workspaceRoot = await realpath(owner.workspaceRoot);
  return {
    workspaceId: owner.workspaceId,
    conversationId: owner.conversationId,
    workspaceRoot,
  };
}

function ownerKey(owner: BrowserSessionOwner): string {
  return `${owner.workspaceId}\u0000${owner.conversationId}`;
}

function publishState(
  options: ZerosBrowserServiceOptions,
  record: BrowserSessionRecord,
  status: BrowserSessionState["status"],
  tool?: BrowserSessionState["tool"],
): void {
  const contents = record.lease?.view.webContents;
  options.onSessionState?.({
    browserSessionId: record.id,
    workspaceId: record.owner.workspaceId,
    conversationId: record.owner.conversationId,
    url: contents && !contents.isDestroyed() ? contents.getURL() : "",
    title:
      contents && !contents.isDestroyed() ? contents.getTitle() : "Browser",
    loading: Boolean(
      contents && !contents.isDestroyed() && contents.isLoading(),
    ),
    status,
    ...(tool ? { tool } : {}),
  });
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
  lease.viewport = { width, height };
  lease.view.setBounds({ x: 0, y: 0, width, height });
}

async function destroyLease(lease: BrowserLease): Promise<void> {
  lease.disposeNetworkHandlers();
  lease.disposePermissionHandlers();
  lease.disposeDownloadHandler();
  lease.view.setVisible(false);
  if (!lease.parkingWindow.isDestroyed()) {
    lease.parkingWindow.contentView.removeChildView(lease.view);
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

function recordTrace(lease: BrowserLease, type: string, detail: string): void {
  lease.trace.push({
    at: Date.now(),
    type: type.slice(0, 80),
    detail: detail.replace(/\s+/g, " ").slice(0, 2_000),
  });
  if (lease.trace.length > 2_000) lease.trace.shift();
}

function trackHostAction(lease: BrowserLease, action: Promise<void>): void {
  lease.pendingHostActions.add(action);
  void action
    .catch(() => undefined)
    .finally(() => lease.pendingHostActions.delete(action));
}

async function waitForHostActions(lease: BrowserLease): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  while (lease.pendingHostActions.size > 0) {
    await Promise.allSettled([...lease.pendingHostActions]);
  }
}

async function settleAfterAction(webContents: WebContents): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 75));
  if (webContents.isLoading()) await waitForLoad(webContents);
}

async function waitForLoad(webContents: WebContents): Promise<void> {
  if (!webContents.isLoading()) return;
  await withTimeout(
    new Promise<void>((resolve) => {
      const done = () => {
        webContents.off("did-finish-load", done);
        webContents.off("did-fail-load", done);
        resolve();
      };
      webContents.once("did-finish-load", done);
      webContents.once("did-fail-load", done);
      // Loading may finish between the outer check and listener registration.
      if (!webContents.isLoading()) done();
    }),
    NAVIGATION_TIMEOUT_MS,
    "Page navigation timed out.",
  );
}

function normalizeWebUrl(value: string): string {
  if (value.length > 8_192) throw new Error("Browser URL is too long.");
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Browser navigation requires a credential-free HTTP(S) URL.",
    );
  }
  return url.href;
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
  if (typeof value !== "string" || !/^b[1-9]\d{0,8}$/.test(value)) {
    throw new Error("Browser element ref is invalid.");
  }
  return value;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Browser ${name} must be a non-empty string.`);
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
    throw new Error(
      `Browser ${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Zeros browser ${label} is invalid.`);
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
    throw new Error("Zeros browser response exceeded its size limit.");
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
      throw new Error("Zeros browser request is too large.");
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
  response.statusCode = status;
  response.end(JSON.stringify(value));
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
