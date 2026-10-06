import net from "node:net";
import { z } from "zod";
import {
  RESIDENT_FRAME_BYTES, RESIDENT_MAX_SESSIONS, RESIDENT_PTY_PROTOCOL,
  ResidentPtyError, ResidentPtyFrameSchema, ResidentPtySessionSchema, ResidentPtySnapshotSchema,
  type ResidentEngineAuthority, type ResidentPtyCreate, type ResidentPtyFrame,
  type ResidentPtyInput, type ResidentPtyRequest,
} from "./resident-protocol";

type Request = ResidentPtyRequest extends infer R ? R extends { id: number } ? Omit<R, "id"> : never : never;

/** Cloud engine adapter. Disconnect retires this route, never the resident
 * sessions. Callers reconnect with fresh supervisor-issued authority. */
export class ResidentPtyClient {
  private socket: net.Socket | null = null;
  private nextId = 1;
  private ready = false;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void; reject(error: ResidentPtyError): void; timer: ReturnType<typeof setTimeout>;
  }>();
  private onEvent: ((event: Exclude<ResidentPtyFrame, { kind: "reply" | "error" }>) => void) | null = null;

  constructor(private readonly options: { socketPath: string; authority: ResidentEngineAuthority }) {}

  events(listener: typeof this.onEvent): void { this.onEvent = listener; }

  async connect(): Promise<void> {
    if (this.socket) throw new ResidentPtyError("host_unavailable");
    const socket = net.createConnection(this.options.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    const unavailable = () => { if (this.socket === socket) this.disconnect(); };
    socket.on("error", unavailable);
    socket.on("close", unavailable);
    socket.on("data", (chunk: string) => {
      if (this.socket !== socket) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > RESIDENT_FRAME_BYTES) { unavailable(); return; }
      for (let end; (end = buffer.indexOf("\n")) !== -1;) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = ResidentPtyFrameSchema.parse(JSON.parse(line));
          if (frame.kind === "reply" || frame.kind === "error") {
            const request = this.pending.get(frame.id);
            if (!request) continue;
            this.pending.delete(frame.id); clearTimeout(request.timer);
            if (frame.kind === "error") request.reject(new ResidentPtyError(frame.code));
            else request.resolve(frame.result);
          } else if (this.ready) this.onEvent?.(frame);
        } catch { unavailable(); return; }
      }
    });
    try {
      const result = await this.request({ op: "attach", protocol: RESIDENT_PTY_PROTOCOL, authority: this.options.authority }, true);
      if (result !== true || this.socket !== socket) throw new ResidentPtyError("authority_rejected");
      this.ready = true;
    } catch (error) { unavailable(); throw error; }
  }

  private request(request: Request, attaching = false): Promise<unknown> {
    const socket = this.socket;
    if (!socket || (!attaching && !this.ready) || socket.destroyed || this.pending.size >= 32)
      return Promise.reject(new ResidentPtyError("host_unavailable"));
    const id = this.nextId++;
    const line = JSON.stringify({ ...request, id }) + "\n";
    if (Buffer.byteLength(line) > RESIDENT_FRAME_BYTES) return Promise.reject(new ResidentPtyError("request_rejected"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new ResidentPtyError("host_unavailable"));
        this.disconnect();
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(line, error => { if (error && this.socket === socket) this.disconnect(); });
    });
  }

  async list() { return z.array(ResidentPtySessionSchema).max(RESIDENT_MAX_SESSIONS).parse(await this.request({ op: "list" })); }
  async create(launch: ResidentPtyCreate) { return ResidentPtySessionSchema.parse(await this.request({ op: "create", launch })); }
  async snapshot(sessionId: string) { return ResidentPtySnapshotSchema.parse(await this.request({ op: "snapshot", sessionId })); }
  async write(sessionId: string, input: ResidentPtyInput) {
    return z.enum(["applied", "duplicate"]).parse(await this.request({ op: "write", sessionId, input }));
  }
  async cursor(sessionId: string, producerId: string) {
    return z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(await this.request({ op: "cursor", sessionId, producerId }));
  }
  async resize(sessionId: string, cols: number, rows: number) { z.literal(true).parse(await this.request({ op: "resize", sessionId, cols, rows })); }
  async close(sessionId: string) { z.literal(true).parse(await this.request({ op: "close", sessionId })); }

  disconnect(): void {
    const socket = this.socket; this.socket = null; this.ready = false;
    socket?.destroy();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new ResidentPtyError("host_unavailable"));
    }
    this.pending.clear();
  }
}
