import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { WebSocket } from "ws";
import { capabilityProofMessage, CloudRestError, probeFromConnectFailure,
  type DeviceSessionGrant, type DeviceStreamSocketFactory } from "@zeros/cloud-client";
import { CAPABILITY_POP_TIMESTAMP_LEEWAY_MS } from "@zeros/protocol/cloud-capabilities";
import { CloudSdkRuntimeBroker } from "../../apps/desktop/electron/cloud-sdk-runtime-broker";
import { CloudSdkDeviceStream } from "../../apps/desktop/electron/cloud-sdk-device-stream";
import { CloudWorkspaceAccessClientError } from "../../apps/desktop/electron/cloud-workspace-access-client";
import { CloudReplicaDeviceSigner } from "../../apps/desktop/src/engine/cloud-replica-device";
import { CloudSdkCapabilityProofFieldsSchema, CloudSdkDeviceRequestSchema, type CloudSdkRuntimeIdentity } from "../../apps/desktop/shared/cloud-sdk-contract";
import { CloudSdkSocket, type CloudSdkSocketAuthority } from "../../apps/desktop/src/renderer/platform/bridge/cloud-sdk-socket";
import { CloudRuntimeAccessError } from "../../apps/desktop/src/renderer/platform/bridge/cloud-runtime-access-error";
import { RuntimeClient, type RuntimeClientEnvironment } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";
import { ALPHA_ORIGIN } from "./config";
import { ZerosDevError } from "./errors";
import type { Evidence, SdkObservation, SdkPhase } from "./evidence";
import type { ProductApi } from "./product";
import type { Run } from "./receipts";
import type { ZerosDevSession } from "./session";
import { beforeDeadline } from "./transport";

type Session = Pick<ZerosDevSession, "fixture" | "device" | "accessToken" | "accountSessionKey">;
type Options = { evidence: Evidence; signal: AbortSignal; monotonic?: () => number;
  // Dependency ports for loopback tests only; never populated from argv/env.
  environment?: RuntimeClientEnvironment; fetch?: typeof fetch; createStreamSocket?: DeviceStreamSocketFactory };
type SkipReason = NonNullable<SdkObservation["skip"]>;
class Skip extends Error { constructor(readonly reason: SkipReason) { super(reason); } }
const cloudSdkRuntimeIdentity = (value: CloudSdkRuntimeIdentity): CloudSdkRuntimeIdentity => {
  const { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence } = value;
  return { organizationId, workspaceId, runtimeId, generation, authorityEpoch, engineInstanceId, connectionSequence };
};

function failure(error: unknown): ZerosDevError {
  if (error instanceof ZerosDevError) return error;
  if (error instanceof CloudRestError || error instanceof CloudWorkspaceAccessClientError || error instanceof CloudRuntimeAccessError) {
    const { status, code } = error;
    return new ZerosDevError(code === "bad_response" ? "bad_response" :
      code === "cloud_workspace_access_superseded" ? "identity_changed" :
      status === 401 ? "auth_denied" : status === 403 ? "forbidden" : status === 404 ? "not_found" :
      status === 429 ? "rate_limited" : status >= 500 ? "service_unavailable" : "runtime_unavailable");
  }
  return new ZerosDevError("runtime_unavailable");
}

/** Bounded, read-only native SDK proof for one already-running fixture boot.
 * Its sockets and authority end before the infrastructure workload continues;
 * a legacy discovery result never becomes positive SDK evidence. */
