// ──────────────────────────────────────────────────────────
// Sandboxed design-frame runtime client
// ──────────────────────────────────────────────────────────
//
// Every iframe has an opaque origin (`sandbox="allow-scripts"`), so the host
// never reaches into contentDocument. One window-level hub routes versioned
// postMessage responses by exact WindowProxy identity and keeps requests,
// reloads, and retained canvases isolated.

import {
  DESIGN_RUNTIME_PROTOCOL,
  DESIGN_RUNTIME_VERSION,
  isDesignRuntimeFrameMessage,
  type DesignRuntimeFrameMessage,
  type DesignRuntimeHostRequest,
  type DesignRuntimeMethod,
  type DesignRuntimeNodeDetails,
  type DesignRuntimeScreenshot,
  type DesignRuntimeSnapshot,
} from "@zeros/core/design-runtime";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const SCREENSHOT_REQUEST_TIMEOUT_MS = 12_000;

interface RuntimeHostWindow {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: number;
}

export interface DesignFrameRuntimeCallbacks {
  onSnapshot?: (
    snapshot: DesignRuntimeSnapshot,
    event: "ready" | "mutation",
  ) => void;
}

export interface DesignFrameRuntimeConnection {
  getSnapshot(): Promise<DesignRuntimeSnapshot>;
  getElementAtLoc(
    x: number,
    y: number,
  ): Promise<DesignRuntimeNodeDetails | null>;
  getNodeDetails(nodeId: string): Promise<DesignRuntimeNodeDetails>;
  setNodeVisibility(
    nodeId: string,
    visible: boolean,
  ): Promise<DesignRuntimeNodeDetails>;
  previewStyles(
    nodeId: string,
    styles: Record<string, string | null>,
  ): Promise<DesignRuntimeNodeDetails>;
  clearPreviewStyles(nodeId: string): Promise<DesignRuntimeNodeDetails>;
  captureScreenshot(
    nodeId?: string | null,
    scale?: number,
  ): Promise<DesignRuntimeScreenshot>;
  destroy(): void;
}

let requestSequence = 0;

