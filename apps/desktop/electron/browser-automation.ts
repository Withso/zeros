import {
  BaseWindow,
  BrowserWindow,
  desktopCapturer,
  screen,
  session,
  systemPreferences,
  WebContentsView,
  type DownloadItem,
  type Session,
  type WebContents,
} from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  startCodexBrowserUsePipe,
  type CodexBrowserUsePipeHandle,
  type CodexBrowserUseRequest,
} from "./codex-browser-use-pipe";
import {
  BrowserConfirmationBroker,
  classifyBrowserClick,
  classifyBrowserInput,
  type BrowserConfirmationDecision,
  type BrowserApprovalPolicy,
  type BrowserConfirmationRequest,
  type BrowserRiskCategory,
} from "./browser-confirmations";
import {
  persistBrowserScreenshot,
  persistBrowserTrace,
  type BrowserTraceEvent,
} from "./browser-artifacts";
import { parseBrowserAnnotations } from "./browser-annotations";
import { parseBrowserCdpRequest } from "./browser-cdp";
import {
  allocateBrowserDownload,
  validateBrowserUpload,
} from "./browser-files";
import { handleBrowserMcpRequest } from "./browser-mcp";
import {
  normalizeManagedCloudEndpoint,
  normalizeBrowserProviderConfiguration,
  type BrowserProviderConfiguration,
} from "./browser-provider";
import {
  connectManagedCloudBrowser,
  SharedChromeBrowserProvider,
} from "./shared-chrome-browser";
import {
  MacComputerUseProvider,
  type MacComputerKey,
} from "./macos-computer-use";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_SESSIONS = 8;
const IDLE_LEASE_MS = 20 * 60_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const BROWSER_USE_BOOTSTRAP_TIMEOUT_MS = 10_000;
const BROWSER_USE_CDP_TIMEOUT_MS = 30_000;
const BROWSER_USE_CDP_MAX_TIMEOUT_MS = 120_000;
const MAX_VIEWPORT = { width: 2560, height: 1800 };
const MIN_VIEWPORT = { width: 320, height: 320 };
const MAX_MCP_SESSIONS = 64;

interface McpBrowserSession {
  touchedAt: number;
  leaseKey: string;
  taskBound: boolean;
}

type ContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

interface ToolResponse {
  success: boolean;
  contentItems: ContentItem[];
}

