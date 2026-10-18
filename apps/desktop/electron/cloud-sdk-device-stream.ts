import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { CloudRestError, DeviceStreamClient, type DeviceStreamEvent, type DeviceStreamResumeBase, type DeviceStreamSocketFactory } from "@zeros/cloud-client";
import type { CloudSdkRuntimeBroker } from "./cloud-sdk-runtime-broker";
import { CloudWorkspaceAccessClientError } from "./cloud-workspace-access-client";
import { CloudSdkRuntimeIdentitySchema } from "../shared/cloud-sdk-contract";
import { CloudSdkDeviceFrameSchema, CloudSdkStreamCommandSchema, CloudSdkStreamPayloadSchema,
  type CloudSdkStreamCommand, type CloudSdkStreamEvent, type CloudSdkStreamSnapshot } from "../shared/cloud-sdk-stream-contract";

const MAX_FRAME_BYTES = 512 * 1024;
type RuntimeAuthority = Pick<CloudSdkRuntimeBroker, "assertActive" | "openStreamSession" | "runtimeTargets" | "subscribeRuntimeTargets" |
  "assertRuntime" | "acceptPushedCapabilities" | "close">;
type Options = { broker: RuntimeAuthority; emit(event: CloudSdkStreamEvent): void; createSocket?: DeviceStreamSocketFactory;
  newId?: () => string; random?: () => number };
export type CloudStreamRendererLifetime = (onGone: () => void) => () => void;

const nativeSocket: DeviceStreamSocketFactory = (url, handlers) => {
  const socket = new WebSocket(url, { maxPayload: MAX_FRAME_BYTES, followRedirects: false, handshakeTimeout: 10_000 });
  socket.on("open", () => handlers.open());
  socket.on("message", (data, binary) => {
    if (binary) socket.close(4400, "invalid_frame");
    else handlers.message(data.toString());
  });
  socket.on("close", code => handlers.close(code, "stream_closed"));
  socket.on("error", () => {});
  return { send: text => socket.send(text), close: (code, reason) => {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket.close(code, reason);
  } };
};
const runtimeIdentity = (runtime: Parameters<RuntimeAuthority["assertRuntime"]>[0]) => {
  const { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence } = runtime;
  return CloudSdkRuntimeIdentitySchema.parse({ organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence });
};

/** One signed-in device stream and one replaceable lease for the app's single
 * renderer window. No ticket, cursor or renderer-supplied grant enters IPC. */
export class CloudSdkDeviceStream {
  private readonly streamId: string;
  private leaseId: string | null = null;
  private sequence = 0;
  private catalogRequired = false;
  private expectedSessionId: string | null = null;
  private resume: DeviceStreamResumeBase | null = null;
  private organizations: Array<{ organizationId: string }> = [];
  private readonly attached = new Map<string, { workspaceId: string; clientSessionId: string }>();
  private readonly client: DeviceStreamClient;
  private readonly offRuntimes: () => void;
  private disposed = false;
  private unbindRenderer?: () => void;

