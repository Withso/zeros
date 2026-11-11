import type { z } from "zod";
import {
  LOCAL_COMMAND_DEVICE_HEADERS, LocalCommandConnectReplySchema, LocalCommandDisconnectReplySchema, LocalCommandEventSchemas,
  LocalCommandNoticeSchema, LocalCommandPresenceSchema, LocalCommandRegistrationReplySchema, LocalCommandResultReplySchema, WorkspaceSyncFlagReplySchema,
  type LocalCommandDevice, type LocalCommandMacResult,
} from "@zeros/protocol/local-commands";
import { SyncGrantReplySchema } from "@zeros/protocol/workspace-sync";

/** A control-plane refusal or an unusable reply. Never carries a body beyond its closed code. */
export class DeviceControlError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Local commands: ${code}`); }
}

type EventName = keyof typeof LocalCommandEventSchemas;
export type DeviceEvent = { [K in EventName]: { event: K; data: z.infer<(typeof LocalCommandEventSchemas)[K]> } }[EventName];

const ERROR_BYTES = 8192, REPLY_BYTES = 256 * 1024;

async function bounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new DeviceControlError(response.status, "response_too_large");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

/** The desktop's D and D+H routes of the Order 2 wire. H values bind to this
 * user's WorkOS session; they grant nothing on their own. */
export class DeviceControl {
  constructor(private readonly deps: { fetch: typeof fetch; baseUrl(): string; token(): Promise<string | null> }) {}

  private async send<T>(method: string, path: string, options: { device?: LocalCommandDevice; body?: unknown; schema?: z.ZodType<T>; timeoutMs?: number; accept?: string; signal?: AbortSignal; syncField?: true }): Promise<T> {
    const token = await this.deps.token();
    if (!token) throw new DeviceControlError(401, "unauthorized");
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(options.accept ? { accept: options.accept } : {}) };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    // Order 3: replies carrying a connected-Macs row include `syncing` only when asked.
    if (options.syncField) headers["x-zeros-sync"] = "1";
    if (options.device) Object.assign(headers, {
      [LOCAL_COMMAND_DEVICE_HEADERS.deviceId]: options.device.deviceId,
      [LOCAL_COMMAND_DEVICE_HEADERS.registrationId]: options.device.registrationId,
      [LOCAL_COMMAND_DEVICE_HEADERS.instanceId]: options.device.instanceId,
    });
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
    const response = await this.deps.fetch(`${this.deps.baseUrl()}${path}`, { method, redirect: "error", headers,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    if (!response.ok) {
      let code = "unavailable";
      try { const value = JSON.parse(await bounded(response, ERROR_BYTES)) as { error?: { code?: unknown } }; if (typeof value.error?.code === "string") code = value.error.code.slice(0, 64); }
      catch { /* Only a closed code is kept. */ }
      throw new DeviceControlError(response.status, code);
    }
    if (response.status === 204 || !options.schema) { await response.body?.cancel().catch(() => {}); return undefined as T; }
    let value: unknown;
    try { value = JSON.parse(await bounded(response, REPLY_BYTES)); } catch (error) { if (error instanceof DeviceControlError) throw error; throw new DeviceControlError(response.status, "invalid_response"); }
    const parsed = options.schema.safeParse(value);
    if (!parsed.success) throw new DeviceControlError(response.status, "invalid_response");
    return parsed.data;
  }

  private device(deviceId: string) { return `/v1/cloud-v2/devices/${encodeURIComponent(deviceId)}`; }
  private request(device: LocalCommandDevice, requestId: string, action?: string) {
    return `${this.device(device.deviceId)}/requests/${encodeURIComponent(requestId)}${action ? `/${action}` : ""}`;
  }

  /** One PUT with exactly the capabilities given. A request id is idempotent only for its exact body, so the
   * caller (LocalCommandService) owns the id and the set, and changes them together. */
  register(deviceId: string, input: { requestId: string; name: string; capabilities: readonly string[] }) {
    return this.send("PUT", this.device(deviceId), { body: { requestId: input.requestId, name: input.name, capabilities: [...input.capabilities] }, schema: LocalCommandRegistrationReplySchema });
  }
  unregister(device: LocalCommandDevice) { return this.send<void>("DELETE", this.device(device.deviceId), { device, timeoutMs: 5_000 }); }
  heartbeat(device: LocalCommandDevice) { return this.send("POST", `${this.device(device.deviceId)}/heartbeat`, { device, body: {}, schema: LocalCommandPresenceSchema }); }

  /** The account-level stream; read with parseEventStream. */
  async events(device: LocalCommandDevice, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const token = await this.deps.token();
    if (!token) throw new DeviceControlError(401, "unauthorized");
    const response = await this.deps.fetch(`${this.deps.baseUrl()}${this.device(device.deviceId)}/events`, { method: "GET", redirect: "error", signal,
      headers: { authorization: `Bearer ${token}`, accept: "text/event-stream", [LOCAL_COMMAND_DEVICE_HEADERS.deviceId]: device.deviceId,
        [LOCAL_COMMAND_DEVICE_HEADERS.registrationId]: device.registrationId, [LOCAL_COMMAND_DEVICE_HEADERS.instanceId]: device.instanceId } });
    if (!response.ok || !response.body) {
      let code = "unavailable";
      try { const value = JSON.parse(await bounded(response, ERROR_BYTES)) as { error?: { code?: unknown } }; if (typeof value.error?.code === "string") code = value.error.code.slice(0, 64); } catch { /* closed code only */ }
      throw new DeviceControlError(response.status, code);
    }
    return response.body;
  }

  get(device: LocalCommandDevice, requestId: string) { return this.send("GET", this.request(device, requestId), { device, schema: LocalCommandNoticeSchema }); }
  received(device: LocalCommandDevice, requestId: string) { return this.send("POST", this.request(device, requestId, "received"), { device, body: {}, schema: LocalCommandNoticeSchema }); }
  claim(device: LocalCommandDevice, requestId: string, decision: "approve" | "deny") {
    return this.send("POST", this.request(device, requestId, "claim"), { device, body: { decision }, schema: LocalCommandNoticeSchema });
  }
  result(device: LocalCommandDevice, requestId: string, result: LocalCommandMacResult) {
    return this.send("POST", this.request(device, requestId, "result"), { device, body: { result }, schema: LocalCommandResultReplySchema, timeoutMs: 60_000 });
  }
  ack(device: LocalCommandDevice, requestId: string) { return this.send<void>("POST", this.request(device, requestId, "ack"), { device, body: {} }); }

  connect(device: LocalCommandDevice, workspaceId: string) {
    return this.send("POST", `/v1/cloud-v2/workspaces/${encodeURIComponent(workspaceId)}/macs/${encodeURIComponent(device.deviceId)}/connect`, { device, body: {}, schema: LocalCommandConnectReplySchema , syncField: true });
  }
  /** Order 3: this Mac's syncing flag on its connected-Macs row. The one place the route is named. */
  setSyncing(device: LocalCommandDevice, workspaceId: string, syncing: boolean) {
    return this.send("PUT", `/v1/cloud-v2/workspaces/${encodeURIComponent(workspaceId)}/macs/${encodeURIComponent(device.deviceId)}/sync`, { device, body: { syncing }, schema: WorkspaceSyncFlagReplySchema , syncField: true });
  }
  /** Order 3: a single-use grant for this Mac's direct sync socket (never wakes the VM). */
  syncGrant(device: LocalCommandDevice, workspaceId: string) {
    return this.send("POST", `/v1/cloud-v2/workspaces/${encodeURIComponent(workspaceId)}/sync/grant`, { device, body: {}, schema: SyncGrantReplySchema });
  }
  /** May name another of this person's Macs; H identifies the Mac asking. */
  disconnect(device: LocalCommandDevice, workspaceId: string, targetDeviceId: string) {
    return this.send("POST", `/v1/cloud-v2/workspaces/${encodeURIComponent(workspaceId)}/macs/${encodeURIComponent(targetDeviceId)}/disconnect`, { device, body: {}, schema: LocalCommandDisconnectReplySchema , syncField: true });
  }
}

const MAX_EVENT_CHARS = 512 * 1024;

/** Named events of the device stream. Unknown names, malformed data and
 * comments are skipped; a duplicate notice never authorizes anything. */
export async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<DeviceEvent> {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let buffer = "", name = "", data: string[] = [];
  const dispatch = (): DeviceEvent | undefined => {
    const event = name, text = data.join("\n"); name = ""; data = [];
    if (!(event in LocalCommandEventSchemas)) return undefined;
    try {
      const parsed = LocalCommandEventSchemas[event as EventName].safeParse(JSON.parse(text));
      return parsed.success ? { event, data: parsed.data } as DeviceEvent : undefined;
    } catch { return undefined; }
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > MAX_EVENT_CHARS) throw new DeviceControlError(200, "event_too_large");
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + (buffer[newline] === "\r" ? 2 : 1));
        if (line === "") { const event = dispatch(); if (event) yield event; continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":"), field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