interface ToolRequest {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

interface BrowserLease {
  leaseKey: string;
  /** The browser is born as a detachable view. A WebContents owned by a
   * BrowserWindow cannot later be adopted by WebContentsView, so keeping one
   * surface from creation is what makes headless agent use and visible user
   * handoff genuinely share the same page. */
  view: WebContentsView;
  parkingWindow: BaseWindow;
  attachedTo: BaseWindow | null;
  viewport: { width: number; height: number };
  touchedAt: number;
  expires: NodeJS.Timeout;
  consoleErrors: string[];
  networkErrors: string[];
  downloads: BrowserDownloadArtifact[];
  pendingHostActions: Set<Promise<void>>;
  trace: BrowserTraceEvent[];
  browserUseReady: Promise<void> | null;
  actor: "agent" | "user";
  pointer: BrowserAgentPointer | null;
  disposeNetworkHandlers: () => void;
  disposeBrowserUseDebugger: () => void;
}

interface BrowserDownloadArtifact {
  kind: "browser-download";
  path: string;
  name: string;
  mimeType: string;
  size: number;
  url: string;
  downloadedAt: number;
}

export interface BrowserSessionBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserSessionState {
  taskId: string;
  url: string;
  title: string;
  loading: boolean;
  status: "working" | "awaiting-confirmation" | "ready" | "closed";
  tool?: string;
  actor?: "agent" | "user";
  pointer?: BrowserAgentPointer;
  provider?: BrowserProviderConfiguration["provider"];
}

export interface BrowserAgentPointer {
  x: number;
  y: number;
  action: "move" | "click" | "type";
  updatedAt: number;
}

export interface BrowserAutomationServerOptions {
  onSessionState?: (state: BrowserSessionState) => void;
  onConfirmationRequest?: (request: BrowserConfirmationRequest) => void;
  /** Absolute app-data directory for durable screenshot evidence. Omit only
   * in tests that intentionally exercise an ephemeral browser host. */
  artifactRoot?: string;
  /** Raw CDP is a developer-only escape hatch. It remains off unless the
   * trusted settings surface enables it, and each method is still confirmed. */
  developerCdpEnabled?: boolean;
  providerConfiguration?: BrowserProviderConfiguration;
}

export interface BrowserAutomationServerHandle {
  url: string;
  token: string;
  /** Native Codex Browser Use discovery endpoint. Exposed for the packaged
   * smoke harness; production consumers discover it through Node REPL. */
  codexBrowserUsePipePath: string;
  attach(
    taskId: string,
    target: BrowserWindow,
    bounds: BrowserSessionBounds,
  ): BrowserSessionState | null;
  detach(taskId: string): boolean;
  control(
    taskId: string,
    tool: "open" | "back" | "forward" | "reload",
    args?: Record<string, unknown>,
  ): Promise<ToolResponse>;
  respondToConfirmation(
    confirmationId: string,
    decision: BrowserConfirmationDecision,
  ): boolean;
  clearSiteApprovals(taskId: string): number;
  setApprovalPolicy(policy: BrowserApprovalPolicy): void;
  setDeveloperCdpEnabled(enabled: boolean): void;
  setProvider(configuration: BrowserProviderConfiguration): Promise<void>;
  probeProvider(): Promise<Record<string, unknown>>;
  requestComputerUsePermissions(): Promise<Record<string, unknown>>;
  providerConfiguration():
    | { provider: "isolated" }
    | { provider: "shared-chrome"; endpoint: string }
    | { provider: "managed-cloud"; endpoint: string; hasToken: boolean }
    | { provider: "system-computer-use" };
  stop(): Promise<void>;
}

const SNAPSHOT_SCRIPT = String.raw`(() => {
  const stateKey = "__zerosBrowserRefCounter";
  const attr = "data-zeros-browser-ref";
  const root = document.documentElement;
  let counter = Number(root.getAttribute(stateKey) || "0");
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
    let ref = element.getAttribute(attr);
    if (!ref) {
      counter += 1;
      ref = "b" + counter;
      element.setAttribute(attr, ref);
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
  root.setAttribute(stateKey, String(counter));
  return {
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight },
    text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 24000),
    elements
  };
})()`;

/** Starts the main-process half of Codex dynamic browser tools. The HTTP hop is
 * loopback-only and bearer-authenticated because the engine is a separate
 * process. Web content runs in an ephemeral Electron session, never in the
 * renderer iframe or the user's Chrome/Codex profile. */
export async function startBrowserAutomationServer(
  options: BrowserAutomationServerOptions = {},
): Promise<BrowserAutomationServerHandle> {
  const token = randomBytes(32).toString("base64url");
  const leases = new Map<string, BrowserLease>();
  const providerHandoffs = new Map<string, string>();
  const mcpSessions = new Map<string, McpBrowserSession>();
  const codexBrowserSessions = new Map<
    string,
    { taskId: string; touchedAt: number }
  >();
  const confirmations = new BrowserConfirmationBroker({
    onRequest: options.onConfirmationRequest,
  });
  let providerConfiguration = normalizeBrowserProviderConfiguration(
    options.providerConfiguration ?? { provider: "isolated" },
  );
  const sharedChrome = new SharedChromeBrowserProvider({
    artifactRoot: options.artifactRoot,
    confirmations,
    developerCdpEnabled: () => options.developerCdpEnabled === true,
  });
  const managedCloud = new SharedChromeBrowserProvider({
    artifactRoot: options.artifactRoot,
    confirmations,
    developerCdpEnabled: () => options.developerCdpEnabled === true,
    providerName: "managed-cloud",
    normalizeEndpoint: normalizeManagedCloudEndpoint,
    connect: (endpoint) =>
      connectManagedCloudBrowser(
        endpoint,
        providerConfiguration.provider === "managed-cloud"
          ? providerConfiguration.bearerToken
          : undefined,
      ),
    redactSecrets: () =>
      providerConfiguration.provider === "managed-cloud" &&
      providerConfiguration.bearerToken
        ? [providerConfiguration.bearerToken]
        : [],
  });
  const macComputerUse = new MacComputerUseProvider(
    {
      platform: process.platform,
      accessibilityTrusted: (prompt) =>
        process.platform === "darwin" &&
        systemPreferences.isTrustedAccessibilityClient(prompt),
      screenPermission: () =>
        process.platform === "darwin"
          ? systemPreferences.getMediaAccessStatus("screen")
          : "not-determined",
      captureScreen: capturePrimaryDisplay,
      click: (x, y) =>
        runAppleScript(
          [
            "on run argv",
            "set px to (item 1 of argv) as integer",
            "set py to (item 2 of argv) as integer",
            'tell application "System Events" to click at {px, py}',
            "end run",
          ],
          [String(x), String(y)],
        ),
      typeText: (text) =>
        runAppleScript(
          [
            "on run argv",
            'tell application "System Events" to keystroke (item 1 of argv)',
            "end run",
          ],
          [text],
        ),
      pressKey: (key) => pressMacComputerKey(key),
    },
    confirmations,
  );
  if (providerConfiguration.provider === "shared-chrome") {
    await sharedChrome.configure(providerConfiguration.endpoint);
  } else if (providerConfiguration.provider === "managed-cloud") {
    await managedCloud.configure(providerConfiguration.endpoint);
  }
  const browserUsePipe = await startCodexBrowserUsePipe({
    onRequest: (request) =>
      handleCodexBrowserUseRequest(
        request,
        codexBrowserSessions,
        leases,
        options,
        confirmations,
        browserUsePipe,
      ),
  });
  const server: Server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      requestUrl.pathname === "/codex-browser-use/register" &&
      request.method === "POST" &&
      tokenMatches(request, token)
    ) {
      try {
        const body = asRecord(await readJsonBody(request));
        const taskId = requireBinding(body.taskId, "taskId");
        const sessionId = requireBinding(body.sessionId, "sessionId");
        codexBrowserSessions.set(sessionId, { taskId, touchedAt: Date.now() });
        pruneCodexBrowserSessions(codexBrowserSessions);
        response.statusCode = 200;
        response.end(JSON.stringify({ registered: true }));
      } catch (error) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            registered: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return;
    }
    if (requestUrl.pathname === "/mcp" && tokenMatches(request, token)) {
      const requestedTaskId = requestUrl.searchParams.get("taskId");
      const taskLeaseKey = requestedTaskId
        ? browserTaskLeaseKey(requestedTaskId)
        : null;
      if (requestedTaskId && !taskLeaseKey) {
        response.statusCode = 400;
        response.end(
          JSON.stringify({ error: "Invalid browser task binding." }),
        );
        return;
      }
      const suppliedSession = request.headers["mcp-session-id"];
      const mcpSessionId = Array.isArray(suppliedSession)
        ? suppliedSession[0]
        : suppliedSession;

      if (request.method === "DELETE") {
        if (mcpSessionId) {
          const binding = mcpSessions.get(mcpSessionId);
          mcpSessions.delete(mcpSessionId);
          // A transport session ending must not erase a task-bound browser:
          // Codex routinely reconnects/resumes App Server sessions. The lease
          // remains available until the browser close tool or idle eviction.
          if (binding && !binding.taskBound) {
            const lease = leases.get(binding.leaseKey);
            if (lease) destroyLease(lease);
            leases.delete(binding.leaseKey);
          }
        }
        response.statusCode = 204;
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.statusCode = 405;
        response.setHeader("allow", "POST, DELETE");
        response.end(JSON.stringify({ error: "Method not allowed." }));
        return;
      }

      try {
        const body = await readJsonBody(request);
        const method = asRecord(body).method;
        let activeSession = mcpSessionId;
        if (method === "initialize") {
          activeSession = randomBytes(18).toString("base64url");
          pruneMcpSessions(mcpSessions);
          mcpSessions.set(activeSession, {
            touchedAt: Date.now(),
            leaseKey: taskLeaseKey ?? `mcp:${activeSession}`,
            taskBound: taskLeaseKey !== null,
          });
          response.setHeader("mcp-session-id", activeSession);
        } else if (!activeSession || !mcpSessions.has(activeSession)) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: "Unknown MCP session." }));
          return;
        } else {
          const binding = mcpSessions.get(activeSession)!;
          // A client cannot retarget a live MCP transport by changing its URL.
          if (taskLeaseKey && taskLeaseKey !== binding.leaseKey) {
            response.statusCode = 409;
            response.end(
              JSON.stringify({ error: "Browser task binding changed." }),
            );
            return;
          }
          binding.touchedAt = Date.now();
        }

        const binding = mcpSessions.get(activeSession!);
        if (!binding)
          throw new Error("Browser MCP session was not initialized.");

        const reply = await handleBrowserMcpRequest(
          body,
          ({ name, arguments: args }) =>
            executeTool(
              leases,
              providerHandoffs,
              {
                threadId: binding.leaseKey,
                turnId: "mcp",
                callId: String(
                  asRecord(body).id ?? randomBytes(8).toString("hex"),
                ),
                namespace: "zeros_browser",
                tool: name,
                arguments: args,
              },
              options,
              confirmations,
              providerConfiguration,
              sharedChrome,
              managedCloud,
              macComputerUse,
            ),
        );
        response.statusCode = reply.status;
        response.end(reply.body ? JSON.stringify(reply.body) : undefined);
      } catch (error) {
        response.statusCode = 200;
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      }
      return;
    }
    if (
      request.method !== "POST" ||
      request.url !== "/tool" ||
      !tokenMatches(request, token)
    ) {
      response.statusCode = 404;
      response.end(JSON.stringify(failure("Browser host request rejected.")));
      return;
    }
    try {
      const body = await readJsonBody(request);
      const toolRequest = parseToolRequest(body);
      const result = await executeTool(
        leases,
        providerHandoffs,
        toolRequest,
        options,
        confirmations,
        providerConfiguration,
        sharedChrome,
        managedCloud,
        macComputerUse,
      );
      response.statusCode = 200;
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = 200;
      response.end(
        JSON.stringify(
          failure(error instanceof Error ? error.message : String(error)),
        ),
      );
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
    throw new Error("Browser automation host did not bind a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/tool`,
    token,
    codexBrowserUsePipePath: browserUsePipe.path,
    attach(taskId, target, bounds) {
      if (providerConfiguration.provider !== "isolated") return null;
      const leaseKey = browserTaskLeaseKey(taskId);
      const safeBounds = normalizeBrowserBounds(bounds);
      if (!leaseKey || !safeBounds) return null;
      const lease = leases.get(leaseKey);
      if (!lease || lease.view.webContents.isDestroyed()) return null;
      if (lease.attachedTo && lease.attachedTo !== target) {
        lease.attachedTo.contentView.removeChildView(lease.view);
      }
      if (lease.attachedTo !== target) {
        target.contentView.addChildView(lease.view);
        lease.attachedTo = target;
      } else {
        // Re-adding moves the browser above sibling native views without
        // allocating another WebContentsView.
        target.contentView.addChildView(lease.view);
      }
      lease.view.setBounds(safeBounds);
      lease.view.setVisible(true);
      lease.viewport = {
        width: safeBounds.width,
        height: safeBounds.height,
      };
      touchLease(leaseKey, lease, leases, confirmations);
      return browserSessionState(lease, "ready");
    },
    detach(taskId) {
      const leaseKey = browserTaskLeaseKey(taskId);
      if (!leaseKey) return false;
      const lease = leases.get(leaseKey);
      if (!lease || lease.view.webContents.isDestroyed()) return false;
      parkLease(lease);
      return true;
    },
    control(taskId, tool, args = {}) {
      const leaseKey = browserTaskLeaseKey(taskId);
      if (!leaseKey)
        return Promise.resolve(failure("Invalid browser task binding."));
      return executeTool(
        leases,
        providerHandoffs,
        {
          threadId: leaseKey,
          turnId: "user",
          callId: randomBytes(8).toString("hex"),
          namespace: "zeros_browser",
          tool,
          arguments: args,
        },
        options,
        confirmations,
        providerConfiguration,
        sharedChrome,
        managedCloud,
        macComputerUse,
      );
    },
    respondToConfirmation(confirmationId, decision) {
      return confirmations.respond(confirmationId, decision);
    },
    clearSiteApprovals(taskId) {
      return confirmations.clearSiteApprovals(taskId);
    },
    setApprovalPolicy(policy) {
      confirmations.setApprovalPolicy(policy);
    },
    setDeveloperCdpEnabled(enabled) {
      options.developerCdpEnabled = enabled;
      if (enabled) return;
      for (const lease of leases.values()) {
        const taskId = taskIdFromLeaseKey(lease.leaseKey);
        if (taskId) confirmations.clearSiteApprovals(taskId);
        if (lease.view.webContents.debugger.isAttached()) {
          lease.view.webContents.debugger.detach();
        }
      }
    },
    async setProvider(configuration) {
      const next = normalizeBrowserProviderConfiguration(configuration);
      if (
        next.provider === providerConfiguration.provider &&
        (next.provider !== "shared-chrome" ||
          (providerConfiguration.provider === "shared-chrome" &&
            next.endpoint === providerConfiguration.endpoint)) &&
        (next.provider !== "managed-cloud" ||
          (providerConfiguration.provider === "managed-cloud" &&
            next.endpoint === providerConfiguration.endpoint &&
            next.bearerToken === providerConfiguration.bearerToken))
      ) {
        return;
      }
      for (const [leaseKey, lease] of leases) {
        const taskId = taskIdFromLeaseKey(leaseKey);
        if (taskId)
          rememberProviderHandoff(
            providerHandoffs,
            taskId,
            lease.view.webContents.getURL(),
          );
      }
      for (const taskId of sharedChrome.activeTaskIds()) {
        rememberProviderHandoff(
          providerHandoffs,
          taskId,
          sharedChrome.state(taskId)?.url,
        );
      }
      for (const taskId of managedCloud.activeTaskIds()) {
        rememberProviderHandoff(
          providerHandoffs,
          taskId,
          managedCloud.state(taskId)?.url,
        );
      }
      for (const [leaseKey, lease] of leases) {
        publishBrowserState(
          options,
          leaseKey,
          null,
          "closed",
          "provider-switch",
        );
        destroyLease(lease);
      }
      leases.clear();
      for (const taskId of sharedChrome.activeTaskIds()) {
        publishExternalBrowserState(
          options,
          taskId,
          sharedChrome,
          "shared-chrome",
          "closed",
          "provider-switch",
        );
      }
      for (const taskId of managedCloud.activeTaskIds()) {
        publishExternalBrowserState(
          options,
          taskId,
          managedCloud,
          "managed-cloud",
          "closed",
          "provider-switch",
        );
      }
      confirmations.stop();
      await sharedChrome.stop();
      await managedCloud.stop();
      if (next.provider === "shared-chrome") {
        await sharedChrome.configure(next.endpoint);
      }
      if (next.provider === "managed-cloud") {
        await managedCloud.configure(next.endpoint);
      }
      providerConfiguration = next;
    },
    async probeProvider() {
      return providerConfiguration.provider === "shared-chrome"
        ? sharedChrome.probe()
        : providerConfiguration.provider === "managed-cloud"
          ? managedCloud.probe()
          : providerConfiguration.provider === "system-computer-use"
            ? macComputerUse.probe(false)
            : { connected: true, provider: "isolated" };
    },
    async requestComputerUsePermissions() {
      return macComputerUse.requestPermissions();
    },
    providerConfiguration() {
      return providerConfiguration.provider === "managed-cloud"
        ? {
            provider: "managed-cloud",
            endpoint: providerConfiguration.endpoint,
            hasToken: Boolean(providerConfiguration.bearerToken),
          }
        : providerConfiguration;
    },
    async stop() {
      confirmations.stop();
      for (const lease of leases.values()) destroyLease(lease);
      leases.clear();
      await sharedChrome.stop();
      await managedCloud.stop();
      await browserUsePipe.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleCodexBrowserUseRequest(
  request: CodexBrowserUseRequest,
  sessions: Map<string, { taskId: string; touchedAt: number }>,
  leases: Map<string, BrowserLease>,
  options: BrowserAutomationServerOptions,
  confirmations: BrowserConfirmationBroker,
  pipe: CodexBrowserUsePipeHandle,
): Promise<unknown> {
  const binding = sessions.get(request.sessionId);
  if (!binding) {
    throw new Error("Browser turn does not belong to this Zeros task.");
  }
  binding.touchedAt = Date.now();
  const leaseKey = browserTaskLeaseKey(binding.taskId);
  if (!leaseKey) throw new Error("Invalid browser task binding.");
  const current = () => leases.get(leaseKey);
  const requireLease = (): BrowserLease => {
    const lease = current();
    if (!lease || lease.view.webContents.isDestroyed()) {
      throw new Error("Browser tab is no longer available.");
    }
    touchLease(leaseKey, lease, leases, confirmations);
    return lease;
  };
  const tabInfo = (lease: BrowserLease) => ({
    id: lease.view.webContents.id,
    url: lease.view.webContents.getURL() || "about:blank",
    title: lease.view.webContents.getTitle() || "New tab",
    active: true,
  });

  switch (request.method) {
    case "getInfo":
      return {
        type: "iab",
        name: "Zeros Isolated Browser",
        family: "chrome",
        capabilities: { browser: [], tab: [] },
        metadata: {
          codexSessionId: request.sessionId,
          codexAppBuildFlavor: "prod",
          host: "zeros",
        },
      };
    case "ping":
      return "pong";
    case "getTabs": {
      const lease = current();
      return lease && !lease.view.webContents.isDestroyed()
        ? [tabInfo(lease)]
        : [];
    }
    case "getUserTabs":
    case "getUserHistory":
      return [];
    case "createTab": {
      let lease = current();
      if (!lease || lease.view.webContents.isDestroyed()) {
        lease = createLease(leaseKey, leases, options, confirmations);
        leases.set(leaseKey, lease);
        publishBrowserState(options, leaseKey, lease, "ready", "create-tab");
      }
      try {
        await ensureCodexBrowserUseReady(lease);
        ensureCodexBrowserUseDebugger(lease, pipe);
      } catch (error) {
        if (current() === lease) {
          leases.delete(leaseKey);
          confirmations.clearTask(binding.taskId);
          publishBrowserState(
            options,
            leaseKey,
            null,
            "closed",
            "browser-bootstrap-failed",
          );
          destroyLease(lease);
        }
        throw error;
      }
      touchLease(leaseKey, lease, leases, confirmations);
      return tabInfo(lease);
    }
    case "attach": {
      const lease = requireLease();
      assertCodexBrowserTab(request.params, lease);
      ensureCodexBrowserUseDebugger(lease, pipe);
      return {};
    }
    case "detach": {
      const lease = requireLease();
      assertCodexBrowserTab(request.params, lease);
      return {};
    }
    case "focusTab": {
      const lease = requireLease();
      assertCodexBrowserTab(request.params, lease);
      return {};
    }
    case "nameSession":
    case "markTab":
    case "finalizeTabs":
    case "turnEnded":
      return {};
    case "isFullCdpEnabled":
      return false;
    case "moveMouse": {
      const lease = requireLease();
      lease.actor = "agent";
      assertCodexBrowserTab(request.params, lease);
      ensureCodexBrowserUseDebugger(lease, pipe);
      const x = numberField(request.params, "x");
      const y = numberField(request.params, "y");
      await updateAgentPointer(lease, x, y, "move");
      publishBrowserState(
        options,
        leaseKey,
        lease,
        "working",
        "Input.dispatchMouseEvent",
      );
      try {
        await withTimeout(
          lease.view.webContents.debugger.sendCommand(
            "Input.dispatchMouseEvent",
            { type: "mouseMoved", x, y },
          ),
          BROWSER_USE_CDP_TIMEOUT_MS,
          nativeBrowserCommandTimeoutMessage("Input.dispatchMouseEvent"),
        );
        return {};
      } finally {
        if (current() === lease && !lease.view.webContents.isDestroyed()) {
          publishBrowserState(
            options,
            leaseKey,
            lease,
            "ready",
            "Input.dispatchMouseEvent",
          );
        }
      }
    }
    case "executeCdp": {
      const lease = requireLease();
      lease.actor = "agent";
      ensureCodexBrowserUseDebugger(lease, pipe);
      const target = asRecord(request.params.target);
      assertCodexBrowserTab(target, lease);
      const method = requireString(request.params.method, "method");
      const commandParams = asRecord(request.params.commandParams);
      if (method === "Page.close" || method === "Target.closeTarget") {
        destroyLease(lease);
        leases.delete(leaseKey);
        confirmations.clearTask(binding.taskId);
        publishBrowserState(options, leaseKey, null, "closed", "close-tab");
        return {};
      }
      const sessionId =
        typeof target.sessionId === "string" ? target.sessionId : undefined;
      const timeoutMs = browserUseCommandTimeout(request.params.timeoutMs);
      const pointer = pointerFromCdpCommand(method, commandParams);
      if (pointer) {
        await updateAgentPointer(lease, pointer.x, pointer.y, pointer.action);
      }
      publishBrowserState(options, leaseKey, lease, "working", method);
      try {
        if (method === "Page.captureScreenshot") {
          try {
            return await withTimeout(
              lease.view.webContents.debugger.sendCommand(
                method,
                commandParams,
                sessionId,
              ),
              5_000,
              "Native browser screenshot timed out.",
            );
          } catch {
            // Electron's compositor capture remains useful for detached views
            // where raw CDP screenshots require a visible target.
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
            nativeBrowserCommandTimeoutMessage(method),
          );
          const format = commandParams.format === "jpeg" ? "jpeg" : "png";
          const data =
            format === "jpeg"
              ? image.toJPEG(
                  Math.min(
                    100,
                    Math.max(
                      0,
                      Math.round(Number(commandParams.quality ?? 80)),
                    ),
                  ),
                )
              : image.toPNG();
          return { data: data.toString("base64") };
        }
        return await withTimeout(
          lease.view.webContents.debugger.sendCommand(
            method,
            commandParams,
            sessionId,
          ),
          timeoutMs,
          nativeBrowserCommandTimeoutMessage(method),
        );
      } catch (error) {
        if (isNativeBrowserCommandTimeout(error) && current() === lease) {
          leases.delete(leaseKey);
          confirmations.clearTask(binding.taskId);
          publishBrowserState(
            options,
            leaseKey,
            null,
            "closed",
            `cdp-timeout:${method}`,
          );
          destroyLease(lease);
        }
        throw error;
      } finally {
        if (current() === lease && !lease.view.webContents.isDestroyed()) {
          publishBrowserState(options, leaseKey, lease, "ready", method);
        }
      }
    }
    case "attachTarget":
    case "detachTarget":
      return {};
    case "allowDownload":
      throw new Error("Use Zeros browser download confirmation.");
    default:
      throw new Error(
        `Unsupported Zeros Browser Use method: ${request.method}`,
      );
  }
}

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
    pipe.notify("onCDPEvent", {
      source: {
        tabId: contents.id,
        ...(sessionId ? { sessionId } : {}),
      },
      method,
      params: asRecord(params),
    });
  };
  const onDetach = () => {
    pipe.notify("onCDPDetach", { tabId: contents.id });
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

async function ensureCodexBrowserUseReady(lease: BrowserLease): Promise<void> {
  if (lease.browserUseReady) return await lease.browserUseReady;
  const contents = lease.view.webContents;
  const pending = (async () => {
    if (contents.isDestroyed()) {
      throw new Error("Browser tab is no longer available.");
    }
    // A WebContentsView does not necessarily create its renderer until its
    // first navigation. Codex Browser Use evaluates the current document
    // before issuing Page.navigate, so explicitly commit a blank document.
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

const NOOP = () => undefined;

function assertCodexBrowserTab(
  value: Record<string, unknown>,
  lease: BrowserLease,
): void {
  const tabId = Number(value.tabId ?? value.tab_id);
  if (tabId !== lease.view.webContents.id) {
    throw new Error("Browser tab does not belong to this Zeros task.");
  }
}

function numberField(value: Record<string, unknown>, key: string): number {
  const result = Number(value[key]);
  if (!Number.isFinite(result)) throw new Error(`Invalid ${key}.`);
  return result;
}

function requireBinding(value: unknown, name: string): string {
  const binding = requireString(value, name).trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(binding)) {
    throw new Error(`Invalid ${name}.`);
  }
  return binding;
}

function pruneCodexBrowserSessions(
  sessions: Map<string, { taskId: string; touchedAt: number }>,
): void {
  while (sessions.size > MAX_MCP_SESSIONS) {
    const oldest = [...sessions.entries()].sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt,
    )[0];
    if (!oldest) return;
    sessions.delete(oldest[0]);
  }
}

function pruneMcpSessions(sessions: Map<string, McpBrowserSession>): void {
  while (sessions.size >= MAX_MCP_SESSIONS) {
    const oldest = [...sessions.entries()].sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt,
    )[0];
    if (!oldest) return;
    sessions.delete(oldest[0]);
  }
}

function browserTaskLeaseKey(taskId: string): string | null {
  const value = taskId.trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) return null;
  return `task:${value}`;
}

function rememberProviderHandoff(
  handoffs: Map<string, string>,
  taskId: string,
  rawUrl: string | undefined,
): void {
  if (!browserTaskLeaseKey(taskId) || !rawUrl) return;
  try {
    handoffs.set(taskId, normalizeWebUrl(rawUrl));
  } catch {
    return;
  }
  while (handoffs.size > MAX_SESSIONS * 3) {
    const oldest = handoffs.keys().next().value;
    if (typeof oldest !== "string") break;
    handoffs.delete(oldest);
  }
}

async function restoreExternalProviderHandoff(
  handoffs: Map<string, string>,
  provider: SharedChromeBrowserProvider,
  taskId: string,
  request: ToolRequest,
): Promise<ToolResponse | null> {
  if (request.tool === "close" || request.tool === "open") {
    handoffs.delete(taskId);
    return null;
  }
  if (provider.state(taskId)) return null;
  const url = handoffs.get(taskId);
  if (!url) return null;
  const restored = await provider.execute({
    taskId,
    tool: "open",
    arguments: { url },
  });
  if (restored.success) handoffs.delete(taskId);
  return restored;
}

async function executeTool(
  leases: Map<string, BrowserLease>,
  providerHandoffs: Map<string, string>,
  request: ToolRequest,
  options: BrowserAutomationServerOptions = {},
  confirmations: BrowserConfirmationBroker,
  providerConfiguration: BrowserProviderConfiguration,
  sharedChrome: SharedChromeBrowserProvider,
  managedCloud: SharedChromeBrowserProvider,
  macComputerUse: MacComputerUseProvider,
): Promise<ToolResponse> {
  if (request.namespace !== "zeros_browser")
    return failure("Unsupported browser namespace.");
  const sharedTaskId = taskIdFromLeaseKey(request.threadId);
  // The agent-provider selector controls Codex automation tasks. Ordinary
  // workbench Browser tabs are always Zeros-owned native WebContentsViews;
  // routing them into Shared Chrome/System Computer Use would leave their
  // in-app rectangle blank and make the address controls target another app.
  const providerTaskId =
    sharedTaskId && !sharedTaskId.startsWith("user-browser:")
      ? sharedTaskId
      : null;
  if (
    providerConfiguration.provider === "system-computer-use" &&
    providerTaskId
  ) {
    if (request.tool === "close") {
      providerHandoffs.delete(providerTaskId);
      confirmations.clearTask(providerTaskId);
      options.onSessionState?.({
        taskId: providerTaskId,
        url: "",
        title: "System Computer Use",
        loading: false,
        status: "closed",
        provider: "system-computer-use",
        tool: "close",
      });
      return textSuccess({ closed: true, provider: "system-computer-use" });
    }
    if (!request.tool.startsWith("computer_")) {
      return failure(
        "System Computer Use is screenshot-driven. Use computer_screenshot, computer_click, computer_type, or computer_key.",
      );
    }
    return macComputerUse.execute(
      providerTaskId,
      request.tool,
      request.arguments,
    );
  }
  if (request.tool.startsWith("computer_")) {
    return failure(
      "Computer Use tools require the System Computer Use provider in Settings.",
    );
  }
  if (providerConfiguration.provider === "shared-chrome" && providerTaskId) {
    const restored = await restoreExternalProviderHandoff(
      providerHandoffs,
      sharedChrome,
      providerTaskId,
      request,
    );
    if (restored && (!restored.success || request.tool === "snapshot")) {
      publishExternalBrowserState(
        options,
        providerTaskId,
        sharedChrome,
        "shared-chrome",
        restored.success ? "ready" : "closed",
        "provider-handoff",
      );
      return restored;
    }
    publishExternalBrowserState(
      options,
      providerTaskId,
      sharedChrome,
      "shared-chrome",
      "working",
      request.tool,
    );
    const result = await sharedChrome.execute({
      taskId: providerTaskId,
      tool: request.tool,
      arguments: request.arguments,
    });
    publishExternalBrowserState(
      options,
      providerTaskId,
      sharedChrome,
      "shared-chrome",
      request.tool === "close" ? "closed" : "ready",
      request.tool,
    );
    return result;
  }
  if (providerConfiguration.provider === "managed-cloud" && providerTaskId) {
    const restored = await restoreExternalProviderHandoff(
      providerHandoffs,
      managedCloud,
      providerTaskId,
      request,
    );
    if (restored && (!restored.success || request.tool === "snapshot")) {
      publishExternalBrowserState(
        options,
        providerTaskId,
        managedCloud,
        "managed-cloud",
        restored.success ? "ready" : "closed",
        "provider-handoff",
      );
      return restored;
    }
    publishExternalBrowserState(
      options,
      providerTaskId,
      managedCloud,
      "managed-cloud",
      "working",
      request.tool,
    );
    const result = await managedCloud.execute({
      taskId: providerTaskId,
      tool: request.tool,
      arguments: request.arguments,
    });
    publishExternalBrowserState(
      options,
      providerTaskId,
      managedCloud,
      "managed-cloud",
      request.tool === "close" ? "closed" : "ready",
      request.tool,
    );
    return result;
  }
  const args = asRecord(request.arguments);
  if (request.tool === "close") {
    const existing = leases.get(request.threadId);
    if (existing) destroyLease(existing);
    leases.delete(request.threadId);
    const taskId = taskIdFromLeaseKey(request.threadId);
    if (taskId) {
      confirmations.clearTask(taskId);
      providerHandoffs.delete(taskId);
    }
    publishBrowserState(options, request.threadId, null, "closed", "close");
    return textSuccess({ closed: true });
  }

  let lease = leases.get(request.threadId);
  if (!lease) {
    const handoffUrl = sharedTaskId
      ? providerHandoffs.get(sharedTaskId)
      : undefined;
    if (request.tool !== "open" && !handoffUrl) {
      return failure("Open a URL before using this browser action.");
    }
    lease = createLease(request.threadId, leases, options, confirmations);
    leases.set(request.threadId, lease);
    if (request.tool !== "open" && handoffUrl) {
      try {
        await withTimeout(
          lease.view.webContents.loadURL(handoffUrl),
          NAVIGATION_TIMEOUT_MS,
          "Browser provider handoff timed out.",
        );
        providerHandoffs.delete(sharedTaskId!);
      } catch (error) {
        destroyLease(lease);
        leases.delete(request.threadId);
        publishBrowserState(
          options,
          request.threadId,
          null,
          "closed",
          "provider-handoff",
        );
        return failure(error instanceof Error ? error.message : String(error));
      }
    }
  }
  touchLease(request.threadId, lease, leases, confirmations);
  lease.actor = request.turnId === "user" ? "user" : "agent";
  recordTrace(lease, "tool", request.tool);
  publishBrowserState(
    options,
    request.threadId,
    lease,
    "working",
    request.tool,
  );

  switch (request.tool) {
    case "open": {
      resizeLease(lease, args.width, args.height);
      const url = normalizeWebUrl(requireString(args.url, "url"));
      if (sharedTaskId) providerHandoffs.delete(sharedTaskId);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "working",
        request.tool,
        url,
      );
      await withTimeout(
        lease.view.webContents.loadURL(url),
        NAVIGATION_TIMEOUT_MS,
        "Page navigation timed out.",
      );
      const response = await snapshotResponse(lease);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return response;
    }
    case "snapshot": {
      const response = await snapshotResponse(lease);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return response;
    }
    case "click": {
      const ref = requireRef(args.ref);
      const inspected = await lease.view.webContents.executeJavaScript(
        inspectClickScript(ref),
        true,
      );
      if (!inspected?.ok) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(String(inspected?.error ?? "Click failed."));
      }
      const category = classifyBrowserClick(String(inspected.label ?? ""));
      if (category) {
        const allowed = await confirmBrowserAction(
          lease,
          request,
          options,
          confirmations,
          category,
          String(inspected.label ?? "Browser action"),
        );
        if (!allowed) {
          return failure("The browser action was denied by the user.");
        }
      }
      await pointAgentAtRef(lease, ref, "click");
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "working",
        request.tool,
      );
      const result = await lease.view.webContents.executeJavaScript(
        clickScript(ref),
        true,
      );
      if (!result?.ok) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(String(result?.error ?? "Click failed."));
      }
      await settleAfterAction(lease.view.webContents);
      await waitForHostActions(lease);
      const response = await snapshotResponse(lease);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return response;
    }
    case "type": {
      const ref = requireRef(args.ref);
      const text = requireString(args.text, "text");
      if (text.length > 20_000)
        return failure("Text exceeds 20,000 characters.");
      const inspected = await lease.view.webContents.executeJavaScript(
        inspectInputScript(ref),
        true,
      );
      if (!inspected?.ok) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(String(inspected?.error ?? "Typing failed."));
      }
      const category = classifyBrowserInput(String(inspected.type ?? ""));
      if (category === "file-upload") {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure("Use the browser upload tool for file inputs.");
      }
      if (
        category &&
        !(await confirmBrowserAction(
          lease,
          request,
          options,
          confirmations,
          category,
          String(inspected.label ?? "Enter a password"),
        ))
      ) {
        return failure("The browser action was denied by the user.");
      }
      await pointAgentAtRef(lease, ref, "type");
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "working",
        request.tool,
      );
      const result = await lease.view.webContents.executeJavaScript(
        typeScript(
          ref,
          text,
          args.clear !== false,
          category === "authentication",
        ),
        true,
      );
      if (!result?.ok) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(String(result?.error ?? "Typing failed."));
      }
      const response = await snapshotResponse(lease);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return response;
    }
    case "upload": {
      const ref = requireRef(args.ref);
      const inspected = await lease.view.webContents.executeJavaScript(
        inspectInputScript(ref),
        true,
      );
      if (!inspected?.ok || inspected.type !== "file") {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(
          String(
            inspected?.error ??
              "The selected element is not a file input; take a new snapshot.",
          ),
        );
      }
      let upload: Awaited<ReturnType<typeof validateBrowserUpload>>;
      try {
        upload = await validateBrowserUpload(requireString(args.path, "path"));
      } catch (error) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(error instanceof Error ? error.message : String(error));
      }
      const label = `${String(inspected.label ?? "Choose file")}: ${upload.name} (${upload.size} bytes)`;
      if (
        !(await confirmBrowserAction(
          lease,
          request,
          options,
          confirmations,
          "file-upload",
          label,
        ))
      ) {
        return failure("The browser file upload was denied by the user.");
      }
      await pointAgentAtRef(lease, ref, "click");
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "working",
        request.tool,
      );
      try {
        await setFileInput(lease.view.webContents, ref, upload.path);
      } catch (error) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(
          `Browser upload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const response = await snapshotResponse(lease);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return response;
    }
    case "resize":
      resizeLease(lease, args.width, args.height, true);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return snapshotResponse(lease);
    case "back":
      if (lease.view.webContents.navigationHistory.canGoBack())
        lease.view.webContents.navigationHistory.goBack();
      await settleAfterAction(lease.view.webContents);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return snapshotResponse(lease);
    case "forward":
      if (lease.view.webContents.navigationHistory.canGoForward())
        lease.view.webContents.navigationHistory.goForward();
      await settleAfterAction(lease.view.webContents);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return snapshotResponse(lease);
    case "reload":
      lease.view.webContents.reload();
      await settleAfterAction(lease.view.webContents);
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return snapshotResponse(lease);
    case "screenshot": {
      let annotations: ReturnType<typeof parseBrowserAnnotations>;
      try {
        annotations = parseBrowserAnnotations(args.annotations);
      } catch (error) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(error instanceof Error ? error.message : String(error));
      }
      const response = await screenshotResponse(
        lease,
        options.artifactRoot,
        taskIdFromLeaseKey(request.threadId),
        annotations,
      );
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return response;
    }
    case "trace": {
      const taskId = taskIdFromLeaseKey(request.threadId);
      if (!options.artifactRoot || !taskId) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure("Durable browser trace storage is unavailable.");
      }
      const artifact = await persistBrowserTrace({
        root: options.artifactRoot,
        taskId,
        events: lease.trace,
        url: normalizeWebUrl(lease.view.webContents.getURL()),
        title: lease.view.webContents.getTitle(),
      });
      publishBrowserState(
        options,
        request.threadId,
        lease,
        "ready",
        request.tool,
      );
      return textSuccess({ artifact });
    }
    case "cdp": {
      if (!options.developerCdpEnabled) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(
          "Developer browser CDP is disabled. Enable it in Settings → Experimental before using raw CDP.",
        );
      }
      let cdp: ReturnType<typeof parseBrowserCdpRequest>;
      try {
        cdp = parseBrowserCdpRequest(args);
      } catch (error) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(error instanceof Error ? error.message : String(error));
      }
      if (
        !(await confirmBrowserAction(
          lease,
          request,
          options,
          confirmations,
          "developer-cdp",
          `Run raw CDP method ${cdp.method}`,
          cdp.method,
        ))
      ) {
        return failure("The raw CDP command was denied by the user.");
      }
      try {
        const debug = lease.view.webContents.debugger;
        if (!debug.isAttached()) debug.attach("1.3");
        const result = await debug.sendCommand(cdp.method, cdp.params);
        const serialized = JSON.stringify(result ?? {});
        if (Buffer.byteLength(serialized) > 256 * 1024) {
          throw new Error("CDP response exceeds 262144 bytes.");
        }
        recordTrace(lease, "cdp", cdp.method);
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return textSuccess({ method: cdp.method, result: result ?? {} });
      } catch (error) {
        publishBrowserState(
          options,
          request.threadId,
          lease,
          "ready",
          request.tool,
        );
        return failure(
          `CDP command failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    default:
      return failure(`Unsupported browser tool: ${request.tool}`);
  }
}

