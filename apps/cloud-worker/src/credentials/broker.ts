// The Git credential and askpass helpers run on every Git network command.
// They import only this socket client, so each starts without the worker's
// larger agent and environment modules.
import { connect, type Socket } from "node:net";
import { githubAuthenticationError, GITHUB_SOCKET_TIMEOUT_MS, type GithubAuthenticationError } from "./github-failure";

const unavailable = () => githubAuthenticationError();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Team sharing: the execution context this helper runs in (inherited from its agent or terminal), if any. */
export const executionContext = (source: NodeJS.ProcessEnv = process.env): string | undefined => {
  const value = source.ZEROS_EXECUTION_CONTEXT;
  return value && UUID.test(value) ? value : undefined;
};
export function brokerRequest(socketPath: string, kind: "token" | "user-token" | "changed" | "report-failure",
  failure?: { purpose: "git" | "gh"; rejectedToken: string }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const validatedPath = /^\/tmp\/zeros-github-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/github\.sock$/.exec(socketPath)?.[0];
    // A JavaScript end anchor can match before a final newline.
    if (!validatedPath || validatedPath !== socketPath) { reject(unavailable()); return; }
    let socket: Socket | undefined, settled = false, retried = false, retry: ReturnType<typeof setTimeout> | undefined;
    const finish = (result?: Record<string, unknown>, error?: GithubAuthenticationError) => {
      if (settled) return;
      settled = true; clearTimeout(deadline); clearTimeout(retry); socket?.destroy();
      if (result) resolve(result); else reject(error ?? unavailable());
    };
    const deadline = setTimeout(() => finish(), GITHUB_SOCKET_TIMEOUT_MS);
    const dial = () => {
      if (settled) return;
      let attempt: Socket;
      try { attempt = socket = connect(validatedPath); } catch { finish(); return; }
      let buffer = "", connected = false;
      attempt.setEncoding("utf8");
      attempt.once("error", (error: NodeJS.ErrnoException) => {
        if (settled || socket !== attempt) return;
        if (!connected && !retried && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
          retried = true; socket = undefined; attempt.destroy(); retry = setTimeout(dial, 250);
        } else finish();
      });
      attempt.once("close", () => { if (socket === attempt) finish(); });
      attempt.once("connect", () => {
        if (settled || socket !== attempt) return;
        const contextId = executionContext();
        connected = true; attempt.write(JSON.stringify({ kind, ...failure, ...(contextId ? { contextId } : {}) }) + "\n");
      });
      attempt.on("data", (data: string) => {
        if (settled || socket !== attempt) return;
        buffer += data; if (Buffer.byteLength(buffer) > 16_384) { finish(); return; }
        if (!buffer.includes("\n")) return;
        try {
          const result: unknown = JSON.parse(buffer.trim());
          if (!result || typeof result !== "object") { finish(); return; }
          if ("error" in result) { finish(undefined, githubAuthenticationError(result.error)); return; }
          finish(result as Record<string, unknown>);
        } catch { finish(); }
      });
    };
    dial();
  });
}

export async function token(socketPath: string, kind: "token" | "user-token" = "token"): Promise<string> {
  const result = await brokerRequest(socketPath, kind);
  if (typeof result.token !== "string" || !result.token || result.token.length > 8192 || /[\0\r\n]/.test(result.token) || typeof result.expiresAt !== "number" || result.expiresAt <= Date.now()) throw unavailable();
  return result.token;
}

export async function askpass(prompt: string, socketPath: string): Promise<string> {
  const match = /^(Username|Password) for '([^']+)':\s*$/.exec(prompt);
  if (!match) throw unavailable();
  const url = new URL(match[2]);
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.password) throw unavailable();
  return match[1] === "Username" ? "x-access-token" : token(socketPath);
}

export async function gitCredential(operation: string, input: string, socketPath: string): Promise<string> {
  if (Buffer.byteLength(input) > 16_384 || /\0/.test(input)) throw unavailable();
  const fields = new Map<string, string>();
  for (const line of input.split("\n")) {
    if (!line) break;
    const equals = line.indexOf("=");
    if (equals < 1) throw unavailable();
    const name = line.slice(0, equals);
    if (name.endsWith("[]")) continue;
    if (fields.has(name)) throw unavailable();
    fields.set(name, line.slice(equals + 1));
  }
  if (fields.get("protocol") !== "https" || fields.get("host") !== "github.com") return "";
  if (operation === "get") return `username=x-access-token\npassword=${await token(socketPath)}\n\n`;
  if (operation === "erase") {
    const rejected = fields.get("password");
    if (rejected) await brokerRequest(socketPath, "report-failure", { purpose: "git", rejectedToken: rejected });
  } else if (operation !== "store") throw unavailable();
  return "";
}
