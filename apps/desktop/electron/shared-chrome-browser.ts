import WebSocket, { type ClientOptions } from "ws";

import { parseBrowserAnnotations } from "./browser-annotations";
import {
  persistBrowserScreenshot,
  persistBrowserTrace,
  type BrowserTraceEvent,
} from "./browser-artifacts";
import {
  BrowserConfirmationBroker,
  classifyBrowserClick,
  classifyBrowserInput,
  type BrowserRiskCategory,
} from "./browser-confirmations";
import { parseBrowserCdpRequest } from "./browser-cdp";
import { validateBrowserUpload } from "./browser-files";
import {
  normalizeManagedCloudEndpoint,
  normalizeSharedChromeEndpoint,
} from "./browser-provider";

const MAX_SESSIONS = 8;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CDP_TIMEOUT_MS = 30_000;
const FORBIDDEN_SHARED_CDP = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setDownloadBehavior",
  "Browser.setPermission",
  "Target.closeTarget",
  "Target.createBrowserContext",
  "Target.createTarget",
  "Target.disposeBrowserContext",
  "Target.setAutoAttach",
  "Target.setDiscoverTargets",
]);

type ContentItem =
  | { type: "inputText"; text: string }
  | { type: "inputImage"; imageUrl: string };

export interface SharedChromeToolResponse {
  success: boolean;
  contentItems: ContentItem[];
}

export interface SharedChromeToolRequest {
  taskId: string;
  tool: string;
  arguments: unknown;
}

export interface SharedChromePage {
  url(): string;
  evaluate(expression: string): Promise<unknown>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  screenshot(): Promise<Buffer>;
  setInputFiles(selector: string, files: string[]): Promise<void>;
  send(method: string, params: Record<string, unknown>): Promise<unknown>;
  onEvent?(
    listener: (event: SharedChromePageEvent) => void,
  ): () => void;
  close(): Promise<void>;
}

export interface SharedChromePageEvent {
  method: string;
  params: Record<string, unknown>;
}

export interface SharedChromeConnection {
  pageCount(): Promise<number>;
  createPage(): Promise<SharedChromePage>;
  close(): Promise<void>;
}

export interface SharedChromeProviderOptions {
  artifactRoot?: string;
  confirmations: BrowserConfirmationBroker;
  developerCdpEnabled: () => boolean;
  connect?: (endpoint: string) => Promise<SharedChromeConnection>;
  providerName?: "shared-chrome" | "managed-cloud";
  normalizeEndpoint?: (endpoint: unknown) => string;
  redactSecrets?: () => string[];
}

interface SharedChromeLease {
  taskId: string;
  page: SharedChromePage;
  touchedAt: number;
  consoleErrors: string[];
  networkErrors: string[];
  downloads: Array<Record<string, unknown>>;
  trace: BrowserTraceEvent[];
  disposeEvents: (() => void) | null;
}

/** Explicit opt-in adapter for a Chrome instance the user launched with a
 * loopback DevTools endpoint. It creates one target per task and speaks CDP
 * directly. Closing Zeros closes only those targets and the WebSocket—never the
 * user-owned browser process and never its profile. */
export class SharedChromeBrowserProvider {
  private endpoint: string | null = null;
  private connection: SharedChromeConnection | null = null;
  private readonly leases = new Map<string, SharedChromeLease>();
  private readonly connect: (endpoint: string) => Promise<SharedChromeConnection>;
  private readonly providerName: "shared-chrome" | "managed-cloud";
  private readonly normalizeEndpoint: (endpoint: unknown) => string;

  constructor(private readonly options: SharedChromeProviderOptions) {
    this.connect = options.connect ?? connectSharedChrome;
    this.providerName = options.providerName ?? "shared-chrome";
    this.normalizeEndpoint =
      options.normalizeEndpoint ?? normalizeSharedChromeEndpoint;
  }

  async configure(endpoint: string): Promise<void> {
    const next = this.normalizeEndpoint(endpoint);
    if (next === this.endpoint) return;
    await this.disconnect();
    this.endpoint = next;
  }

  get configuredEndpoint(): string | null {
    return this.endpoint;
  }

  activeTaskIds(): string[] {
    return [...this.leases.keys()];
  }

  state(taskId: string): { url: string; title: string; loading: boolean } | null {
    const lease = this.leases.get(taskId);
    return lease
      ? { url: lease.page.url(), title: "Shared Chrome", loading: false }
      : null;
  }