async function confirmBrowserAction(
  lease: BrowserLease,
  request: ToolRequest,
  options: BrowserAutomationServerOptions,
  confirmations: BrowserConfirmationBroker,
  category: BrowserRiskCategory,
  label: string,
  scope?: string,
): Promise<boolean> {
  const taskId = taskIdFromLeaseKey(request.threadId);
  if (!taskId) {
    publishBrowserState(
      options,
      request.threadId,
      lease,
      "ready",
      request.tool,
    );
    return false;
  }
  const currentUrl = normalizeWebUrl(lease.view.webContents.getURL());
  const origin = new URL(currentUrl).origin;
  if (confirmations.isSiteAllowed(taskId, origin, category, scope)) return true;
  publishBrowserState(
    options,
    request.threadId,
    lease,
    "awaiting-confirmation",
    request.tool,
  );
  lease.view.setVisible(false);
  const decision = await confirmations.confirm({
    taskId,
    category,
    ...(scope ? { scope } : {}),
    origin,
    url: currentUrl,
    label,
  });
  recordTrace(lease, "confirmation", `${category}:${decision}`);
  if (lease.attachedTo && !lease.attachedTo.isDestroyed()) {
    lease.view.setVisible(true);
  }
  if (decision === "deny") {
    publishBrowserState(
      options,
      request.threadId,
      lease,
      "ready",
      request.tool,
    );
    return false;
  }
  publishBrowserState(
    options,
    request.threadId,
    lease,
    "working",
    request.tool,
  );
  return true;
}

