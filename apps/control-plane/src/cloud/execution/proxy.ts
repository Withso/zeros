import { HttpError } from "../../authz.js";
import type { CloudExecutionContexts } from "./store.js";
import type { OpenAiModelAvailability } from "../model-availability.js";

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
    await access.check();
    const responseHeaders = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"].includes(name.toLowerCase())) responseHeaders.set(name, value);
    });
    if (!upstream.body) { release(); return new Response(null, { status: upstream.status, headers: responseHeaders }); }
    const reader = upstream.body.getReader();
    let closed = false, timer: NodeJS.Timeout | undefined;
    const close = () => { closed = true; clearTimeout(timer); release(); };
    const stream = new ReadableStream<Uint8Array>({
      start(output) {
        const verify = async () => {
          try {
            const expiresAt = await access.check();
            if (!closed) timer = setTimeout(() => { void verify(); }, Math.max(1, Math.min(5000, expiresAt - Date.now())));
            timer?.unref();
          } catch { if (!closed) { close(); controller.abort(); void reader.cancel().catch(() => {}); output.error(new Error("Execution authorization ended")); } }
        };
        void verify();
      },
      async pull(output) {
        try {
          const value = await reader.read();
          if (closed) return;
          await access.check();
          if (closed) return;
          if (value.done) { close(); output.close(); } else output.enqueue(value.value);
        } catch { if (!closed) { close(); controller.abort(); void reader.cancel().catch(() => {}); output.error(new Error("Execution authorization ended")); } }
      },
      async cancel() { close(); controller.abort(); await reader.cancel().catch(() => {}); },
    });
    return new Response(stream, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    release(); controller.abort(); await upstream?.body?.cancel().catch(() => {});
    return rejected(error);
  }
}
