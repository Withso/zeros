// ──────────────────────────────────────────────────────────
// Sandboxed design-frame runtime client
// ──────────────────────────────────────────────────────────
//
// Every iframe has an opaque origin (`sandbox="allow-scripts"`), so the host
// never reaches into contentDocument. A one-time, protocol-validated parent
// handshake transfers a private MessagePort; all document data and subsequent
// requests stay on that per-document channel.

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_VERSION,
  isDesignRuntimeFrameMessage,
  type DesignRuntimeFrameMessage,
  type DesignRuntimeCapabilities,
  type DesignRuntimeHostCancel,
  type DesignRuntimeHostHandshake,
  type DesignRuntimeHostRequest,
  type DesignRuntimeHostTeardown,
  type DesignRuntimeMatchedStyles,
  type DesignRuntimeMethod,
  type DesignRuntimeHitMode,
  type DesignRuntimeMotionPreview,
  type DesignRuntimeNodeDetails,
  type DesignRuntimeScreenshot,
  type DesignRuntimeSnapshot,
} from "@zeros/protocol/design-runtime";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const SCREENSHOT_REQUEST_TIMEOUT_MS = 12_000;

interface RuntimeHostWindow {
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
  signal?: AbortSignal;
  abort?: () => void;
}

export interface DesignFrameRuntimeCallbacks {
  onSnapshot?: (
    snapshot: DesignRuntimeSnapshot,
    event: "ready" | "mutation",
  ) => void;
  onReady?: (capabilities: DesignRuntimeCapabilities) => void;
}