function createLease(
  threadId: string,
  leases: Map<string, BrowserLease>,
  options: BrowserAutomationServerOptions,
  confirmations: BrowserConfirmationBroker,
): BrowserLease {
  if (leases.size >= MAX_SESSIONS) {
    const oldest = [...leases.entries()].sort(
      (a, b) => a[1].touchedAt - b[1].touchedAt,
    )[0];
    if (oldest) {
      const taskId = taskIdFromLeaseKey(oldest[0]);
      if (taskId) confirmations.clearTask(taskId);
      destroyLease(oldest[1]);
      leases.delete(oldest[0]);
    }
  }
  const partition = `zeros-browser-${createHash("sha256")
    .update(threadId)
    .update(randomBytes(16))
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
      backgroundThrottling: false,
    },
  });
  const parkingWindow = new BaseWindow({
    show: false,
    width: 1440,
    height: 1000,
  });
  parkingWindow.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1440, height: 1000 });
  view.setBackgroundColor("#111111");
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  view.webContents.on("will-navigate", (event) => {
    if (event.url === "about:blank") return;
    try {
      normalizeWebUrl(event.url);
    } catch {
      event.preventDefault();
    }
  });
  view.webContents.on("console-message", (details) => {
    if (details.level !== "warning" && details.level !== "error") return;
    consoleErrors.push(`${details.level}: ${details.message}`.slice(0, 1_000));
    if (consoleErrors.length > 50) consoleErrors.shift();
    const lease = leases.get(threadId);
    if (lease) recordTrace(lease, "console", consoleErrors.at(-1) ?? "");
  });
  const publishNavigation = () => {
    const lease = leases.get(threadId);
    if (lease) {
      recordTrace(lease, "navigation", lease.view.webContents.getURL());
      publishBrowserState(options, threadId, lease, "ready");
    }
  };
  view.webContents.on("did-navigate", publishNavigation);
  view.webContents.on("did-navigate-in-page", publishNavigation);
  view.webContents.on("page-title-updated", publishNavigation);
  view.webContents.on("render-process-gone", (_event, details) => {
    const lease = leases.get(threadId);
    // A crashed WebContents can report after the same task has already opened
    // a replacement lease. Never let that stale event tear down the new page.
    if (!lease || lease.view !== view) return;
    recordTrace(
      lease,
      "renderer-crash",
      `${details.reason}${typeof details.exitCode === "number" ? `:${details.exitCode}` : ""}`,
    );
    const taskId = taskIdFromLeaseKey(threadId);
    if (taskId) confirmations.clearTask(taskId);
    leases.delete(threadId);
    publishBrowserState(options, threadId, null, "closed", "renderer-crash");
    destroyLease(lease);
  });
  const expires = setTimeout(() => undefined, IDLE_LEASE_MS);
  expires.unref?.();
  const lease: BrowserLease = {
    leaseKey: threadId,
    view,
    parkingWindow,
    attachedTo: parkingWindow,
    viewport: { width: 1440, height: 1000 },
    touchedAt: Date.now(),
    expires,
    consoleErrors,
    networkErrors,
    downloads: [],
    pendingHostActions: new Set(),
    trace: [],
    browserUseReady: null,
    actor: "agent",
    pointer: null,
    disposeNetworkHandlers: () => undefined,
    disposeBrowserUseDebugger: NOOP,
  };
  lease.disposeNetworkHandlers = installNetworkHandlers(browserSession, lease);
  installPermissionHandlers(browserSession, lease, options, confirmations);
  browserSession.on("will-download", (_event, item, contents) => {
    if (contents !== view.webContents) {
      item.cancel();
      return;
    }
    const action = handleBrowserDownload(lease, item, options, confirmations);
    trackHostAction(lease, action);
  });
  return lease;
}

function installNetworkHandlers(
  browserSession: Session,
  lease: BrowserLease,
): () => void {
  const filter = { urls: ["http://*/*", "https://*/*"] };
  browserSession.webRequest.onErrorOccurred(filter, (details) => {
    if (details.webContentsId !== lease.view.webContents.id) return;
    const detail = `${details.error || "Network request failed"}${details.url ? ` ${redactBrowserDiagnosticUrl(details.url)}` : ""}`;
    appendBrowserDiagnostic(lease.networkErrors, detail);
    recordTrace(lease, "network", detail);
  });
  browserSession.webRequest.onCompleted(filter, (details) => {
    if (
      details.webContentsId !== lease.view.webContents.id ||
      details.statusCode < 400
    )
      return;
    const detail = `HTTP ${details.statusCode} ${redactBrowserDiagnosticUrl(details.url)}`;
    appendBrowserDiagnostic(lease.networkErrors, detail);
    recordTrace(lease, "network", detail);
  });
  return () => {
    browserSession.webRequest.onErrorOccurred(null);
    browserSession.webRequest.onCompleted(null);
  };
}

function installPermissionHandlers(
  browserSession: Session,
  lease: BrowserLease,
  options: BrowserAutomationServerOptions,
  confirmations: BrowserConfirmationBroker,
): void {
  browserSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) => {
      const taskId = taskIdFromLeaseKey(lease.leaseKey);
      const origin = safeWebOrigin(requestingOrigin);
      return Boolean(
        taskId &&
        origin &&
        confirmations.isSiteAllowed(
          taskId,
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
      const action = handleBrowserPermission(
        lease,
        permission,
        details.requestingUrl,
        callback,
        options,
        confirmations,
      );
      trackHostAction(lease, action);
    },
  );
}

async function handleBrowserPermission(
  lease: BrowserLease,
  permission: string,
  requestingUrl: string,
  callback: (permissionGranted: boolean) => void,
  options: BrowserAutomationServerOptions,
  confirmations: BrowserConfirmationBroker,
): Promise<void> {
  const taskId = taskIdFromLeaseKey(lease.leaseKey);
  let url: string;
  try {
    url = normalizeWebUrl(requestingUrl || lease.view.webContents.getURL());
  } catch {
    callback(false);
    return;
  }
  if (!taskId) {
    callback(false);
    return;
  }
  const origin = new URL(url).origin;
  if (
    confirmations.isSiteAllowed(
      taskId,
      origin,
      "browser-permission",
      permission,
    )
  ) {
    callback(true);
    return;
  }
  publishBrowserState(
    options,
    lease.leaseKey,
    lease,
    "awaiting-confirmation",
    "permission",
  );
  lease.view.setVisible(false);
  const decision = await confirmations.confirm({
    taskId,
    category: "browser-permission",
    scope: permission,
    origin,
    url,
    label: `Allow ${permissionLabel(permission)} for ${origin}`,
  });
  recordTrace(lease, "permission", `${permission}:${decision}`);
  if (lease.attachedTo && !lease.attachedTo.isDestroyed()) {
    lease.view.setVisible(true);
  }
  callback(decision !== "deny");
  publishBrowserState(
    options,
    lease.leaseKey,
    lease,
    decision === "deny" ? "ready" : "working",
    "permission",
  );
}

async function handleBrowserDownload(
  lease: BrowserLease,
  item: DownloadItem,
  options: BrowserAutomationServerOptions,
  confirmations: BrowserConfirmationBroker,
): Promise<void> {
  const taskId = taskIdFromLeaseKey(lease.leaseKey);
  if (!taskId || !options.artifactRoot) {
    item.cancel();
    return;
  }
  let url: string;
  try {
    url = normalizeWebUrl(item.getURL());
  } catch {
    item.cancel();
    return;
  }
  const target = allocateBrowserDownload({
    root: options.artifactRoot,
    taskId,
    suggestedFilename: item.getFilename(),
  });
  item.setSavePath(target.path);
  item.pause();
  const origin = new URL(url).origin;
  publishBrowserState(
    options,
    lease.leaseKey,
    lease,
    "awaiting-confirmation",
    "download",
  );
  lease.view.setVisible(false);
  const decision = await confirmations.confirm({
    taskId,
    category: "download",
    origin,
    url,
    label: `Download ${item.getFilename() || "file"} from ${origin}`,
  });
  recordTrace(lease, "download", `${item.getFilename()}:${decision}`);
  if (lease.attachedTo && !lease.attachedTo.isDestroyed()) {
    lease.view.setVisible(true);
  }
  if (decision === "deny") {
    item.cancel();
    await unlink(target.path).catch(() => undefined);
    publishBrowserState(options, lease.leaseKey, lease, "ready", "download");
    return;
  }
  publishBrowserState(options, lease.leaseKey, lease, "working", "download");
  const completed = new Promise<boolean>((resolve) => {
    item.once("done", (_event, state) => resolve(state === "completed"));
  });
  item.resume();
  if (!(await completed)) {
    await unlink(target.path).catch(() => undefined);
    publishBrowserState(options, lease.leaseKey, lease, "ready", "download");
    return;
  }
  lease.downloads.push({
    kind: "browser-download",
    path: target.path,
    name: target.name,
    mimeType: item.getMimeType() || "application/octet-stream",
    size: item.getReceivedBytes(),
    url,
    downloadedAt: Date.now(),
  });
  while (lease.downloads.length > 40) {
    const expired = lease.downloads.shift();
    if (expired) await unlink(expired.path).catch(() => undefined);
  }
  publishBrowserState(options, lease.leaseKey, lease, "ready", "download");
}

function trackHostAction(lease: BrowserLease, action: Promise<void>): void {
  lease.pendingHostActions.add(action);
  void action
    .catch(() => undefined)
    .finally(() => lease.pendingHostActions.delete(action));
}

async function waitForHostActions(lease: BrowserLease): Promise<void> {
  // Permission/download events are dispatched just after the DOM click returns.
  await new Promise((resolve) => setTimeout(resolve, 100));
  while (lease.pendingHostActions.size > 0) {
    await Promise.allSettled([...lease.pendingHostActions]);
  }
}

function safeWebOrigin(value: string): string | null {
  try {
    return new URL(normalizeWebUrl(value)).origin;
  } catch {
    return null;
  }
}

function permissionLabel(permission: string): string {
  return permission
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/-/g, " ")
    .toLocaleLowerCase();
}

function appendBrowserDiagnostic(target: string[], value: string): void {
  target.push(value.replace(/[\r\n]+/g, " ").slice(0, 1_000));
  while (target.length > 50) target.shift();
}

function redactBrowserDiagnosticUrl(value: string): string {
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

function recordTrace(lease: BrowserLease, type: string, detail: string): void {
  lease.trace.push({
    at: Date.now(),
    type: type.slice(0, 80),
    detail: detail.replace(/\s+/g, " ").slice(0, 2_000),
  });
  if (lease.trace.length > 2_000) lease.trace.shift();
}

function touchLease(
  threadId: string,
  lease: BrowserLease,
  leases: Map<string, BrowserLease>,
  confirmations: BrowserConfirmationBroker,
): void {
  lease.touchedAt = Date.now();
  clearTimeout(lease.expires);
  lease.expires = setTimeout(() => {
    if (leases.get(threadId) !== lease) return;
    const taskId = taskIdFromLeaseKey(threadId);
    if (taskId) confirmations.clearTask(taskId);
    destroyLease(lease);
    leases.delete(threadId);
  }, IDLE_LEASE_MS);
  lease.expires.unref?.();
}

function destroyLease(lease: BrowserLease): void {
  clearTimeout(lease.expires);
  lease.disposeNetworkHandlers();
  lease.disposeBrowserUseDebugger();
  lease.view.setVisible(false);
  if (lease.attachedTo && !lease.attachedTo.isDestroyed()) {
    lease.attachedTo.contentView.removeChildView(lease.view);
  }
  lease.attachedTo = null;
  if (!lease.view.webContents.isDestroyed()) {
    void lease.view.webContents.session.clearStorageData();
    lease.view.webContents.close({ waitForBeforeUnload: false });
  }
  if (!lease.parkingWindow.isDestroyed()) lease.parkingWindow.destroy();
}

function parkLease(lease: BrowserLease): void {
  lease.view.setVisible(false);
  if (lease.attachedTo && !lease.attachedTo.isDestroyed()) {
    lease.attachedTo.contentView.removeChildView(lease.view);
  }
  if (lease.parkingWindow.isDestroyed()) {
    lease.attachedTo = null;
    return;
  }
  lease.parkingWindow.contentView.addChildView(lease.view);
  lease.view.setBounds({
    x: 0,
    y: 0,
    width: lease.viewport.width,
    height: lease.viewport.height,
  });
  lease.view.setVisible(true);
  lease.attachedTo = lease.parkingWindow;
}

async function snapshotResponse(lease: BrowserLease): Promise<ToolResponse> {
  if (lease.view.webContents.isLoading())
    await waitForLoad(lease.view.webContents);
  const snapshot = await lease.view.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT,
    true,
  );
  return textSuccess({
    ...snapshot,
    consoleErrors: lease.consoleErrors.slice(-20),
    networkErrors: lease.networkErrors.slice(-20),
    downloads: lease.downloads.slice(-20),
  });
}

async function screenshotResponse(
  lease: BrowserLease,
  artifactRoot: string | undefined,
  taskId: string | null,
  annotations: ReturnType<typeof parseBrowserAnnotations> = [],
): Promise<ToolResponse> {
  const snapshot = await lease.view.webContents.executeJavaScript(
    SNAPSHOT_SCRIPT,
    true,
  );
  if (annotations.length > 0) {
    await lease.view.webContents.executeJavaScript(
      annotationOverlayScript(annotations),
      true,
    );
  }
  let image;
  try {
    image = await lease.view.webContents.capturePage();
  } finally {
    if (annotations.length > 0) {
      await lease.view.webContents
        .executeJavaScript(annotationCleanupScript(), true)
        .catch(() => undefined);
    }
  }
  const width = Math.min(image.getSize().width, 1600);
  const jpeg = image.resize({ width }).toJPEG(78);
  const capturedAt = Date.now();
  const artifact =
    artifactRoot && taskId
      ? await persistBrowserScreenshot({
          root: artifactRoot,
          taskId,
          jpeg,
          url: String(snapshot.url ?? lease.view.webContents.getURL()),
          title: String(snapshot.title ?? lease.view.webContents.getTitle()),
          capturedAt,
        })
      : undefined;
  return {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: JSON.stringify({
          title: snapshot.title,
          url: snapshot.url,
          viewport: snapshot.viewport,
          capturedAt,
          artifact,
          annotations: annotations.length,
        }),
      },
      {
        type: "inputImage",
        imageUrl: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
      },
    ],
  };
}

function annotationOverlayScript(
  annotations: ReturnType<typeof parseBrowserAnnotations>,
): string {
  return String.raw`(() => {
    document.getElementById("__zeros-browser-annotations")?.remove();
    const root = document.createElement("div");
    root.id = "__zeros-browser-annotations";
    root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
    const annotations = ${JSON.stringify(annotations)};
    for (const annotation of annotations) {
      const target = document.querySelector('[data-zeros-browser-ref="' + annotation.ref + '"]');
      if (!target) continue;
      const rect = target.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText = 'position:fixed;left:' + Math.max(0, rect.left - 2) + 'px;top:' + Math.max(0, rect.top - 2) + 'px;width:' + Math.max(1, rect.width + 4) + 'px;height:' + Math.max(1, rect.height + 4) + 'px;border:3px solid #ff3b30;border-radius:4px;box-sizing:border-box;box-shadow:0 0 0 1px rgba(255,255,255,.9)';
      const badge = document.createElement("span");
      badge.textContent = annotation.label;
      badge.style.cssText = "position:absolute;left:-3px;top:-25px;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#ff3b30;color:white;padding:2px 6px;border-radius:3px;font:600 12px/18px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.35)";
      box.appendChild(badge);
      root.appendChild(box);
    }
    document.documentElement.appendChild(root);
    return root.childElementCount;
  })()`;
}

function annotationCleanupScript(): string {
  return 'document.getElementById("__zeros-browser-annotations")?.remove()';
}

function inspectClickScript(ref: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)});
    if (!element) return { ok: false, error: "Element ref is stale; take a new snapshot." };
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "Element is disabled." };
    return {
      ok: true,
      label: (element.getAttribute("aria-label") || element.innerText || element.textContent || element.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 300)
    };
  })()`;
}

