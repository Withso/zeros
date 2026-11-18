import { HttpError } from "../../authz.js";
import type { CloudExecutionContexts } from "./store.js";
import type { OpenAiModelAvailability } from "../model-availability.js";

const PROXY_CHUNKS_PER_CHECK = 256;

const rejected = (error: unknown) => Response.json({ error: { type: "zeros_proxy_error",
  code: error instanceof HttpError && error.status < 500 ? "proxy_token_invalid" : "agent_credentials_unavailable",
  message: error instanceof HttpError && error.status < 500 ? "Execution credential expired or was revoked" : "Execution credentials are temporarily unavailable" } },
{ status: error instanceof HttpError && error.status < 500 ? 401 : 503 });

/** Every upstream boundary is fenced against the token's pinned context. A
 * renew may extend that context, never replace the person or selected login. */
export async function proxyExecution(input: { execution: CloudExecutionContexts; token: string; request: Request; rest: string;
  headers: Headers; fetch: typeof fetch; models: OpenAiModelAvailability }): Promise<Response> {
  const { execution, token, request, rest, headers } = input;
  const controller = new AbortController();
  const aborted = () => controller.abort();
  request.signal.addEventListener("abort", aborted, { once: true });
  if (request.signal.aborted) controller.abort();
  let upstream: Response | undefined;
  const release = () => request.signal.removeEventListener("abort", aborted);
  try {
    const access = await execution.proxyAccess(token);
    const login = access.login;
    if (rest === "/model-availability") {
      if (request.method !== "GET") { release(); return new Response(null, { status: 405, headers: { allow: "GET" } }); }
      const models = login.kind === "codex-api-key" ? await input.models.read(login.apiKey) : null;
      await access.check(); release();
      return Response.json({ models }, { headers: { "cache-control": "no-store" } });
    }
    let target: string;
    if (login.kind === "codex-api-key") { target = `https://api.openai.com/v1${rest}`; headers.set("authorization", `Bearer ${login.apiKey}`); }
    else if (login.kind === "codex-chatgpt") {
      target = `https://chatgpt.com/backend-api/codex${rest}`;
      headers.set("authorization", `Bearer ${login.accessToken}`); headers.set("chatgpt-account-id", login.accountId);
    } else throw new HttpError(401, "agent_login_required", "Connect your Codex account");
    await access.check();
    upstream = await input.fetch(target + new URL(request.url).search, { method: request.method, headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body, duplex: "half" }),
      redirect: "manual", signal: controller.signal } as RequestInit);
    const checkedExpiry = await access.check();
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"].includes(name.toLowerCase())) responseHeaders.set(name, value);
    });
    if (!upstream.body) { release(); return new Response(null, { status: upstream.status, headers: responseHeaders }); }
    const reader = upstream.body.getReader();
    let closed = false, timer: NodeJS.Timeout | undefined;
    const close = () => { closed = true; clearTimeout(timer); release(); };
    const fail = (output: ReadableStreamDefaultController<Uint8Array>) => {
      if (!closed) { close(); controller.abort(); void reader.cancel().catch(() => {}); output.error(new Error("Execution authorization ended")); }
    };
    // A read the last pull left waiting: the next pull takes it, so no chunk is read twice or dropped.
    let waiting: ReturnType<typeof reader.read> | undefined;
    const next = () => (waiting ??= reader.read());
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        // The check after the upstream reply just passed; an idle stream is re-checked from here on.
        const schedule = (expiresAt: number) => {
          if (!closed) timer = setTimeout(() => { void verify(); }, Math.max(1, Math.min(5000, expiresAt - Date.now())));
          timer?.unref();
        };
        const verify = async () => {
          try { schedule(await access.check()); } catch { fail(output); }
        };
        schedule(checkedExpiry);
      },
      async pull(output) {
        try {
          // Every chunk is released only after a check that started once it had arrived. One check covers all the
          // chunks already waiting, instead of one check (about 6 transactions before statements-2) per chunk.
          const batch: Uint8Array[] = [];
          let done = false;
          for (;;) {
            const value = batch.length === 0 ? await next() : await Promise.race([next(), Promise.resolve(undefined)]);
            if (!value) break;
            waiting = undefined;
            if (value.done) { done = true; break; }
            batch.push(value.value);
            if (batch.length >= PROXY_CHUNKS_PER_CHECK) break;
          }
          if (closed) return;
          await access.check();
          if (closed) return;
          for (const chunk of batch) output.enqueue(chunk);
          if (done) { close(); output.close(); }
        } catch { fail(output); }
      },
      async cancel() { close(); controller.abort(); await reader.cancel().catch(() => {}); },
    });
    return new Response(stream, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    release(); controller.abort(); await upstream?.body?.cancel().catch(() => {});
    return rejected(error);
  }
}