export async function probeSdkRuntime(session: Session, api: ProductApi, run: Run, options: Options): Promise<void> {
  const clock = options.monotonic ?? (() => performance.now()), probeId = randomUUID();
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 30_000);
  const signal = AbortSignal.any([options.signal, timeout.signal]);
  let broker: CloudSdkRuntimeBroker | undefined, stream: CloudSdkDeviceStream | undefined, client: RuntimeClient | undefined;
  let socket: CloudSdkSocket | undefined, disposed = false;
  const closeSockets: Array<() => void> = [];
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const close of [() => client?.dispose(), () => stream?.dispose(), () => broker?.dispose(), ...closeSockets.splice(0)]) {
      try { close(); } catch { /* continue retiring every independently owned resource */ }
    }
  };
  const assert = () => { if (disposed || signal.aborted) throw new ZerosDevError("deadline"); };
  signal.addEventListener("abort", dispose, { once: true });
  const skip = (phase: SdkPhase, reason: SkipReason) => options.evidence.emit({ phase, outcome: "skipped", durationMs: 0, sdk: { probeId, skip: reason } });
  const observe = async <T>(phase: SdkPhase, work: () => Promise<T>): Promise<{ value: T } | undefined> => {
    const started = clock();
    try {
      assert(); const value = await beforeDeadline(work(), signal); assert();
      options.evidence.emit({ phase, outcome: "ok", durationMs: Math.max(0, clock() - started), sdk: { probeId,
        ...(phase === "sdk_runtime_ready" ? { route: "direct" as const } : {}),
        ...(phase === "sdk_device_stream_ready" ? { organizationCoverage: "enabled" as const } : {}) } });
      return { value };
    } catch (error) {
      if (error instanceof Skip && !signal.aborted && !disposed) {
        options.evidence.emit({ phase, outcome: "skipped", durationMs: Math.max(0, clock() - started), sdk: { probeId, skip: error.reason } });
        return undefined;
      }
      const closed = signal.aborted ? new ZerosDevError("deadline") : failure(error);
      options.evidence.emit({ phase, outcome: "failed", durationMs: Math.max(0, clock() - started), code: closed.code, sdk: { probeId } });
      throw closed;
    }
  };
  try {
    const opened = await observe("sdk_device_session", async () => {
      if (!run.hourly?.infrastructure || run.cleanupOnly || run.cleanupRecovery || run.deletionConfirmed) throw new ZerosDevError("forbidden");
      const row = await api.workspace(run, signal); assert();
      if (!["ready", "busy"].includes(row.status)) throw new ZerosDevError("workspace_not_running");
      const fixture = await session.fixture(); assert();
      const credential = await session.device(); assert();
      const account = session.accountSessionKey();
      if (!account || credential.accountUserId !== fixture.accountId || credential.deviceId !== run.deviceId ||
          row.id !== run.create?.result?.id || row.organizationId !== fixture.organizationId ||
          row.generation.number !== run.create.result.generation) throw new ZerosDevError("identity_changed");
      const checkDevice = async (token?: string) => {
        assert();
        if (token !== undefined && await session.accessToken() !== token) throw new ZerosDevError("identity_changed");
        assert(); const current = await session.device(); assert();
        if (session.accountSessionKey() !== account || current.accountUserId !== credential.accountUserId ||
            current.deviceId !== credential.deviceId || current.keyVersion !== credential.keyVersion || current.publicKey !== credential.publicKey)
          throw new ZerosDevError("identity_changed");
        return current;
      };
      const environment: RuntimeClientEnvironment = options.environment ?? {
        controlPlaneOrigin: ALPHA_ORIGIN, allowHttpLoopback: false,
        createWebSocket: (url, protocols) => new WebSocket(url, protocols, { maxPayload: 4 * 1024 * 1024, followRedirects: false, handshakeTimeout: 10_000 }) as never,
        resolveEnginePort: async () => { throw new ZerosDevError("forbidden"); },
        resolveEngineToken: async () => { throw new ZerosDevError("forbidden"); },
        invalidateEnginePort() {}, invalidateEngineToken() {},
        getAuthAccessToken: () => { throw new ZerosDevError("forbidden"); }, logger: { warn() {}, error() {} },
      };
      broker = new CloudSdkRuntimeBroker({ baseUrl: environment.controlPlaneOrigin, allowInsecureLoopback: environment.allowHttpLoopback,
        appVersion: "zeros-dev", platform: "linux", enabled: () => !disposed, getAccountSessionKey: () => session.accountSessionKey(),
        getAccessToken: async () => { assert(); const token = await session.accessToken(); assert(); return token; },
        ensureDevice: () => checkDevice(), readDevice: () => ({ deviceId: credential.deviceId!, keyVersion: credential.keyVersion }),
        signRequest: async (token, request) => {
          const parsed = CloudSdkDeviceRequestSchema.safeParse(request);
          if (!parsed.success) throw new ZerosDevError("invalid_request");
          const current = await checkDevice(token);
          return new CloudReplicaDeviceSigner(current).proof(parsed.data.action, parsed.data.payload);
        },
        signProof: async (token, device, fields) => {
          const parsed = CloudSdkCapabilityProofFieldsSchema.safeParse(fields), current = await checkDevice(token);
          if (!parsed.success || device.deviceId !== current.deviceId || device.keyVersion !== current.keyVersion ||
              Math.abs(parsed.data.timestampMs - Date.now()) > CAPABILITY_POP_TIMESTAMP_LEEWAY_MS) throw new ZerosDevError("identity_changed");
          const key = createPrivateKey({ format: "jwk", key: { kty: "OKP", crv: "Ed25519", x: current.publicKey, d: current.privateKey } });
          return sign(null, Buffer.from(capabilityProofMessage(parsed.data)), key).toString("base64url");
        },
        // An eligible accepted-work descriptor still activates its native
        // attempt, but this read-only probe cannot sign or send a command.
        signAcceptedWorkProof: async () => { throw new ZerosDevError("forbidden"); },
        fetch: options.fetch ?? api.transport.fetchImpl, onRetired: () => client?.dispose(),
      });
      let grant: DeviceSessionGrant;
      try { grant = await broker.openStreamSession(null); }
      catch (error) {
        if (probeFromConnectFailure(error) === "legacy") {
          // Negative discovery belongs to the same file-backed identity and
          // probe lifetime as a successful session response.
          await checkDevice(); assert();
          throw new Skip("legacy_discovery");
        }
        throw error;
      }
      await checkDevice(); assert();
      return { grant, row, fixture, checkDevice, environment };
    });
    if (!opened) {
      for (const phase of ["sdk_runtime_connect", "sdk_runtime_ready", "sdk_device_stream_ready"] as const) skip(phase, "session_unavailable");
      return;
    }
    const { grant, row, fixture, checkDevice, environment } = opened.value, native = broker!;
    const target = { organizationId: fixture.organizationId, workspaceId: row.id };
    try {
      await observe("sdk_device_stream_ready", async () => {
        const skipped = await new Promise<Skip | undefined>((resolve, reject) => {
          let settled = false, consumed = false;
          const finish = (error?: unknown) => {
            if (settled || disposed || signal.aborted) return;
            settled = true;
            if (error instanceof Skip) resolve(error); else if (error) reject(error); else resolve(undefined);
          };
          const createSocket: DeviceStreamSocketFactory = options.createStreamSocket ?? ((url, handlers) => {
            const peer = new WebSocket(url, { maxPayload: 512 * 1024, followRedirects: false, handshakeTimeout: 10_000 });
            peer.on("open", () => handlers.open()); peer.on("close", code => handlers.close(code, "stream_closed"));
            peer.on("error", () => {});
            peer.on("message", (data, binary) => { if (binary) peer.close(4400, "invalid_frame"); else handlers.message(data.toString()); });
            closeSockets.push(() => peer.terminate());
            return { send: text => peer.send(text), close: (code, reason) => {
              if (peer.readyState === WebSocket.CONNECTING) peer.terminate(); else peer.close(code, reason);
            } };
          });
          stream = new CloudSdkDeviceStream({ broker: {
            assertActive: () => native.assertActive(), runtimeTargets: () => native.runtimeTargets(),
            subscribeRuntimeTargets: listener => native.subscribeRuntimeTargets(listener), assertRuntime: input => native.assertRuntime(input),
            acceptPushedCapabilities: (...args) => native.acceptPushedCapabilities(...args), close: id => native.close(id),
            openStreamSession: async () => {
              assert(); native.assertActive();
              if (consumed) throw new ZerosDevError("runtime_unavailable");
              consumed = true; return grant; // The native ticket is consumed exactly once.
            },
          }, onReady: organizations => {
            const organization = organizations?.find(entry => entry.organizationId === fixture.organizationId);
            finish(!organization ? new ZerosDevError("bad_response") : !organization.deviceStream ? new Skip("organization_disabled") : undefined);
          }, emit: event => {
            if (event.state === "stopped" || event.state === "waiting") finish(new ZerosDevError("runtime_unavailable"));
          }, createSocket: (url, handlers) => {
            assert(); const peer = createSocket(url, { ...handlers, close: (code, reason) => {
              if (code === 4404) finish(new Skip("stream_disabled"));
              else finish(new ZerosDevError(code === 4401 || code === 4403 ? "auth_denied" : "runtime_unavailable"));
              handlers.close(code, reason);
            } });
            closeSockets.push(() => peer.close(1000, "probe_complete")); return peer;
          } });
          stream.control({ action: "start", target });
        });
        await checkDevice(); native.assertActive();
        if (skipped) throw skipped;
      });
    } finally { stream?.dispose(); }
    const admitted = await observe("sdk_runtime_connect", async () => {
      const runtime = await native.open(target); await checkDevice(); assert();
      if (!runtime) throw new Skip("legacy_discovery");
      if (runtime.generation !== row.generation.number || runtime.organizationId !== target.organizationId ||
          runtime.workspaceId !== target.workspaceId || runtime.deviceSessionId !== grant.deviceSessionId) throw new ZerosDevError("runtime_changed");
      return runtime;
    });
    if (!admitted) { skip("sdk_runtime_ready", "runtime_legacy"); return; }
    await observe("sdk_runtime_ready", async () => {
      const runtime = admitted.value;
      const authority: CloudSdkSocketAuthority = {
        signProof: (value, fields) => native.signCapabilityProof({ runtime: cloudSdkRuntimeIdentity(value), fields }),
        renewCapabilities: value => native.renewCapabilities(cloudSdkRuntimeIdentity(value)),
        activateConnection: async (value, handshakeNonce) => {
          const result = native.controlConnection({ action: "activate", runtime: cloudSdkRuntimeIdentity(value), handshakeNonce });
          if (typeof result === "boolean") throw new ZerosDevError("bad_response"); return result;
        },
        retireConnection: async (value, attemptId) => native.controlConnection({ action: "retire", runtime: cloudSdkRuntimeIdentity(value), attemptId }) === true,
        cancelCommand: async (value, attemptId, requestId) => native.controlConnection({ action: "cancel", runtime: cloudSdkRuntimeIdentity(value), attemptId, requestId }) === true,
        prepareCommand: async () => { throw new ZerosDevError("forbidden"); },
        subscribeRenewals: async () => () => {}, // This probe does not claim pushed-renewal coverage.
      };
      client = new RuntimeClient(runtime, { environment: { ...environment, createWebSocket: (url, protocols) => {
        assert(); const peer = environment.createWebSocket(url, protocols);
        closeSockets.push(() => { if (peer instanceof WebSocket) peer.terminate(); else peer.close(1000, "probe_complete"); }); return peer;
      } }, createCloudSdkSocket: (value, createSocket) => {
        if (socket) throw new ZerosDevError("runtime_unavailable"); // One attempt; never repair a failed probe into a pass.
        socket = new CloudSdkSocket(value, createSocket, async () => { throw new ZerosDevError("runtime_unavailable"); }, authority); return socket;
      }, refreshCloudConnectionTarget: async () => { throw new ZerosDevError("runtime_unavailable"); } });
      await client.connect(); await client.waitUntilReady({ signal }); assert();
      if (socket?.route !== "direct") throw new ZerosDevError("runtime_unavailable");
      native.assertRuntime(runtime); await checkDevice();
      const current = await api.workspace(run, signal); assert();
      await checkDevice(); native.assertRuntime(runtime); assert();
      if (current.id !== row.id || current.organizationId !== fixture.organizationId || current.generation.number !== runtime.generation ||
          !["ready", "busy"].includes(current.status) || client.status !== "connected") throw new ZerosDevError("runtime_changed");
    });
  } finally {
    signal.removeEventListener("abort", dispose); clearTimeout(timer); dispose();
  }
}