function elementPointScript(ref: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)});
    if (!element) return null;
    element.scrollIntoView({ block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2))
    };
  })()`;
}

async function pointAgentAtRef(
  lease: BrowserLease,
  ref: string,
  action: BrowserAgentPointer["action"],
): Promise<void> {
  try {
    const point = await lease.view.webContents.executeJavaScript(
      elementPointScript(ref),
      true,
    );
    if (!point) return;
    await updateAgentPointer(lease, Number(point.x), Number(point.y), action);
  } catch {
    // The interaction itself remains authoritative if a page navigates between
    // snapshot and pointer decoration.
  }
}

function pointerFromCdpCommand(
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
    action: type === "mouseMoved" ? "move" : "click",
  };
}

async function updateAgentPointer(
  lease: BrowserLease,
  xValue: number,
  yValue: number,
  action: BrowserAgentPointer["action"],
): Promise<void> {
  const x = Math.max(0, Math.min(lease.viewport.width - 1, xValue));
  const y = Math.max(0, Math.min(lease.viewport.height - 1, yValue));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  lease.pointer = { x, y, action, updatedAt: Date.now() };
  try {
    await lease.view.webContents.executeJavaScript(
      agentPointerOverlayScript(lease.pointer),
      true,
    );
  } catch {
    // A navigation can replace the document between an input command and its
    // decoration. The next input event reinstalls the inert overlay.
  }
}

function agentPointerOverlayScript(pointer: BrowserAgentPointer): string {
  return String.raw`(() => {
    const id = "__zeros-agent-pointer";
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement("div");
      root.id = id;
      root.setAttribute("data-zeros-agent-pointer", "");
      root.setAttribute("aria-hidden", "true");
      root.style.cssText = "position:fixed;z-index:2147483647;display:flex;align-items:flex-start;pointer-events:none;user-select:none;transition:left 80ms linear,top 80ms linear;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35));font:600 11px/16px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif";

      const cursor = document.createElement("span");
      cursor.style.cssText = "display:block;width:16px;height:20px;background:#3b82f6;clip-path:polygon(0 0,0 100%,5px 75%,9px 96%,12px 94%,8px 72%,16px 72%);box-shadow:inset 0 0 0 1px rgba(255,255,255,.8)";
      const label = document.createElement("span");
      label.textContent = "Agent";
      label.style.cssText = "display:block;margin:15px 0 0 -2px;padding:1px 6px;border:1px solid rgba(255,255,255,.28);border-radius:999px;background:#2563eb;color:#fff;letter-spacing:.01em;white-space:nowrap";
      root.append(cursor, label);
      (document.documentElement || document.body).appendChild(root);
    }
    root.style.left = ${JSON.stringify(`${pointer.x}px`)};
    root.style.top = ${JSON.stringify(`${pointer.y}px`)};
    root.style.opacity = "1";
    clearTimeout(root.__zerosAgentPointerTimer);
    root.__zerosAgentPointerTimer = setTimeout(() => root.remove(), 1800);

    if (${JSON.stringify(pointer.action)} === "click" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const pulse = document.createElement("span");
      pulse.style.cssText = "position:absolute;left:-8px;top:-8px;width:24px;height:24px;border:2px solid #3b82f6;border-radius:999px";
      root.appendChild(pulse);
      pulse.animate(
        [{ transform: "scale(.35)", opacity: 1 }, { transform: "scale(1.35)", opacity: 0 }],
        { duration: 420, easing: "ease-out" },
      ).finished.then(() => pulse.remove(), () => pulse.remove());
    }
    return true;
  })()`;
}

function clickScript(ref: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)});
    if (!element) return { ok: false, error: "Element ref is stale; take a new snapshot." };
    if (element.disabled || element.getAttribute("aria-disabled") === "true") return { ok: false, error: "Element is disabled." };
    element.scrollIntoView({ block: "center", inline: "center" });
    element.focus?.();
    element.click();
    return { ok: true };
  })()`;
}