export interface DesignFrameRuntimeConnection {
  getSnapshot(signal?: AbortSignal): Promise<DesignRuntimeSnapshot>;
  getElementAtLoc(
    x: number,
    y: number,
    options?: {
      mode?: DesignRuntimeHitMode;
      selectedNodeId?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails | null>;
  getElementsInRect(
    rect: { x: number; y: number; width: number; height: number },
    scopeNodeId?: string | null,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails[]>;
  getNodeDetails(
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails>;
  getMatchedStyles(
    nodeId: string,
    property: string,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeMatchedStyles>;
  setNodeVisibility(
    nodeId: string,
    visible: boolean,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails>;
  setTheme(
    theme: string | null,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeSnapshot>;
  previewStyles(
    nodeId: string,
    styles: Record<string, string | null>,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails>;
  previewMotion(
    nodeId: string,
    motion: DesignRuntimeMotionPreview,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails>;
  clearPreviewStyles(
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails>;
  captureScreenshot(
    nodeId?: string | null,
    scale?: number,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeScreenshot>;
  destroy(): void;
}

let requestSequence = 0;

export class DesignFrameRuntimeError extends Error {
  constructor(
    message: string,
    readonly code = "INTERNAL_ERROR",
    readonly retryable = false,
  ) {
    super(`Design frame runtime: ${message}`);
    this.name = "DesignFrameRuntimeError";
  }
}

function runtimeError(
  message: string,
  code = "INTERNAL_ERROR",
  retryable = false,
): DesignFrameRuntimeError {
  return new DesignFrameRuntimeError(message, code, retryable);
}

function isRuntimeSnapshot(value: unknown): value is DesignRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<DesignRuntimeSnapshot>;
  return (
    typeof snapshot.sourceVersion === "string" &&
    typeof snapshot.revision === "number" &&
    Array.isArray(snapshot.tree) &&
    Array.isArray(snapshot.warnings) &&
    !!snapshot.frame &&
    typeof snapshot.frame === "object" &&
    !!snapshot.viewport &&
    typeof snapshot.viewport === "object"
  );
}

function isNodeDetails(value: unknown): value is DesignRuntimeNodeDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const details = value as Partial<DesignRuntimeNodeDetails>;
  return (
    typeof details.sourceVersion === "string" &&
    typeof details.oid === "string" &&
    typeof details.tag === "string" &&
    (details.textEditable === undefined ||
      typeof details.textEditable === "boolean") &&
    typeof details.selector === "string" &&
    Array.isArray(details.breadcrumb) &&
    !!details.rect &&
    typeof details.rect === "object" &&
    !!details.styles &&
    typeof details.styles === "object"
  );
}

function isRuntimeScreenshot(value: unknown): value is DesignRuntimeScreenshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const screenshot = value as Partial<DesignRuntimeScreenshot>;
  return (
    typeof screenshot.sourceVersion === "string" &&
    typeof screenshot.dataUrl === "string" &&
    screenshot.dataUrl.startsWith("data:image/") &&
    screenshot.mimeType === "image/png" &&
    typeof screenshot.width === "number" &&
    typeof screenshot.height === "number" &&
    typeof screenshot.scale === "number"
  );
}

function isRuntimeCapabilities(
  value: unknown,
): value is DesignRuntimeCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const capabilities = value as Partial<DesignRuntimeCapabilities>;
  return (
    Array.isArray(capabilities.methods) &&
    capabilities.cancellation === true &&
    capabilities.typedErrors === true &&
    capabilities.sourcePinned === true &&
    typeof capabilities.maxStyleProperties === "number" &&
    typeof capabilities.maxMatchedDeclarations === "number" &&
    typeof capabilities.maxCapturePixels === "number"
  );
}

function isMatchedStyles(value: unknown): value is DesignRuntimeMatchedStyles {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const matched = value as Partial<DesignRuntimeMatchedStyles>;
  return (
    typeof matched.sourceVersion === "string" &&
    typeof matched.nodeId === "string" &&
    typeof matched.property === "string" &&
    typeof matched.computedValue === "string" &&
    Array.isArray(matched.matched) &&
    typeof matched.truncated === "boolean"
  );
}

class DesignRuntimeConnectionImpl implements DesignFrameRuntimeConnection {
  readonly source: MessageEventSource;
  private readonly channel = new MessageChannel();
  private readonly pending = new Map<string, PendingRequest>();
  private destroyed = false;

  constructor(
    source: MessageEventSource,
    private readonly expectedSourceVersion: string,
    private readonly host: RuntimeHostWindow,
    private readonly callbacks: DesignFrameRuntimeCallbacks,
  ) {
    this.source = source;
    this.channel.port1.addEventListener("message", this.handleMessage);
    this.channel.port1.start();
    const handshake: DesignRuntimeHostHandshake = {
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "handshake",
      sourceVersion: this.expectedSourceVersion,
    };
    (this.source as WindowProxy).postMessage(handshake, {
      targetOrigin: "*",
      transfer: [this.channel.port2],
    });
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    if (isDesignRuntimeFrameMessage(event.data)) this.receive(event.data);
  };

  receive(message: DesignRuntimeFrameMessage): void {
    if (this.destroyed) return;
    if (message.type === "event") {
      if (message.event === "ready") {
        if (
          message.payload.sourceVersion !== this.expectedSourceVersion ||
          !isRuntimeCapabilities(message.payload.capabilities) ||
          !isRuntimeSnapshot(message.payload.snapshot) ||
          message.payload.snapshot.sourceVersion !== this.expectedSourceVersion
        ) {
          this.destroy();
          return;
        }
        this.callbacks.onReady?.(message.payload.capabilities);
        this.callbacks.onSnapshot?.(message.payload.snapshot, "ready");
      } else if (
        isRuntimeSnapshot(message.payload) &&
        message.payload.sourceVersion === this.expectedSourceVersion
      ) {
        this.callbacks.onSnapshot?.(message.payload, "mutation");
      }
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    this.host.clearTimeout(pending.timeout);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(
        runtimeError(
          message.error.message,
          message.error.code,
          message.error.retryable,
        ),
      );
    }
  }

  private cancel(requestId: string): void {
    if (this.destroyed) return;
    const cancel: DesignRuntimeHostCancel = {
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "cancel",
      sourceVersion: this.expectedSourceVersion,
      requestId,
    };
    this.channel.port1.postMessage(cancel);
  }

  private request(
    method: DesignRuntimeMethod,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.destroyed) return Promise.reject(runtimeError("disconnected"));
    if (signal?.aborted) {
      return Promise.reject(
        runtimeError("request cancelled", "CANCELLED", false),
      );
    }
    const requestId = `design-runtime-${++requestSequence}`;
    const message: DesignRuntimeHostRequest = {
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "request",
      sourceVersion: this.expectedSourceVersion,
      requestId,
      method,
      args,
    };
    return new Promise((resolve, reject) => {
      const abort = signal
        ? () => {
            const pending = this.pending.get(requestId);
            if (!pending) return;
            this.pending.delete(requestId);
            this.host.clearTimeout(timeout);
            this.cancel(requestId);
            reject(runtimeError("request cancelled", "CANCELLED", false));
          }
        : undefined;
      const timeout = this.host.setTimeout(
        () => {
          if (!this.pending.delete(requestId)) return;
          if (signal && abort) signal.removeEventListener("abort", abort);
          this.cancel(requestId);
          reject(runtimeError(`${method} timed out`));
        },
        method === "captureScreenshot"
          ? SCREENSHOT_REQUEST_TIMEOUT_MS
          : DEFAULT_REQUEST_TIMEOUT_MS,
      );
      this.pending.set(requestId, {
        resolve,
        reject,
        timeout,
        ...(signal ? { signal } : {}),
        ...(abort ? { abort } : {}),
      });
      if (signal && abort) {
        signal.addEventListener("abort", abort, { once: true });
        // Close the race between the entry check and listener registration.
        if (signal.aborted) abort();
      }
      if (!this.pending.has(requestId)) return;
      this.channel.port1.postMessage(message);
    });
  }

  async getSnapshot(signal?: AbortSignal): Promise<DesignRuntimeSnapshot> {
    const result = await this.request("getSnapshot", {}, signal);
    if (
      !isRuntimeSnapshot(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("getSnapshot returned malformed data");
    }
    return result;
  }

  async getElementAtLoc(
    x: number,
    y: number,
    options: {
      mode?: DesignRuntimeHitMode;
      selectedNodeId?: string | null;
    } = {},
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails | null> {
    const result = await this.request(
      "getElementAtLoc",
      {
        x,
        y,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.selectedNodeId
          ? { selectedNodeId: options.selectedNodeId }
          : {}),
      },
      signal,
    );
    if (result === null) return null;
    if (
      !isNodeDetails(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("getElementAtLoc returned malformed data");
    }
    return result;
  }

  async getElementsInRect(
    rect: { x: number; y: number; width: number; height: number },
    scopeNodeId?: string | null,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails[]> {
    const result = await this.request(
      "getElementsInRect",
      {
        ...rect,
        ...(scopeNodeId ? { scopeNodeId } : {}),
      },
      signal,
    );
    if (
      !Array.isArray(result) ||
      result.length > 128 ||
      result.some(
        (details) =>
          !isNodeDetails(details) ||
          details.sourceVersion !== this.expectedSourceVersion,
      )
    ) {
      throw runtimeError("getElementsInRect returned malformed data");
    }
    return result;
  }

  async getNodeDetails(
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request("getNodeDetails", { nodeId }, signal);
    if (
      !isNodeDetails(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("getNodeDetails returned malformed data");
    }
    return result;
  }

  async getMatchedStyles(
    nodeId: string,
    property: string,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeMatchedStyles> {
    const result = await this.request(
      "getMatchedStyles",
      { nodeId, property },
      signal,
    );
    if (
      !isMatchedStyles(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("getMatchedStyles returned malformed data");
    }
    return result;
  }

  async setNodeVisibility(
    nodeId: string,
    visible: boolean,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request(
      "setNodeVisibility",
      {
        nodeId,
        visible,
      },
      signal,
    );
    if (
      !isNodeDetails(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("setNodeVisibility returned malformed data");
    }
    return result;
  }

  async setTheme(
    theme: string | null,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeSnapshot> {
    const result = await this.request("setTheme", { theme }, signal);
    if (
      !isRuntimeSnapshot(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("setTheme returned malformed data");
    }
    return result;
  }

  async previewStyles(
    nodeId: string,
    styles: Record<string, string | null>,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request(
      "previewStyles",
      { nodeId, styles },
      signal,
    );
    if (
      !isNodeDetails(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("previewStyles returned malformed data");
    }
    return result;
  }

  async previewMotion(
    nodeId: string,
    motion: DesignRuntimeMotionPreview,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request(
      "previewMotion",
      { nodeId, ...motion },
      signal,
    );
    if (
      !isNodeDetails(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("previewMotion returned malformed data");
    }
    return result;
  }

  async clearPreviewStyles(
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request("clearPreviewStyles", { nodeId }, signal);
    if (
      !isNodeDetails(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("clearPreviewStyles returned malformed data");
    }
    return result;
  }

  async captureScreenshot(
    nodeId: string | null = null,
    scale = 1,
    signal?: AbortSignal,
  ): Promise<DesignRuntimeScreenshot> {
    const result = await this.request(
      "captureScreenshot",
      {
        ...(nodeId ? { nodeId } : {}),
        scale,
      },
      signal,
    );
    if (
      !isRuntimeScreenshot(result) ||
      result.sourceVersion !== this.expectedSourceVersion
    ) {
      throw runtimeError("captureScreenshot returned malformed data");
    }
    return result;
  }

  destroy(): void {
    if (this.destroyed) return;
    const teardown: DesignRuntimeHostTeardown = {
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "teardown",
      sourceVersion: this.expectedSourceVersion,
    };
    this.channel.port1.postMessage(teardown);
    this.destroyed = true;
    this.channel.port1.removeEventListener("message", this.handleMessage);
    this.channel.port1.close();
    for (const pending of this.pending.values()) {
      this.host.clearTimeout(pending.timeout);
      if (pending.signal && pending.abort) {
        pending.signal.removeEventListener("abort", pending.abort);
      }
      pending.reject(runtimeError("disconnected"));
    }
    this.pending.clear();
  }
}

const connectionsByFrame = new Map<string, DesignRuntimeConnectionImpl>();

function frameKey(workspaceId: string, frame: string): string {
  return `${workspaceId}\u0000${frame}`;
}

export function connectDesignFrameRuntime(
  workspaceId: string,
  frame: string,
  sourceVersion: string,
  iframe: HTMLIFrameElement,
  callbacks: DesignFrameRuntimeCallbacks = {},
  host: RuntimeHostWindow = window,
): DesignFrameRuntimeConnection {
  if (!/^[a-f0-9]{24}$/.test(sourceVersion)) {
    throw runtimeError("invalid source generation", "BAD_REQUEST");
  }
  const source = iframe.contentWindow;
  if (!source) throw runtimeError("iframe has no content window");
  const key = frameKey(workspaceId, frame);
  connectionsByFrame.get(key)?.destroy();
  const connection = new DesignRuntimeConnectionImpl(
    source,
    sourceVersion,
    host,
    callbacks,
  );
  connectionsByFrame.set(key, connection);
  const destroy = connection.destroy.bind(connection);
  connection.destroy = () => {
    if (connectionsByFrame.get(key) === connection) {
      connectionsByFrame.delete(key);
    }
    destroy();
  };
  return connection;
}

export function designFrameRuntime(
  workspaceId: string,
  frame: string,
): DesignFrameRuntimeConnection | null {
  return connectionsByFrame.get(frameKey(workspaceId, frame)) ?? null;
}
