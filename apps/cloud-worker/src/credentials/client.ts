import { spawn } from "node:child_process";
import { workerChildEnvironment } from "../drivers/shared/agent-environment";
import { githubEnvironment } from "./github";
import { githubAuthenticationMessage } from "./github-failure";
import { askpass, brokerRequest, gitCredential, token } from "./broker";

export { askpass, brokerRequest, gitCredential };

type GhExecution = (args: string[], environment: NodeJS.ProcessEnv) => Promise<number | { code: number; unauthorized: boolean }>;
const executeGh: GhExecution = (args, env) => new Promise(resolve => {
  const child = spawn("/usr/bin/gh", args, { env, stdio: ["inherit", "inherit", "pipe"] });
  let tail = "", unauthorized = false;
  child.stderr!.on("data", (data: Buffer) => {
    process.stderr.write(data);
    tail = (tail + data.toString("utf8")).slice(-4096);
    unauthorized ||= /\bHTTP 401\b/.test(tail);
  });
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
  const cleanup = () => { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate); };
  child.once("error", () => { cleanup(); resolve(1); });
  child.once("close", (code, signal) => { cleanup(); resolve({ code: code ?? (signal === "SIGINT" ? 130 : 1), unauthorized }); });
});

/** gh gets its token only for this process; the agent parent inherits broker
 * wiring, and no auth login/store command is used. Mutations are never retried. */
export async function runGh(args: string[], source: NodeJS.ProcessEnv = process.env, execute: GhExecution = executeGh): Promise<number> {
  const socketPath = source.GH_ZEROS_BROKER_SOCKET ?? "";
  const login = await token(socketPath, "user-token");
  const wiring = githubEnvironment(socketPath, source.GIT_ASKPASS ?? "/opt/zeros/worker/bin/git-askpass");
  const env = { ...workerChildEnvironment(source, wiring), GH_TOKEN: login, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" };
  const result = await execute(args, env), code = typeof result === "number" ? result : result.code;
  if (code !== 0 && typeof result !== "number" && result.unauthorized)
    await brokerRequest(socketPath, "report-failure", { purpose: "gh", rejectedToken: login }).catch(error => { process.stderr.write(githubAuthenticationMessage(error) + "\n"); });
  const pr = args.indexOf("pr"), api = args.indexOf("api");
  const mutation = (pr >= 0 && ["create", "edit", "ready", "merge", "close", "reopen", "review", "comment"].includes(args[pr + 1])) || (api >= 0 && args.some(arg => /^(POST|PATCH|PUT|DELETE)$/.test(arg)));
  if (code === 0 && mutation) await brokerRequest(socketPath, "changed").catch(() => {});
  return code;
}