function taskIdFromLeaseKey(leaseKey: string): string | null {
  if (!leaseKey.startsWith("task:")) return null;
  const taskId = leaseKey.slice("task:".length);
  return browserTaskLeaseKey(taskId) === leaseKey ? taskId : null;
}

function inspectInputScript(ref: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)});
    if (!element) return { ok: false, error: "Element ref is stale; take a new snapshot." };
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !element.isContentEditable) return { ok: false, error: "Element is not editable." };
    const type = String(element.getAttribute("type") || "text").toLowerCase();
    return {
      ok: true,
      type,
      label: (element.getAttribute("aria-label") || element.labels?.[0]?.textContent || element.getAttribute("placeholder") || (type === "password" ? "Enter a password" : "Enter text")).trim().replace(/\s+/g, " ").slice(0, 300)
    };
  })()`;
}

function typeScript(
  ref: string,
  text: string,
  clear: boolean,
  allowPassword: boolean,
): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)});
    if (!element) return { ok: false, error: "Element ref is stale; take a new snapshot." };
    const type = String(element.getAttribute("type") || "").toLowerCase();
    if (type === "file") return { ok: false, error: "Use the browser upload tool for file inputs." };
    if (type === "password" && !${JSON.stringify(allowPassword)}) return { ok: false, error: "Password entry requires explicit confirmation." };
    if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !element.isContentEditable) return { ok: false, error: "Element is not editable." };
    const next = ${JSON.stringify(text)};
    element.focus();
    if (element.isContentEditable) {
      element.textContent = ${clear ? "next" : '(element.textContent || "") + next'};
    } else {
      const prior = element.value || "";
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      setter?.call(element, ${clear ? "next" : "prior + next"});
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: next }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
})()`;
}

