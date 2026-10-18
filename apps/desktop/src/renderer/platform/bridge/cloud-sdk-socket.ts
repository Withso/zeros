import { capabilityProofMessage, connectRuntime, RuntimeConnectError, RuntimeRenewal, CloudRestError,
  type RuntimeConnection, type RuntimeSocketFactory } from "@zeros/cloud-client";
import { CloudSdkCapabilityProofFieldsSchema, type CloudSdkRuntimeTarget } from "../../../../shared/cloud-sdk-contract";
import { renewCloudSdkRuntimeCapabilities, signCloudSdkRuntimeProof } from "../cloud-sdk-runtime";
import { subscribeCloudSdkRuntimeRenewals } from "../cloud-sdk-stream";
import { CloudRuntimeAccessError } from "./cloud-runtime-access-error";
import type { RuntimeTransportSocket } from "./runtime-client";

/** The SDK's canonical proof string becomes a closed native request. Native
 * additionally requires its exact issued capability and current handle. */
export function parseCloudSdkCapabilityProof(message: string) {
  const [domain, aud, wsp, jti, timestamp, nonce, route, ...extra] = message.split("\n");
  if (domain !== "zeros-cap-pop-v1" || extra.length || !/^[1-9][0-9]{0,15}$/.test(timestamp ?? ""))
    throw new CloudRuntimeAccessError({ code: "invalid_input", status: 422 });
  const parsed = CloudSdkCapabilityProofFieldsSchema.safeParse({ aud, wsp, jti, timestampMs: Number(timestamp), nonce, route });
  if (!parsed.success || capabilityProofMessage(parsed.data) !== message)
    throw new CloudRuntimeAccessError({ code: "invalid_input", status: 422 });
  return parsed.data;
}

function closeFailure(code: number): CloudRuntimeAccessError {
  if (code === 4403) return new CloudRuntimeAccessError({ code: "capability_revoked", status: 403 });
  if (code === 4426) return new CloudRuntimeAccessError({ code: "cloud_workspace_client_update_required", status: 409 });
  if (code === 4409) return new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
  return new CloudRuntimeAccessError({ code: "cloud_actor_runtime_unavailable", status: 503 });
}
function connectFailure(error: unknown): CloudRuntimeAccessError {
  if (!(error instanceof RuntimeConnectError)) return new CloudRuntimeAccessError(error);
  if (error.code === "runtime_binding_invalid") return new CloudRuntimeAccessError({ code: "bad_response", status: 201 });
  const terminal = error.failures.find(failure => failure.closeCode !== null && [4403, 4426, 4409].includes(failure.closeCode));
  return closeFailure(terminal?.closeCode ?? 1006);
}

/** Socket lifetime belongs to one native descriptor. RPC, boot readiness and
 * Local behavior remain owned by the shared RuntimeClient. */
export class CloudSdkSocket implements RuntimeTransportSocket {
  readyState: 0 | 1 | 3 = 0;
  onopen: RuntimeTransportSocket["onopen"] = null;
  onmessage: RuntimeTransportSocket["onmessage"] = null;
  onclose: RuntimeTransportSocket["onclose"] = null;
  onerror: RuntimeTransportSocket["onerror"] = null;
  cloudFailure?: CloudRuntimeAccessError;
  private readonly stop = new AbortController();
  private connection?: RuntimeConnection;
  private renewal?: RuntimeRenewal;
  private readonly subscriptions: Array<() => void> = [];

