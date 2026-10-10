import { CloudAgentConnection } from "../../../apps/desktop/src/renderer/platform/bridge/cloud-agent-connection";
import { CloudEventReader } from "../../../apps/desktop/src/renderer/platform/bridge/cloud-event-reader";
import type { RuntimeClient, RuntimeExecutionIdentity } from "../../../apps/desktop/src/renderer/platform/bridge/ws-client";
import type { BridgeMessage as RendererMessage } from "../../../apps/desktop/src/renderer/platform/bridge/messages";
import type { BridgeMessage, BridgeConnectionStatus, BridgeRequestOptions } from "../lib/bridge-client";

export interface RendererBridge {
  readonly status: BridgeConnectionStatus;
  readonly engineCapabilities?: readonly string[];
  requestEnvelope(op: string, params?: Record<string, unknown>, options?: BridgeRequestOptions): Promise<BridgeMessage>;
  onMessage(listener: (frame: BridgeMessage) => void): () => void;
  onStatusChange(listener: (status: BridgeConnectionStatus) => void): () => void;
}

/** A Node transport port for the actual renderer classes. This covers renderer
 * Send, not Electron account preparation, browser click timing or reconnect. */
export function createRendererDriver(bridge: RendererBridge, workspaceId: string,
  grant: (agentId: string, model: string) => Promise<string>, executionIdentity?: RuntimeExecutionIdentity) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(workspaceId)) throw new Error("renderer_workspace_invalid");
  let disposed = false;
  const lifetime = new AbortController();
  const subscriptions = new Set<() => void>();
  const track = (off: () => void) => {
    const release = () => { if (subscriptions.delete(release)) off(); };
    subscriptions.add(release);
    return release;
  };
  // The renderer classes only need these three methods. The browser socket,
  // auth and retry implementations are deliberately supplied by the real
  // authenticated harness bridge, not an emulated Electron connection.
  const client = {
    get status() { return bridge.status; },
    get executionIdentity() { return executionIdentity; },
    supportsEngineCapability(capability: string) {
      return bridge.status === "connected" && bridge.engineCapabilities?.includes(capability) === true;
    },
    async request(message: Record<string, unknown>, options?: number | BridgeRequestOptions) {
      if (disposed) throw new Error("renderer_driver_disposed");
      if (message.type !== "WORKSPACE_REQUEST" || typeof message.op !== "string")
        throw new Error("renderer_request_invalid");
      const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
        ? message.params as Record<string, unknown> : {};
      if (params.workspaceId !== undefined && params.workspaceId !== workspaceId)
        throw new Error("renderer_workspace_mismatch");
      const requestOptions = typeof options === "number" ? { timeoutMs: options } : options ?? {};
      const signal = requestOptions.signal
        ? AbortSignal.any([lifetime.signal, requestOptions.signal]) : lifetime.signal;
      // The admitted socket selects the engine. Its strict cloud operations
      // carry only their own params; create already supplies workspaceId.
      return bridge.requestEnvelope(message.op, params, { ...requestOptions, signal });
    },
    on(type: string, listener: (frame: RendererMessage) => void) {
      if (disposed) throw new Error("renderer_driver_disposed");
      return track(bridge.onMessage(frame => {
        if (frame.type === type) listener(frame as unknown as RendererMessage);
      }));
    },
    onStatusChange(listener: (status: BridgeConnectionStatus) => void) {
      if (disposed) throw new Error("renderer_driver_disposed");
      return track(bridge.onStatusChange(listener));
    },
  };
  const runtime = client as unknown as RuntimeClient;
  const events = new CloudEventReader(runtime, conversationId => {
    void connection.refreshAttachments(conversationId);
  });
  const connection = new CloudAgentConnection(runtime, workspaceId, grant, events);
  const offEvents: Array<() => void> = [];
  for (const type of ["AGENT_PROMPT_COMPLETE", "AGENT_PROMPT_FAILED"])
    offEvents.push(events.on(type, frame => {
      connection.incoming(frame as unknown as Record<string, unknown>);
      connection.observePromptResult(frame as unknown as Record<string, unknown>);
    }));
  for (const type of ["AGENT_SESSION_CREATED", "AGENT_SESSION_LOADED", "AGENT_SESSION_UPDATE"])
    offEvents.push(events.on(type, frame => { connection.incoming(frame as unknown as Record<string, unknown>); }));
  return {
    client, connection, events,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      for (const off of offEvents) off();
      events.dispose();
      connection.dispose();
      for (const off of [...subscriptions]) off();
    },
  };
}