  constructor(private readonly options: Options) {
    this.streamId = (options.newId ?? randomUUID)();
    this.client = new DeviceStreamClient({
      openSession: async held => {
        try {
          this.assertActive(); const grant = await options.broker.openStreamSession(held); this.assertActive();
          this.expectedSessionId = grant.deviceSessionId;
          this.syncRuntimes(); return grant;
        } catch (failure) {
          if (failure instanceof CloudWorkspaceAccessClientError) throw new CloudRestError({ code: failure.code, status: failure.status });
          throw failure;
        }
      },
      createSocket: (url, handlers) => (options.createSocket ?? nativeSocket)(url, {
        ...handlers, message: text => {
          if (!this.isActive()) return;
          if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) { this.client.stop(); return; }
          let raw: unknown;
          try { raw = JSON.parse(text); } catch { this.client.stop(); return; }
          const type = raw && typeof raw === "object" ? (raw as { t?: unknown }).t : undefined;
          // Unknown types are ignored per S3; known consumed frames are checked.
          if (!CloudSdkDeviceFrameSchema.options.some(schema => schema.shape.t.value === type)) return;
          const parsed = CloudSdkDeviceFrameSchema.safeParse(raw);
          if (!parsed.success || parsed.data.t === "ready" && parsed.data.d.deviceSessionId !== this.expectedSessionId) { this.client.stop(); return; }
          handlers.message(JSON.stringify(parsed.data));
        },
      }),
      resumeBase: () => this.resume,
      onEvent: event => this.onEvent(event), random: options.random,
    });
    this.offRuntimes = options.broker.subscribeRuntimeTargets(() => this.syncRuntimes());
  }

  snapshot(): CloudSdkStreamSnapshot {
    return { streamId: this.streamId, leaseId: this.leaseId, sequence: this.sequence, revision: this.client.coverageRevision,
      state: this.client.state.kind, catalogRequired: this.catalogRequired,
      organizations: this.organizations.map(({ organizationId }) => ({ organizationId, ...this.client.pollCoverage(organizationId) })) };
  }

  control(input: Extract<CloudSdkStreamCommand, { action: "start" }>, lifetime?: CloudStreamRendererLifetime): CloudSdkStreamSnapshot;
  control(input: Exclude<CloudSdkStreamCommand, { action: "start" }>, lifetime?: CloudStreamRendererLifetime): boolean;
  control(input: CloudSdkStreamCommand, lifetime?: CloudStreamRendererLifetime): CloudSdkStreamSnapshot | boolean;
  control(raw: CloudSdkStreamCommand, lifetime?: CloudStreamRendererLifetime): CloudSdkStreamSnapshot | boolean {
    const input = CloudSdkStreamCommandSchema.parse(raw); this.assertActive();
    if (input.action === "start") {
      this.unbindRenderer?.(); this.unbindRenderer = undefined;
      this.leaseId = (this.options.newId ?? randomUUID)();
      const leaseId = this.leaseId;
      this.unbindRenderer = lifetime?.(() => {
        if (this.leaseId !== leaseId) return;
        this.client.stop(); this.leaseId = null; this.unbindRenderer?.(); this.unbindRenderer = undefined;
      });
      this.client.start(); return this.snapshot();
    }
    if (input.streamId !== this.streamId || input.leaseId !== this.leaseId) return false;
    if (input.action === "stop") {
      this.client.stop(); this.leaseId = null; this.unbindRenderer?.(); this.unbindRenderer = undefined; return true;
    }
    if (input.action === "snapshot-current") {
      if (input.revision !== this.client.coverageRevision || this.client.state.kind !== "open") return false;
      this.catalogRequired = false;
      if (input.catalogVersion === null) { this.publish({ type: "state" }); return false; }
      this.resume = { catalogVersion: input.catalogVersion, workspaces: Object.fromEntries(input.workspaces.map(row => [row.workspaceId, row.version])) };
      const marked = this.client.markCatalogCurrent(input.revision);
      this.publish({ type: "state" }); return marked;
    }
    this.options.broker.assertRuntime(input.runtime);
    const target = this.options.broker.runtimeTargets().find(row => row.runtimeId === input.runtime.runtimeId);
    if (!target || target.deviceSessionId !== this.expectedSessionId || !this.client.pollCoverage(target.organizationId).presence) return false;
    this.client.setPresence(target.workspaceId, input.state); return true;
  }

  private syncRuntimes(): void {
    if (!this.isActive()) return;
    const current = new Map(this.options.broker.runtimeTargets().filter(row => row.deviceSessionId === this.expectedSessionId)
      .map(row => [row.runtimeId, { workspaceId: row.workspaceId, clientSessionId: row.clientSessionId }]));
    for (const [id, prior] of this.attached) {
      const next = current.get(id);
      if (next?.workspaceId === prior.workspaceId && next.clientSessionId === prior.clientSessionId) continue;
      this.client.detach(prior.workspaceId, prior.clientSessionId); this.attached.delete(id);
    }
    for (const [id, next] of current) if (!this.attached.has(id)) {
      this.attached.set(id, next); this.client.attach(next.workspaceId, next.clientSessionId);
    }
  }

  private onEvent(event: DeviceStreamEvent): void {
    if (!this.isActive()) return;
    if (event.type === "error" && event.fatal) { this.client.stop(); return; }
    // The SDK synchronously emits open, ready and snapshot_required. Publish
    // that ready observation once, after its coverage metadata is complete,
    // so the renderer does not start and then invalidate a duplicate read.
    if (event.type === "state" && event.state.kind === "open") return;
    if (event.type === "ready") {
      this.organizations = event.ready.organizationFeatures ?? [];
      if (!event.ready.resumed || event.ready.organizationFeatures !== undefined) return;
    }
    if (event.type === "snapshot_required") this.catalogRequired = true;
    if (event.type === "coverage" || event.type === "state" && event.state.kind !== "open") this.catalogRequired = false;
    if (event.type !== "frame") { this.publish({ type: "state" }); return; }
    const frame = event.frame;
    if (frame.t === "capability.renewed") {
      for (const runtime of this.options.broker.runtimeTargets()) {
        if (runtime.deviceSessionId !== this.expectedSessionId || runtime.workspaceId !== frame.d.workspaceId || runtime.clientSessionId !== frame.d.clientSessionId) continue;
        try {
          const identity = runtimeIdentity(runtime);
          const capabilities = this.options.broker.acceptPushedCapabilities(identity, frame.d.clientSessionId, frame.d.capabilities);
          this.publish({ type: "renewal", runtime: identity, capabilities });
        } catch { this.client.stop(); }
      }
      return;
    }
    if (frame.t === "capability.revoked") {
      for (const runtime of this.options.broker.runtimeTargets())
        if (runtime.deviceSessionId === this.expectedSessionId && (!frame.d.workspaceId || runtime.workspaceId === frame.d.workspaceId)) this.options.broker.close(runtime.runtimeId);
    }
    const parsed = CloudSdkStreamPayloadSchema.safeParse(frame);
    if (parsed.success) this.publish({ type: "frame", frame: parsed.data });
  }

  private publish(event: CloudSdkStreamEvent["event"]): void {
    if (!this.leaseId || this.disposed) return;
    this.sequence += 1; this.options.emit({ ...this.snapshot(), event });
  }
  private assertActive(): void {
    if (this.disposed) throw new Error("Cloud stream retired");
    this.options.broker.assertActive();
  }
  private isActive(): boolean {
    try { this.assertActive(); return true; } catch { this.dispose(); return false; }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.client.stop(); this.offRuntimes?.(); this.attached.clear();
    this.unbindRenderer?.(); this.unbindRenderer = undefined;
    this.resume = null; this.organizations = []; this.leaseId = null;
  }
}