  constructor(private readonly target: CloudSdkRuntimeTarget,
    createWebSocket: (url: string, protocols: string[]) => WebSocket,
    private readonly onLegacy: () => Promise<void>) {
    const createSocket: RuntimeSocketFactory = (url, protocols, handlers) => {
      const socket = createWebSocket(url, [...protocols]);
      socket.onopen = () => handlers.open(socket.protocol);
      socket.onmessage = event => {
        if (typeof event.data === "string") handlers.message(event.data);
        else socket.close(4400, "invalid_frame");
      };
      socket.onclose = event => handlers.close(event.code, event.reason);
      socket.onerror = () => { /* the close event drives the race */ };
      return { send: text => socket.send(text), close: (code, reason) => socket.close(code, reason) };
    };
    // Let RuntimeClient install all handlers before any attempt settles.
    void Promise.resolve().then(() => this.start(createSocket));
  }

  private async start(createSocket: RuntimeSocketFactory): Promise<void> {
    if (this.stop.signal.aborted) return;
    try {
      const result = await connectRuntime(this.target.connect, { clientSessionId: this.target.clientSessionId, target: this.target,
        createSocket, signal: this.stop.signal,
        signProof: async message => {
          this.assertLive();
          const proof = await signCloudSdkRuntimeProof(this.target, parseCloudSdkCapabilityProof(message));
          this.assertLive(); return proof;
        } });
      if (this.stop.signal.aborted) { if (result.kind === "connected") result.connection.close(); return; }
      if (result.kind === "legacy") { await this.onLegacy(); this.close(); return; }
      const connection = this.connection = result.connection;
      if (connection.closed) { this.close(1006); return; }
      this.subscriptions.push(connection.onClose((code) => {
        this.cloudFailure = closeFailure(code); this.close(code);
      }));
      this.renewal = new RuntimeRenewal({ workspaceId: this.target.workspaceId, clientSessionId: this.target.clientSessionId, connection,
        capabilities: this.target.connect.capabilities, fetchCapabilities: async () => {
          this.assertLive();
          try { const capabilities = await renewCloudSdkRuntimeCapabilities(this.target); this.assertLive(); return capabilities; }
          catch (error) {
            const failure = new CloudRuntimeAccessError(error);
            throw new CloudRestError({ code: failure.code, status: failure.status, retryable: failure.category === "transient" });
          }
        }, onEvent: event => {
          if (event.type === "refused") { this.cloudFailure = new CloudRuntimeAccessError(event); this.close(4403); }
        } });
      void subscribeCloudSdkRuntimeRenewals(this.target, capabilities => {
        if (!this.stop.signal.aborted) this.renewal?.handleFrame({ t: "capability.renewed", d: {
          workspaceId: this.target.workspaceId, clientSessionId: this.target.clientSessionId, capabilities,
        } });
      }).then(off => { if (this.stop.signal.aborted) off(); else this.subscriptions.push(off); }).catch(() => {});
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      if (this.stop.signal.aborted) return;
      // auth.ok may be immediately followed by ENGINE_READY. Drain it only
      // after the shared client has promoted this transport and sent CONNECTED.
      this.subscriptions.push(connection.onMessage(data => this.onmessage?.(new MessageEvent("message", { data }))));
    } catch (error) {
      if (this.stop.signal.aborted) return;
      this.cloudFailure = connectFailure(error); this.close(1000);
    }
  }

  send(text: string): void { this.assertLive(); if (!this.connection || this.readyState !== 1) throw new Error("Cloud runtime is not connected"); this.connection.send(text); }

  close(code = 1000, _reason = "client_closed"): void {
    if (this.readyState === 3) return;
    this.readyState = 3; this.stop.abort(); this.renewal?.stop();
    for (const off of this.subscriptions.splice(0)) off();
    // Browser-originated closes accept 1000 or 3000-4999; transport failures
    // such as 1006 are observations, never arguments to WebSocket.close.
    this.connection?.close(code === 1000 || code >= 3000 && code <= 4999 ? code : 1000, "client_closed");
    this.onclose?.({ code, reason: "cloud_runtime_closed" } as CloseEvent);
  }
  private assertLive(): void {
    if (this.stop.signal.aborted) throw new CloudRuntimeAccessError({ code: "cloud_workspace_access_superseded", status: 409 });
  }
}
