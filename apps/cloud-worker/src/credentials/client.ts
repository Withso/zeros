import { connect } from "node:net";
import { spawn } from "node:child_process";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { githubEnvironment } from "./github";

const unavailable = () => new Error("GitHub authentication is unavailable.");
export function brokerRequest(socketPath: string, kind: "token" | "user-token" | "changed"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!socketPath || !socketPath.startsWith("/")) { reject(unavailable()); return; }
    const socket = connect(socketPath); let buffer = "", settled = false;
    const finish = (result?: Record<string, unknown>) => { if (settled) return; settled = true; socket.destroy(); if (result) resolve(result); else reject(unavailable()); };
    socket.setTimeout(20_000, () => finish()); socket.setEncoding("utf8");
    socket.once("error", () => finish()); socket.once("close", () => finish());
    socket.once("connect", () => socket.write(JSON.stringify({ kind }) + "\n"));
    socket.on("data", (data: string) => {
      buffer += data; if (Buffer.byteLength(buffer) > 16_384) { finish(); return; }
      if (!buffer.includes("\n")) return;
      try {
        const result: unknown = JSON.parse(buffer.trim());
        if (!result || typeof result !== "object" || "error" in result) { finish(); return; }
        finish(result as Record<string, unknown>);
      } catch { finish(); }
    });
  });
}

async function token(socketPath: string, kind: "token" | "user-token" = "token"): Promise<string> {
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

type GhExecution = (args: string[], environment: NodeJS.ProcessEnv) => Promise<number>;
const executeGh: GhExecution = (args, env) => new Promise(resolve => {
  const child = spawn("/usr/bin/gh", args, { env, stdio: "inherit" });
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const cleanup = () => { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); };
  child.once("error", () => { cleanup(); resolve(1); });
  child.once("exit", (code, signal) => { cleanup(); resolve(code ?? (signal === "SIGINT" ? 130 : 1)); });
});

/** gh gets its token only for this process; the agent parent inherits broker
 * wiring, and no auth login/store command is used. Mutations are never retried. */
export async function runGh(args: string[], source: NodeJS.ProcessEnv = process.env, execute: GhExecution = executeGh): Promise<number> {
  const socketPath = source.GH_ZEROS_BROKER_SOCKET ?? "";
  const login = await token(socketPath, "user-token");
  const wiring = githubEnvironment(socketPath, source.GIT_ASKPASS ?? "/opt/zeros/worker/bin/git-askpass");
  const env = { ...workerChildEnvironment(source, wiring), GH_TOKEN: login, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" };
  const code = await execute(args, env);
  const pr = args.indexOf("pr"), api = args.indexOf("api");
  const mutation = (pr >= 0 && ["create", "edit", "ready", "merge", "close", "reopen", "review", "comment"].includes(args[pr + 1])) || (api >= 0 && args.some(arg => /^(POST|PATCH|PUT|DELETE)$/.test(arg)));
  if (code === 0 && mutation) await brokerRequest(socketPath, "changed").catch(() => {});
  return code;
}