function runtimeError(message: string): Error {
  return new Error(`Design frame runtime: ${message}`);
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

class DesignRuntimeHub {
  private readonly connections = new Map<
    MessageEventSource,
    DesignRuntimeConnectionImpl
  >();
  private listening = false;

  constructor(private readonly host: RuntimeHostWindow) {}

  register(connection: DesignRuntimeConnectionImpl): void {
    this.connections.set(connection.source, connection);
    if (this.listening) return;
    this.listening = true;
    this.host.addEventListener("message", this.handleMessage);
  }

  unregister(connection: DesignRuntimeConnectionImpl): void {
    if (this.connections.get(connection.source) === connection) {
      this.connections.delete(connection.source);
    }
    if (!this.listening || this.connections.size > 0) return;
    this.listening = false;
    this.host.removeEventListener("message", this.handleMessage);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    // Every connected design iframe is sandboxed without allow-same-origin,
    // so its serialized origin must remain opaque for the connection lifetime.
    if (
      event.origin !== "null" ||
      !event.source ||
      !isDesignRuntimeFrameMessage(event.data)
    ) {
      return;
    }
    this.connections.get(event.source)?.receive(event.data);
  };
}

const hubs = new WeakMap<object, DesignRuntimeHub>();

function hubFor(host: RuntimeHostWindow): DesignRuntimeHub {
  const key = host as object;
  const existing = hubs.get(key);
  if (existing) return existing;
  const hub = new DesignRuntimeHub(host);
  hubs.set(key, hub);
  return hub;
}

class DesignRuntimeConnectionImpl implements DesignFrameRuntimeConnection {
  readonly source: MessageEventSource;
  private readonly hub: DesignRuntimeHub;
  private readonly pending = new Map<string, PendingRequest>();
  private destroyed = false;

  constructor(
    source: MessageEventSource,
    private readonly host: RuntimeHostWindow,
    private readonly callbacks: DesignFrameRuntimeCallbacks,
  ) {
    this.source = source;
    this.hub = hubFor(host);
    this.hub.register(this);
  }

  receive(message: DesignRuntimeFrameMessage): void {
    if (this.destroyed) return;
    if (message.type === "event") {
      if (isRuntimeSnapshot(message.payload)) {
        this.callbacks.onSnapshot?.(message.payload, message.event);
      }
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    this.host.clearTimeout(pending.timeout);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(runtimeError(message.error));
    }
  }

  private request(
    method: DesignRuntimeMethod,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.destroyed) return Promise.reject(runtimeError("disconnected"));
    const requestId = `design-runtime-${++requestSequence}`;
    const message: DesignRuntimeHostRequest = {
      protocol: DESIGN_RUNTIME_PROTOCOL,
      version: DESIGN_RUNTIME_VERSION,
      type: "request",
      requestId,
      method,
      args,
    };
    return new Promise((resolve, reject) => {
      const timeout = this.host.setTimeout(
        () => {
          this.pending.delete(requestId);
          reject(runtimeError(`${method} timed out`));
        },
        method === "captureScreenshot"
          ? SCREENSHOT_REQUEST_TIMEOUT_MS
          : DEFAULT_REQUEST_TIMEOUT_MS,
      );
      this.pending.set(requestId, { resolve, reject, timeout });
      (this.source as WindowProxy).postMessage(message, {
        targetOrigin: "*",
      });
    });
  }

  async getSnapshot(): Promise<DesignRuntimeSnapshot> {
    const result = await this.request("getSnapshot", {});
    if (!isRuntimeSnapshot(result)) {
      throw runtimeError("getSnapshot returned malformed data");
    }
    return result;
  }

  async getElementAtLoc(
    x: number,
    y: number,
  ): Promise<DesignRuntimeNodeDetails | null> {
    const result = await this.request("getElementAtLoc", { x, y });
    if (result === null) return null;
    if (!isNodeDetails(result)) {
      throw runtimeError("getElementAtLoc returned malformed data");
    }
    return result;
  }

  async getNodeDetails(nodeId: string): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request("getNodeDetails", { nodeId });
    if (!isNodeDetails(result)) {
      throw runtimeError("getNodeDetails returned malformed data");
    }
    return result;
  }

  async setNodeVisibility(
    nodeId: string,
    visible: boolean,
  ): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request("setNodeVisibility", {
      nodeId,
      visible,
    });
    if (!isNodeDetails(result)) {
      throw runtimeError("setNodeVisibility returned malformed data");
    }
    return result;
  }

  async previewStyles(
    nodeId: string,
    styles: Record<string, string | null>,
  ): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request("previewStyles", { nodeId, styles });
    if (!isNodeDetails(result)) {
      throw runtimeError("previewStyles returned malformed data");
    }
    return result;
  }

  async clearPreviewStyles(nodeId: string): Promise<DesignRuntimeNodeDetails> {
    const result = await this.request("clearPreviewStyles", { nodeId });
    if (!isNodeDetails(result)) {
      throw runtimeError("clearPreviewStyles returned malformed data");
    }
    return result;
  }

  async captureScreenshot(
    nodeId: string | null = null,
    scale = 1,
  ): Promise<DesignRuntimeScreenshot> {
    const result = await this.request("captureScreenshot", {
      ...(nodeId ? { nodeId } : {}),
      scale,
    });
    if (!isRuntimeScreenshot(result)) {
      throw runtimeError("captureScreenshot returned malformed data");
    }
    return result;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.hub.unregister(this);
    for (const pending of this.pending.values()) {
      this.host.clearTimeout(pending.timeout);
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
  iframe: HTMLIFrameElement,
  callbacks: DesignFrameRuntimeCallbacks = {},
  host: RuntimeHostWindow = window,
): DesignFrameRuntimeConnection {
  const source = iframe.contentWindow;
  if (!source) throw runtimeError("iframe has no content window");
  const key = frameKey(workspaceId, frame);
  connectionsByFrame.get(key)?.destroy();
  const connection = new DesignRuntimeConnectionImpl(source, host, callbacks);
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