/** Electron has no high-level API for assigning a file input. Keep this CDP
 * use narrowly scoped to the already-confirmed input and detach immediately;
 * the page never receives arbitrary debugger access. */
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
    if (!nodeId) throw new Error("Could not inspect the current document.");
    const match = (await debug.sendCommand("DOM.querySelector", {
      nodeId,
      selector: `[data-zeros-browser-ref="${ref}"]`,
    })) as { nodeId?: number };
    if (!match.nodeId) {
      throw new Error("File-input ref is stale; take a new snapshot.");
    }
    await debug.sendCommand("DOM.setFileInputFiles", {
      files: [filePath],
      nodeId: match.nodeId,
    });
    await webContents.executeJavaScript(inputFileChangedScript(ref), true);
  } finally {
    if (attachedHere && debug.isAttached()) debug.detach();
  }
}

function inputFileChangedScript(ref: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)});
    if (!(element instanceof HTMLInputElement) || element.type !== "file") return false;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`;
}

async function settleAfterAction(webContents: WebContents): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (webContents.isLoading()) await waitForLoad(webContents);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function waitForLoad(webContents: WebContents): Promise<void> {
  await new Promise<void>((resolve) => {
    if (!webContents.isLoading()) return resolve();
    const timer = setTimeout(done, NAVIGATION_TIMEOUT_MS);
    const onStop = () => done();
    function done() {
      clearTimeout(timer);
      webContents.off("did-stop-loading", onStop);
      resolve();
    }
    webContents.once("did-stop-loading", onStop);
  });
}

function resizeLease(
  lease: BrowserLease,
  widthValue: unknown,
  heightValue: unknown,
  required = false,
): void {
  if (!required && widthValue === undefined && heightValue === undefined)
    return;
  const width = boundedInteger(
    widthValue ?? lease.viewport.width,
    "width",
    MIN_VIEWPORT.width,
    MAX_VIEWPORT.width,
  );
  const height = boundedInteger(
    heightValue ?? lease.viewport.height,
    "height",
    MIN_VIEWPORT.height,
    MAX_VIEWPORT.height,
  );
  lease.viewport = { width, height };
  const bounds = lease.view.getBounds();
  lease.view.setBounds({ ...bounds, width, height });
}

function normalizeBrowserBounds(
  value: BrowserSessionBounds,
): BrowserSessionBounds | null {
  const entries = [value.x, value.y, value.width, value.height];
  if (!entries.every((entry) => Number.isInteger(entry))) return null;
  if (value.x < 0 || value.y < 0 || value.x > 20_000 || value.y > 20_000)
    return null;
  if (
    value.width < 1 ||
    value.height < 1 ||
    value.width > 10_000 ||
    value.height > 10_000
  )
    return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function browserSessionState(
  lease: BrowserLease,
  status: BrowserSessionState["status"],
  tool?: string,
  requestedUrl?: string,
): BrowserSessionState {
  return {
    taskId: lease.leaseKey.slice("task:".length),
    url: requestedUrl ?? lease.view.webContents.getURL(),
    title: lease.view.webContents.getTitle(),
    loading: lease.view.webContents.isLoading(),
    status,
    provider: "isolated",
    actor: lease.actor,
    ...(lease.pointer ? { pointer: lease.pointer } : {}),
    ...(tool ? { tool } : {}),
  };
}

function publishExternalBrowserState(
  options: BrowserAutomationServerOptions,
  taskId: string,
  provider: SharedChromeBrowserProvider,
  providerName: "shared-chrome" | "managed-cloud",
  status: BrowserSessionState["status"],
  tool?: string,
): void {
  const state = provider.state(taskId);
  options.onSessionState?.({
    taskId,
    url: state?.url ?? "",
    title: state?.title ?? "Shared Chrome",
    loading: state?.loading ?? false,
    status,
    provider: providerName,
    ...(tool ? { tool } : {}),
  });
}

function publishBrowserState(
  options: BrowserAutomationServerOptions,
  leaseKey: string,
  lease: BrowserLease | null,
  status: BrowserSessionState["status"],
  tool?: string,
  requestedUrl?: string,
): void {
  if (!leaseKey.startsWith("task:")) return;
  const taskId = leaseKey.slice("task:".length);
  if (!browserTaskLeaseKey(taskId)) return;
  options.onSessionState?.(
    lease
      ? browserSessionState(lease, status, tool, requestedUrl)
      : {
          taskId,
          url: "",
          title: "",
          loading: false,
          status,
          provider: "isolated",
          ...(tool ? { tool } : {}),
        },
  );
}

async function capturePrimaryDisplay(): Promise<{
  jpeg: Buffer;
  width: number;
  height: number;
}> {
  if (process.platform !== "darwin") {
    throw new Error("System Computer Use is available only on macOS.");
  }
  const primary = screen.getPrimaryDisplay();
  const thumbnailSize = {
    width: Math.max(1, Math.round(primary.size.width * primary.scaleFactor)),
    height: Math.max(1, Math.round(primary.size.height * primary.scaleFactor)),
  };
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  const source =
    sources.find((candidate) => candidate.display_id === String(primary.id)) ??
    sources[0];
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(
      "macOS did not provide a screen image. Grant Screen Recording permission to Zeros and try again.",
    );
  }
  const size = source.thumbnail.getSize();
  return {
    jpeg: source.thumbnail.toJPEG(90),
    width: size.width,
    height: size.height,
  };
}

async function runAppleScript(
  lines: string[],
  args: string[] = [],
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("System Computer Use is available only on macOS.");
  }
  const commandArgs = lines.flatMap((line) => ["-e", line]);
  commandArgs.push("--", ...args);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      commandArgs,
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

const MAC_COMPUTER_KEY_CODES: Record<MacComputerKey, number> = {
  enter: 36,
  tab: 48,
  escape: 53,
  space: 49,
  backspace: 51,
  "arrow-up": 126,
  "arrow-down": 125,
  "arrow-left": 123,
  "arrow-right": 124,
};

function pressMacComputerKey(key: MacComputerKey): Promise<void> {
  return runAppleScript([
    `tell application "System Events" to key code ${MAC_COMPUTER_KEY_CODES[key]}`,
  ]);
}

function normalizeWebUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  )
    throw new Error("Only credential-free http(s) URLs are supported.");
  return url.href;
}

function requireRef(value: unknown): string {
  const ref = requireString(value, "ref");
  if (!/^b[1-9]\d{0,8}$/.test(ref))
    throw new Error("Invalid browser element ref.");
  return ref;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error(
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function parseToolRequest(value: unknown): ToolRequest {
  const request = asRecord(value);
  return {
    threadId: requireString(request.threadId, "threadId"),
    turnId: requireString(request.turnId, "turnId"),
    callId: requireString(request.callId, "callId"),
    namespace:
      request.namespace === null
        ? null
        : requireString(request.namespace, "namespace"),
    tool: requireString(request.tool, "tool"),
    arguments: request.arguments,
  };
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES)
      throw new Error("Browser tool request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function tokenMatches(request: IncomingMessage, expected: string): boolean {
  const provided =
    request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function textSuccess(value: unknown): ToolResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value, null, 2) }],
  };
}

function failure(text: string): ToolResponse {
  return { success: false, contentItems: [{ type: "inputText", text }] };
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