  async probe(): Promise<{ connected: true; endpoint: string; pages: number }> {
    const connection = await this.ensureConnection();
    return {
      connected: true,
      endpoint: this.endpoint!,
      pages: await connection.pageCount(),
    };
  }

  async execute(
    request: SharedChromeToolRequest,
    reconnectAttempted = false,
  ): Promise<SharedChromeToolResponse> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(request.taskId)) {
      return failure("Invalid browser task binding.");
    }
    if (request.tool === "close") {
      await this.closeLease(request.taskId);
      return success({ closed: true, provider: this.providerName });
    }
    try {
      const args = asRecord(request.arguments);
      let lease = this.leases.get(request.taskId);
      if (!lease) {
        if (request.tool !== "open") {
          return failure(
            `Open a URL before using this ${this.providerLabel()} session.`,
          );
        }
        lease = await this.createLease(request.taskId);
      }
      lease.touchedAt = Date.now();
      trace(lease, "tool", request.tool);
      switch (request.tool) {
        case "open": {
          const url = normalizeWebUrl(requireString(args.url, "url"));
          if (args.width !== undefined || args.height !== undefined) {
            await lease.page.resize(
              boundedViewport(args.width, "width", 1440, 320, 2560),
              boundedViewport(args.height, "height", 1000, 320, 1800),
            );
          }
          await lease.page.navigate(url);
          trace(lease, "navigation", url);
          return this.snapshot(lease);
        }
        case "snapshot":
          return this.snapshot(lease);
        case "click": {
          const ref = requireRef(args.ref);
          const inspected = await lease.page.evaluate(inspectClickScript(ref));
          if (!isOk(inspected)) return failure(errorOf(inspected, "Click failed."));
          const label = stringField(inspected, "label");
          const category = classifyBrowserClick(label);
          if (category && !(await this.confirm(lease, category, label || "Browser action"))) {
            return failure("The browser action was denied by the user.");
          }
          const clicked = await lease.page.evaluate(clickScript(ref));
          if (!isOk(clicked)) return failure(errorOf(clicked, "Click failed."));
          await settle(lease.page);
          return this.snapshot(lease);
        }
        case "type": {
          const ref = requireRef(args.ref);
          const text = requireString(args.text, "text");
          if (text.length > 20_000) return failure("Text exceeds 20,000 characters.");
          const inspected = await lease.page.evaluate(inspectInputScript(ref));
          if (!isOk(inspected)) return failure(errorOf(inspected, "Typing failed."));
          const inputType = stringField(inspected, "type");
          const category = classifyBrowserInput(inputType);
          if (category === "file-upload") return failure("Use the browser upload tool for file inputs.");
          if (
            category &&
            !(await this.confirm(
              lease,
              category,
              stringField(inspected, "label") || "Enter a password",
            ))
          ) {
            return failure("The browser action was denied by the user.");
          }
          const typed = await lease.page.evaluate(
            typeScript(ref, text, args.clear !== false, category === "authentication"),
          );
          if (!isOk(typed)) return failure(errorOf(typed, "Typing failed."));
          return this.snapshot(lease);
        }
        case "upload": {
          const ref = requireRef(args.ref);
          const inspected = await lease.page.evaluate(inspectInputScript(ref));
          if (!isOk(inspected) || stringField(inspected, "type") !== "file") {
            return failure("The selected element is not a file input; take a new snapshot.");
          }
          const upload = await validateBrowserUpload(requireString(args.path, "path"));
          const label = `${stringField(inspected, "label") || "Choose file"}: ${upload.name} (${upload.size} bytes)`;
          if (!(await this.confirm(lease, "file-upload", label))) {
            return failure("The browser file upload was denied by the user.");
          }
          await lease.page.setInputFiles(
            `[data-zeros-browser-ref="${ref}"]`,
            [upload.path],
          );
          return this.snapshot(lease);
        }
        case "resize":
          await lease.page.resize(
            boundedViewport(args.width, "width", 1440, 320, 2560),
            boundedViewport(args.height, "height", 1000, 320, 1800),
          );
          return this.snapshot(lease);
        case "back":
          await lease.page.back();
          return this.snapshot(lease);
        case "forward":
          await lease.page.forward();
          return this.snapshot(lease);
        case "reload":
          await lease.page.reload();
          return this.snapshot(lease);
        case "screenshot":
          return this.screenshot(lease, args.annotations);
        case "trace":
          return this.persistTrace(lease);
        case "cdp":
          return this.cdp(lease, args);
        default:
          return failure(`Unsupported shared Chrome tool: ${request.tool}`);
      }
    } catch (error) {
      if (isConnectionFailure(error)) {
        await this.disconnect();
        if (!reconnectAttempted && request.tool === "open") {
          return this.execute(request, true);
        }
      }
      return failure(this.safeError(error));
    }
  }

  async stop(): Promise<void> {
    await this.disconnect();
  }

  private async ensureConnection(): Promise<SharedChromeConnection> {
    if (this.connection) return this.connection;
    if (!this.endpoint) throw new Error(`${this.providerLabel()} is not configured.`);
    this.connection = await this.connect(this.endpoint);
    return this.connection;
  }

  private async createLease(taskId: string): Promise<SharedChromeLease> {
    while (this.leases.size >= MAX_SESSIONS) {
      const oldest = [...this.leases.values()].sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (!oldest) break;
      await this.closeLease(oldest.taskId);
    }
    const page = await (await this.ensureConnection()).createPage();
    const lease: SharedChromeLease = {
      taskId,
      page,
      touchedAt: Date.now(),
      consoleErrors: [],
      networkErrors: [],
      downloads: [],
      trace: [],
      disposeEvents: null,
    };
    if (page.onEvent) {
      lease.disposeEvents = page.onEvent((event) => capturePageEvent(lease, event));
    }
    this.leases.set(taskId, lease);
    return lease;
  }

  private async closeLease(taskId: string): Promise<void> {
    const lease = this.leases.get(taskId);
    this.leases.delete(taskId);
    this.options.confirmations.clearTask(taskId);
    if (lease) {
      lease.disposeEvents?.();
      lease.disposeEvents = null;
      await lease.page.close().catch(() => undefined);
    }
  }

  private async disconnect(): Promise<void> {
    await Promise.all([...this.leases.keys()].map((taskId) => this.closeLease(taskId)));
    const connection = this.connection;
    this.connection = null;
    if (connection) await connection.close().catch(() => undefined);
  }

  private providerLabel(): string {
    return this.providerName === "managed-cloud"
      ? "managed cloud browser"
      : "Shared Chrome";
  }

  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    message = message
      .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(/\b((?:https?|wss?):\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[redacted]");
    for (const secret of this.options.redactSecrets?.() ?? []) {
      if (secret) message = message.split(secret).join("[redacted]");
    }
    return message;
  }

  private async snapshot(lease: SharedChromeLease): Promise<SharedChromeToolResponse> {
    await settle(lease.page);
    const snapshot = asRecord(await lease.page.evaluate(SNAPSHOT_SCRIPT));
    return success({
      ...snapshot,
      provider: this.providerName,
      consoleErrors: lease.consoleErrors.slice(-20),
      networkErrors: lease.networkErrors.slice(-20),
      downloads: lease.downloads.slice(-20),
    });
  }

  private async screenshot(
    lease: SharedChromeLease,
    rawAnnotations: unknown,
  ): Promise<SharedChromeToolResponse> {
    const annotations = parseBrowserAnnotations(rawAnnotations);
    const snapshot = asRecord(await lease.page.evaluate(SNAPSHOT_SCRIPT));
    if (annotations.length > 0) await lease.page.evaluate(annotationOverlayScript(annotations));
    let jpeg: Buffer;
    try {
      jpeg = await lease.page.screenshot();
    } finally {
      if (annotations.length > 0) {
        await lease.page.evaluate(annotationCleanupScript()).catch(() => undefined);
      }
    }
    const capturedAt = Date.now();
    const artifact = this.options.artifactRoot
      ? await persistBrowserScreenshot({
          root: this.options.artifactRoot,
          taskId: lease.taskId,
          jpeg,
          url: String(snapshot.url ?? lease.page.url()),
          title: String(snapshot.title ?? "Shared Chrome"),
          capturedAt,
        })
      : undefined;
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            provider: this.providerName,
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

  private async persistTrace(lease: SharedChromeLease): Promise<SharedChromeToolResponse> {
    if (!this.options.artifactRoot) {
      return failure("Durable browser trace storage is unavailable.");
    }
    const snapshot = asRecord(await lease.page.evaluate(SNAPSHOT_SCRIPT));
    const artifact = await persistBrowserTrace({
      root: this.options.artifactRoot,
      taskId: lease.taskId,
      events: lease.trace,
      url: normalizeWebUrl(String(snapshot.url ?? lease.page.url())),
      title: String(snapshot.title ?? "Shared Chrome"),
    });
    return success({ provider: this.providerName, artifact });
  }

  private async cdp(
    lease: SharedChromeLease,
    args: Record<string, unknown>,
  ): Promise<SharedChromeToolResponse> {
    if (!this.options.developerCdpEnabled()) {
      return failure(
        "Developer browser CDP is disabled. Enable it in Settings → Experimental before using raw CDP.",
      );
    }
    const request = parseBrowserCdpRequest(args);
    if (FORBIDDEN_SHARED_CDP.has(request.method)) {
      return failure(`${request.method} is not allowed against a user-owned Chrome process.`);
    }
    if (
      !(await this.confirm(
        lease,
        "developer-cdp",
        `Run raw CDP method ${request.method}`,
        request.method,
      ))
    ) {
      return failure("The raw CDP command was denied by the user.");
    }
    const result = await lease.page.send(request.method, request.params);
    if (Buffer.byteLength(JSON.stringify(result ?? {})) > MAX_RESPONSE_BYTES) {
      return failure("CDP response exceeds 262144 bytes.");
    }
    trace(lease, "cdp", request.method);
    return success({
      provider: this.providerName,
      method: request.method,
      result: result ?? {},
    });
  }

  private async confirm(
    lease: SharedChromeLease,
    category: BrowserRiskCategory,
    label: string,
    scope?: string,
  ): Promise<boolean> {
    const url = normalizeWebUrl(lease.page.url());
    const origin = new URL(url).origin;
    if (
      this.options.confirmations.isSiteAllowed(
        lease.taskId,
        origin,
        category,
        scope,
      )
    ) {
      return true;
    }
    const decision = await this.options.confirmations.confirm({
      taskId: lease.taskId,
      category,
      ...(scope ? { scope } : {}),
      origin,
      url,
      label,
    });
    trace(lease, "confirmation", `${category}:${decision}`);
    return decision !== "deny";
  }
}

interface PendingCdpCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class DirectCdpConnection implements SharedChromeConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCdpCall>();
  private readonly targetSessions = new Set<string>();
  private readonly eventListeners = new Map<
    string,
    Set<(event: SharedChromePageEvent) => void>
  >();
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("close", () => this.onClosed(new Error("Shared Chrome disconnected.")));
    socket.on("error", (error) => this.onClosed(error));
  }

  pageCount(): Promise<number> {
    return this.send("Target.getTargets", {}).then((result) => {
      const targetInfos = asRecord(result).targetInfos;
      return Array.isArray(targetInfos)
        ? targetInfos.filter((target) => asRecord(target).type === "page").length
        : 0;
    });
  }

  async createPage(): Promise<SharedChromePage> {
    const created = asRecord(await this.send("Target.createTarget", { url: "about:blank" }));
    if (typeof created.targetId !== "string") {
      throw new Error("Chrome did not create a browser target.");
    }
    const attached = asRecord(
      await this.send("Target.attachToTarget", {
        targetId: created.targetId,
        flatten: true,
      }),
    );
    if (typeof attached.sessionId !== "string") {
      await this.send("Target.closeTarget", { targetId: created.targetId }).catch(() => undefined);
      throw new Error("Chrome did not attach to the browser target.");
    }
    this.targetSessions.add(attached.sessionId);
    const page = new DirectCdpPage(
      created.targetId,
      attached.sessionId,
      (method, params) => this.send(method, params, attached.sessionId as string),
      (listener) => this.subscribe(attached.sessionId as string, listener),
      async () => {
        this.targetSessions.delete(attached.sessionId as string);
        this.eventListeners.delete(attached.sessionId as string);
        await this.send("Target.closeTarget", { targetId: created.targetId });
      },
    );
    await page.send("Page.enable", {});
    await page.send("Runtime.enable", {});
    await page.send("Network.enable", {}).catch(() => undefined);
    await page.send("Log.enable", {}).catch(() => undefined);
    return page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // WebSocket close is a disconnect only. It does not send Browser.close.
    this.socket.close(1000, "Zeros provider switched");
    this.onClosed(new Error("Shared Chrome connection closed."));
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Shared Chrome is not connected."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools command timed out: ${method}`));
      }, CDP_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }

  private onMessage(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = asRecord(JSON.parse(raw));
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      const sessionId = typeof message.sessionId === "string" ? message.sessionId : null;
      const method = typeof message.method === "string" ? message.method : null;
      if (!sessionId || !method) return;
      const event = { method, params: asRecord(message.params) };
      for (const listener of this.eventListeners.get(sessionId) ?? []) listener(event);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = asRecord(message.error);
      pending.reject(
        new Error(
          typeof error.message === "string"
            ? error.message
            : "Chrome DevTools command failed.",
        ),
      );
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  private onClosed(error: Error): void {
    if (!this.closed) this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.targetSessions.clear();
    this.eventListeners.clear();
  }

  private subscribe(
    sessionId: string,
    listener: (event: SharedChromePageEvent) => void,
  ): () => void {
    const listeners = this.eventListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.eventListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.eventListeners.delete(sessionId);
    };
  }
}

