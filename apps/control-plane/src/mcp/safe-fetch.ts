import { lookup as resolve } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable, Transform } from "node:stream";

const blocked = new BlockList();
for (const [network, prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],
  ["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],
  ["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["2001::",32],["2001:db8::",32],["2002::",16]] as const) blocked.addSubnet(network, prefix, "ipv6");
const publicV6 = new BlockList(); publicV6.addSubnet("2000::", 3, "ipv6");
export function mcpPublicAddress(value: string): boolean {
  const address = value.replace(/^\[|\]$/g, ""), family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && publicV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
const refused = () => new Error("MCP requires a public HTTPS endpoint");
export function mcpPublicUrl(input: string | URL): URL {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.hostname === "localhost" ||
    (isIP(host) && !mcpPublicAddress(host))) throw refused();
  return url;
}
interface FetchOptions {
  lookup?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: typeof httpsRequest;
}
export function withMcpSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(new Error("MCP request cancelled or timed out")); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("MCP request cancelled or timed out"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
async function payloadBytes(request: Request, signal: AbortSignal): Promise<Buffer | undefined> {
  if (!request.body || ["GET", "HEAD"].includes(request.method)) return;
  const reader = request.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await withMcpSignal(reader.read(), signal); if (part.done) break;
      size += part.value.byteLength;
      if (size > 1_000_000) throw new Error("MCP request too large");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Uses the validated DNS answer for the actual socket. No resolve/check/fetch
 * hostname race, ambient proxy, credential redirect, or unbounded body buffer. */
export async function safeMcpFetch(input: string | URL | Request, init: RequestInit = {}, options: FetchOptions = {}): Promise<Response> {
  const incoming = new Request(input, init), signal = AbortSignal.any([incoming.signal, AbortSignal.timeout(15_000)]);
  let url = mcpPublicUrl(incoming.url), headers = new Headers(incoming.headers);
  const payload = await payloadBytes(incoming, signal);
  for (let hop = 0; hop < 4; hop++) {
    signal.throwIfAborted();
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const answers = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
      : await withMcpSignal((options.lookup ?? (host => resolve(host, { all: true, verbatim: true })))(hostname), signal);
    if (!answers.length || answers.some(answer => !mcpPublicAddress(answer.address))) throw refused();
    signal.throwIfAborted();
    const address = answers[0]!;
    const response = await new Promise<Response>((yes, no) => {
      const req = (options.request ?? httpsRequest)(url, {
        method: incoming.method, headers: Object.fromEntries(headers), signal, agent: false,
        // TLS still authenticates the original host; lookup pins the IP.
        lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) =>
          lookupOptions.all ? callback(null, [address]) : callback(null, address.address, address.family)) as never,
      }, res => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        let bytes = 0;
        const limit = new Transform({ transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (bytes > 2_000_000) { done(new Error("MCP response too large")); req.destroy(); }
          else done(null, chunk);
        } });
        res.on("error", error => limit.destroy(error));
        // Cancelling a Web response closes its Transform. Also retire the
        // incoming socket; pipe() alone does not propagate cancellation back.
        limit.once("close", () => { res.destroy(); req.destroy(); });
        const status = res.statusCode ?? 502;
        const noBody = incoming.method === "HEAD" || [204,205,304].includes(status);
        if (noBody) res.resume();
        else res.pipe(limit);
        try { yes(new Response(noBody ? null : Readable.toWeb(limit) as ReadableStream<Uint8Array>, { status, headers: responseHeaders })); }
        catch { res.destroy(); req.destroy(); no(new Error("Invalid MCP response")); }
      });
      req.on("error", no);
      req.setTimeout(15_000, () => req.destroy(new Error("MCP request timed out")));
      req.end(payload);
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) return response;
    await response.body?.cancel();
    if (!["GET", "HEAD"].includes(incoming.method)) throw new Error("MCP credential redirects are not allowed");
    url = mcpPublicUrl(new URL(location, url));
    // Discovery may redirect, but none of the original credentials follow it.
    headers = new Headers({ Accept: incoming.headers.get("accept") ?? "application/json" });
  }
  throw new Error("MCP discovery redirected too many times");
}
