import type { IncomingMessage, ServerResponse } from "node:http";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export class McpRuntimeActivity {
  private pending = 0;
  constructor(private readonly admission?: () => Promise<() => void>) {}
  get busy(): boolean { return this.pending > 0; }

  private async enter(): Promise<() => void> {
    const leave = await this.admission?.();
    this.pending++;
    let active = true;
    return () => { if (active) { active = false; this.pending--; leave?.(); } };
  }

  async run<T>(action: () => Promise<T>): Promise<T> {
    const leave = await this.enter();
    try { return await action(); } finally { leave(); }
  }

  async http(req: IncomingMessage, res: ServerResponse, action: () => Promise<void>): Promise<void> {
    const leave = await this.enter(), original = res.writeHead;
    // The SDK's Node adapter joins the entire GET stream. Only its successful
    // handshake is work; later messages and RPCs have their own admission.
    const headers = new Proxy(original, { apply: (target, receiver, args: unknown[]) => {
      const result = Reflect.apply(target, receiver, args);
      const supplied = args.at(-1);
      const entries: Array<[string, unknown]> = Array.isArray(supplied)
        ? supplied.flatMap((value, index) => index % 2 === 0 ? [[String(value), supplied[index + 1]]] : [])
        : supplied && typeof supplied === "object" ? Object.entries(supplied) : [];
      const contentType = res.getHeader("content-type") ?? entries.find(([name]) => name.toLowerCase() === "content-type")?.[1];
      if (res.statusCode === 200 && /^text\/event-stream(?:\s*;|$)/i.test(String(contentType))) leave();
      return result;
    } });
    if (req.method === "GET") res.writeHead = headers;
    try { await action(); }
    finally { if (res.writeHead === headers) res.writeHead = original; leave(); }
  }

  track(transport: Pick<StreamableHTTPServerTransport, "send">): void {
    const send = transport.send.bind(transport);
    transport.send = (...args) => this.run(() => send(...args));
  }
}