class DirectCdpPage implements SharedChromePage {
  private currentUrl = "about:blank";

  constructor(
    _targetId: string,
    _sessionId: string,
    private readonly command: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly subscribeToEvents: (
      listener: (event: SharedChromePageEvent) => void,
    ) => () => void,
    private readonly closeTarget: () => Promise<void>,
  ) {}

  url(): string {
    return this.currentUrl;
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = asRecord(
      await this.command("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      }),
    );
    const exception = response.exceptionDetails;
    if (exception) {
      const details = asRecord(exception);
      throw new Error(
        typeof details.text === "string" ? details.text : "Page script failed.",
      );
    }
    return asRecord(response.result).value;
  }

  async navigate(url: string): Promise<void> {
    const result = asRecord(await this.command("Page.navigate", { url }));
    if (typeof result.errorText === "string" && result.errorText) {
      throw new Error(result.errorText);
    }
    this.currentUrl = url;
    await settle(this);
  }

  async back(): Promise<void> {
    await this.navigateHistory(-1);
  }

  async forward(): Promise<void> {
    await this.navigateHistory(1);
  }

  async reload(): Promise<void> {
    await this.command("Page.reload", { ignoreCache: false });
    await settle(this);
  }

  async resize(width: number, height: number): Promise<void> {
    await this.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async screenshot(): Promise<Buffer> {
    const result = asRecord(
      await this.command("Page.captureScreenshot", {
        format: "jpeg",
        quality: 78,
        fromSurface: true,
      }),
    );
    if (typeof result.data !== "string") {
      throw new Error("Chrome did not return screenshot data.");
    }
    return Buffer.from(result.data, "base64");
  }

  async setInputFiles(selector: string, files: string[]): Promise<void> {
    const document = asRecord(await this.command("DOM.getDocument", { depth: 0 }));
    const rootId = asRecord(document.root).nodeId;
    if (typeof rootId !== "number") throw new Error("Chrome DOM root is unavailable.");
    const query = asRecord(
      await this.command("DOM.querySelector", { nodeId: rootId, selector }),
    );
    if (typeof query.nodeId !== "number" || query.nodeId === 0) {
      throw new Error("File input ref is stale; take a new snapshot.");
    }
    await this.command("DOM.setFileInputFiles", {
      nodeId: query.nodeId,
      files,
    });
  }

  send(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.command(method, params);
  }

  onEvent(listener: (event: SharedChromePageEvent) => void): () => void {
    return this.subscribeToEvents(listener);
  }

  async close(): Promise<void> {
    await this.closeTarget();
  }

  private async navigateHistory(offset: number): Promise<void> {
    const history = asRecord(await this.command("Page.getNavigationHistory", {}));
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const currentIndex = typeof history.currentIndex === "number" ? history.currentIndex : -1;
    const entry = asRecord(entries[currentIndex + offset]);
    if (typeof entry.id !== "number") return;
    await this.command("Page.navigateToHistoryEntry", { entryId: entry.id });
    if (typeof entry.url === "string") this.currentUrl = entry.url;
    await settle(this);
  }
}

export async function connectSharedChrome(
  endpoint: string,
  dependencies: ManagedCloudTransportDependencies = {},
): Promise<SharedChromeConnection> {
  const normalized = normalizeSharedChromeEndpoint(endpoint);
  const websocketUrl = normalized.startsWith("ws:")
    ? normalized
    : normalizeSharedChromeEndpoint(
        await discoverBrowserWebSocket(
          normalized,
          undefined,
          dependencies.fetch,
        ),
      );
  const socket = await openWebSocket(
    websocketUrl,
    undefined,
    dependencies.createWebSocket,
  );
  return new DirectCdpConnection(socket);
}

export function connectManagedCloudBrowser(
  endpoint: string,
  bearerToken?: string,
  dependencies: ManagedCloudTransportDependencies = {},
): Promise<SharedChromeConnection> {
  const normalized = normalizeManagedCloudEndpoint(endpoint);
  return connectDirectCdp(normalized, bearerToken, dependencies);
}

export interface ManagedCloudTransportDependencies {
  fetch?: typeof fetch;
  createWebSocket?: (url: string, options: ClientOptions) => WebSocket;
}

async function connectDirectCdp(
  endpoint: string,
  bearerToken?: string,
  dependencies: ManagedCloudTransportDependencies = {},
): Promise<SharedChromeConnection> {
  const websocketUrl = endpoint.startsWith("ws:") || endpoint.startsWith("wss:")
    ? endpoint
    : await discoverBrowserWebSocket(
        endpoint,
        bearerToken,
        dependencies.fetch,
      );
  const socket = await openWebSocket(
    websocketUrl,
    bearerToken,
    dependencies.createWebSocket,
  );
  return new DirectCdpConnection(socket);
}

async function discoverBrowserWebSocket(
  endpoint: string,
  bearerToken?: string,
  fetchRequest: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchRequest(`${endpoint}/json/version`, {
    headers: {
      accept: "application/json",
      ...(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Shared Chrome endpoint returned HTTP ${response.status}.`);
  }
  const body = asRecord(await response.json());
  if (typeof body.webSocketDebuggerUrl !== "string") {
    throw new Error("Shared Chrome did not advertise a browser WebSocket.");
  }
  const advertised = new URL(body.webSocketDebuggerUrl);
  if (advertised.protocol !== "ws:" && advertised.protocol !== "wss:") {
    throw new Error("Managed browser advertised an invalid WebSocket URL.");
  }
  if (advertised.username || advertised.password) {
    throw new Error("Managed browser WebSocket must not contain URL credentials.");
  }
  if (bearerToken) {
    const discovery = new URL(endpoint);
    if (advertised.protocol !== "wss:") {
      throw new Error("Authenticated managed browser discovery requires a secure WSS endpoint.");
    }
    if (advertised.host !== discovery.host) {
      throw new Error("Authenticated managed browser discovery must advertise a WebSocket on the same host.");
    }
  }
  return advertised.href;
}

function openWebSocket(
  url: string,
  bearerToken?: string,
  createSocket: (url: string, options: ClientOptions) => WebSocket = (
    socketUrl,
    options,
  ) => new WebSocket(socketUrl, options),
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(url, {
      handshakeTimeout: 10_000,
      maxPayload: 4 * 1024 * 1024,
      perMessageDeflate: false,
      ...(bearerToken
        ? { headers: { authorization: `Bearer ${bearerToken}` } }
        : {}),
    });
    const fail = (error: Error) => {
      socket.close();
      reject(error);
    };
    socket.once("error", fail);
    socket.once("open", () => {
      socket.off("error", fail);
      resolve(socket);
    });
  });
}

const SNAPSHOT_SCRIPT = String.raw`(() => {
  const stateKey = "data-zeros-browser-counter";
  const attr = "data-zeros-browser-ref";
  const root = document.documentElement;
  let counter = Number(root.getAttribute(stateKey) || "0");
  const visible = (element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0; };
  const nameOf = (element) => { const labelledBy = element.getAttribute("aria-labelledby"); if (labelledBy) { const label = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim(); if (label) return label; } const aria = element.getAttribute("aria-label")?.trim(); if (aria) return aria; if (element.labels?.length) { const label = Array.from(element.labels).map((item) => item.textContent || "").join(" ").trim(); if (label) return label; } return (element.innerText || element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("name") || "").trim(); };
  const roleOf = (element) => element.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button" }[element.tagName] || (element.isContentEditable ? "textbox" : "interactive"));
  const candidates = Array.from(document.querySelectorAll("a[href],button,input:not([type=hidden]),textarea,select,summary,[role],[contenteditable=true]"));
  const elements = [];
  for (const element of candidates) { if (elements.length >= 300 || !visible(element)) continue; let ref = element.getAttribute(attr); if (!ref) { counter += 1; ref = "b" + counter; element.setAttribute(attr, ref); } const type = element.getAttribute("type") || undefined; const value = type === "password" || type === "file" ? undefined : ("value" in element ? String(element.value).slice(0, 300) : undefined); elements.push({ ref, role: roleOf(element), name: nameOf(element).replace(/\s+/g, " ").slice(0, 300), type, value, disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"), checked: "checked" in element ? Boolean(element.checked) : undefined, href: element.tagName === "A" ? element.href : undefined }); }
  root.setAttribute(stateKey, String(counter));
  return { title: document.title, url: location.href, viewport: { width: innerWidth, height: innerHeight }, text: (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n").slice(0, 24000), elements };
})()`;

function inspectClickScript(ref: string): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)}); if (!element) return { ok:false,error:"Element ref is stale; take a new snapshot." }; if (element.disabled || element.getAttribute("aria-disabled") === "true") return {ok:false,error:"Element is disabled."}; return {ok:true,label:(element.getAttribute("aria-label") || element.innerText || element.textContent || element.getAttribute("title") || "").trim().replace(/\\s+/g," ").slice(0,300)}; })()`;
}

function clickScript(ref: string): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)}); if (!element) return {ok:false,error:"Element ref is stale; take a new snapshot."}; if (element.disabled || element.getAttribute("aria-disabled") === "true") return {ok:false,error:"Element is disabled."}; element.scrollIntoView({block:"center",inline:"center"}); element.focus?.(); element.click(); return {ok:true}; })()`;
}

function inspectInputScript(ref: string): string {
  return `(() => { const element = document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)}); if (!element) return {ok:false,error:"Element ref is stale; take a new snapshot."}; if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !element.isContentEditable) return {ok:false,error:"Element is not editable."}; const type=String(element.getAttribute("type")||"text").toLowerCase(); return {ok:true,type,label:(element.getAttribute("aria-label") || element.labels?.[0]?.textContent || element.getAttribute("placeholder") || (type === "password" ? "Enter a password" : "Enter text")).trim().replace(/\\s+/g," ").slice(0,300)}; })()`;
}

function typeScript(ref: string, text: string, clear: boolean, allowPassword: boolean): string {
  return `(() => { const element=document.querySelector(${JSON.stringify(`[data-zeros-browser-ref="${ref}"]`)}); if(!element)return {ok:false,error:"Element ref is stale; take a new snapshot."}; const type=String(element.getAttribute("type")||"").toLowerCase(); if(type==="file")return {ok:false,error:"Use the browser upload tool for file inputs."}; if(type==="password"&&!${JSON.stringify(allowPassword)})return {ok:false,error:"Password entry requires explicit confirmation."}; if(!(element instanceof HTMLInputElement)&&!(element instanceof HTMLTextAreaElement)&&!element.isContentEditable)return {ok:false,error:"Element is not editable."}; const next=${JSON.stringify(text)}; element.focus(); if(element.isContentEditable){element.textContent=${clear ? "next" : '(element.textContent || "") + next'};}else{const prior=element.value||""; const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),"value")?.set; setter?.call(element,${clear ? "next" : "prior + next"});} element.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:next})); element.dispatchEvent(new Event("change",{bubbles:true})); return {ok:true}; })()`;
}

function annotationOverlayScript(annotations: ReturnType<typeof parseBrowserAnnotations>): string {
  return `(() => { document.getElementById("__zeros-browser-annotations")?.remove(); const root=document.createElement("div"); root.id="__zeros-browser-annotations"; root.style.cssText="position:fixed;inset:0;pointer-events:none;z-index:2147483647"; for(const annotation of ${JSON.stringify(annotations)}){const target=document.querySelector('[data-zeros-browser-ref="'+annotation.ref+'"]'); if(!target)continue; const rect=target.getBoundingClientRect(); const box=document.createElement("div"); box.style.cssText='position:fixed;left:'+Math.max(0,rect.left-2)+'px;top:'+Math.max(0,rect.top-2)+'px;width:'+Math.max(1,rect.width+4)+'px;height:'+Math.max(1,rect.height+4)+'px;border:3px solid #ff3b30;border-radius:4px;box-sizing:border-box'; const badge=document.createElement("span"); badge.textContent=annotation.label; badge.style.cssText="position:absolute;left:-3px;top:-25px;background:#ff3b30;color:white;padding:2px 6px;border-radius:3px;font:600 12px sans-serif"; box.appendChild(badge); root.appendChild(box);} document.documentElement.appendChild(root); return root.childElementCount; })()`;
}

function annotationCleanupScript(): string {
  return 'document.getElementById("__zeros-browser-annotations")?.remove()';
}

async function settle(page: SharedChromePage): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate("document.readyState");
      if (state === "interactive" || state === "complete") return;
    } catch {
      // Navigation can transiently destroy the execution context.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

function boundedViewport(
  value: unknown,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (
    typeof candidate !== "number" ||
    !Number.isInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error(`Browser ${name} is outside supported bounds.`);
  }
  return candidate;
}

function normalizeWebUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("Only credential-free http(s) URLs are supported.");
  }
  return url.href;
}

function requireRef(value: unknown): string {
  const ref = requireString(value, "ref");
  if (!/^b[1-9]\d{0,8}$/.test(ref)) throw new Error("Invalid browser element ref.");
  return ref;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isConnectionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /disconnect|not connected|connection (?:was )?closed|websocket/i.test(
    message,
  );
}

function isOk(value: unknown): boolean {
  return asRecord(value).ok === true;
}

function errorOf(value: unknown, fallback: string): string {
  const error = asRecord(value).error;
  return typeof error === "string" ? error : fallback;
}

function stringField(value: unknown, key: string): string {
  const field = asRecord(value)[key];
  return typeof field === "string" ? field : "";
}

function capturePageEvent(
  lease: SharedChromeLease,
  event: SharedChromePageEvent,
): void {
  const params = event.params;
  if (event.method === "Runtime.exceptionThrown") {
    const details = asRecord(params.exceptionDetails);
    const exception = asRecord(details.exception);
    appendDiagnostic(
      lease.consoleErrors,
      stringField(exception, "description") ||
        stringField(exception, "value") ||
        stringField(details, "text") ||
        "Uncaught page exception",
      50,
    );
    trace(lease, "console", lease.consoleErrors.at(-1) ?? "Page exception");
    return;
  }
  if (event.method === "Runtime.consoleAPICalled") {
    const type = stringField(params, "type");
    if (!new Set(["error", "warning", "assert"]).has(type)) return;
    const args = Array.isArray(params.args) ? params.args : [];
    const message = args
      .map((raw) => {
        const argument = asRecord(raw);
        return stringField(argument, "description") || String(argument.value ?? "");
      })
      .join(" ")
      .trim();
    appendDiagnostic(lease.consoleErrors, `${type}: ${message || "Console message"}`, 50);
    trace(lease, "console", lease.consoleErrors.at(-1) ?? type);
    return;
  }
  if (event.method === "Log.entryAdded") {
    const entry = asRecord(params.entry);
    const level = stringField(entry, "level");
    if (level !== "error" && level !== "warning") return;
    appendDiagnostic(
      lease.consoleErrors,
      `${level}: ${stringField(entry, "text") || "Page log entry"}`,
      50,
    );
    trace(lease, "console", lease.consoleErrors.at(-1) ?? level);
    return;
  }
  if (event.method === "Network.loadingFailed") {
    if (params.canceled === true) return;
    appendDiagnostic(
      lease.networkErrors,
      stringField(params, "errorText") || "Network request failed",
      50,
    );
    trace(lease, "network", lease.networkErrors.at(-1) ?? "Request failed");
    return;
  }
  if (event.method === "Network.responseReceived") {
    const response = asRecord(params.response);
    const status = typeof response.status === "number" ? response.status : 0;
    if (status < 400) return;
    const rawUrl = stringField(response, "url");
    appendDiagnostic(
      lease.networkErrors,
      `HTTP ${status}${rawUrl ? ` ${redactDiagnosticUrl(rawUrl)}` : ""}`,
      50,
    );
    trace(lease, "network", lease.networkErrors.at(-1) ?? `HTTP ${status}`);
    return;
  }
  if (event.method === "Page.downloadWillBegin") {
    const url = stringField(params, "url");
    const name = stringField(params, "suggestedFilename");
    lease.downloads.push({
      ...(url ? { url: redactDiagnosticUrl(url) } : {}),
      ...(name ? { name: name.replace(/[\r\n]/g, " ").slice(0, 255) } : {}),
    });
    while (lease.downloads.length > 40) lease.downloads.shift();
    trace(lease, "download", name || "Browser download");
  }
}

function appendDiagnostic(target: string[], value: string, limit: number): void {
  target.push(value.replace(/[\r\n]+/g, " ").slice(0, 1_000));
  while (target.length > limit) target.shift();
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

function trace(lease: SharedChromeLease, type: string, detail: string): void {
  lease.trace.push({
    at: Date.now(),
    type: type.slice(0, 80),
    detail: detail.replace(/\s+/g, " ").slice(0, 2_000),
  });
  if (lease.trace.length > 2_000) lease.trace.shift();
}

function success(value: unknown): SharedChromeToolResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

function failure(message: string): SharedChromeToolResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  };
}
