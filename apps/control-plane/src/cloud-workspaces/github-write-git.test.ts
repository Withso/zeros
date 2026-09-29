import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { createCloudGithubProxyRoutes, CLOUD_GITHUB_PROXY_PATH } from "./github-write-proxy.js";
import type { DatabaseCloudGithubWriteGrants, GithubProxyAuthority } from "./github-write-grants.js";
const execFile = promisify(execFileCallback);

it.each([[1, false], [1048576, false], [1, true], [1048576, true]] as const)("forwards a real Git push with postBuffer=%i and shallow=%s through the policy and HTTP boundary", async (postBuffer, shallow) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-github-policy-"));
  const repo = path.join(root, "work"), bare = path.join(root, "repo.git");
  const upstream = createServer((request, response) => {
    const url = new URL(request.url!, "http://localhost");
    const child = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname,
      REQUEST_METHOD: request.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: request.headers["content-type"] ?? "", REMOTE_USER: "test" }, stdio: ["pipe", "pipe", "ignore"] });
    request.pipe(child.stdin); let head = Buffer.alloc(0), sent = false;
    child.stdout.on("data", (part: Buffer) => {
      if (sent) { response.write(part); return; }
      head = Buffer.concat([head, part]); const end = head.indexOf("\r\n\r\n"); if (end < 0) return;
      const headers: Record<string, string> = {}; let status = 200;
      for (const line of head.subarray(0, end).toString().split("\r\n")) { const i = line.indexOf(":"); const key = line.slice(0, i).toLowerCase(), value = line.slice(i + 1).trim(); if (key === "status") status = Number(value.split(" ")[0]); else headers[key] = value; }
      sent = true; response.writeHead(status, headers); response.write(head.subarray(end + 4));
    });
    child.on("close", () => response.end()); child.on("error", () => { response.writeHead(500); response.end(); });
  });
  const scope: GithubProxyAuthority = { owner: "org", repository: "repo", repositoryId: "123", operation: "git.push", prNumber: null,
    userToken: "synthetic-user-token", expiresAtMs: Date.now() + 30000, expectedBody: null, gitReference: "refs/heads/test" };
  let writes = 0;
  const service = { authorizeProxy: async (_proxy: string, write: string | null = null) => { if (write) writes++; return scope; } } as unknown as DatabaseCloudGithubWriteGrants;
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const app = createCloudGithubProxyRoutes(service, async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") return Response.json({ id: 123 });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("x-access-token:synthetic-user-token").toString("base64")}`);
    return fetch(`http://127.0.0.1:${upstreamPort}${url.pathname.replace("/org/", "/")}${url.search}`, init);
  });
  const proxy = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!proxy.listening) await new Promise<void>(resolve => proxy.once("listening", resolve));
  const port = (proxy.address() as { port: number }).port;
  try {
    await execFile("git", ["init", "--bare", bare]); await execFile("git", ["-C", bare, "config", "http.receivepack", "true"]);
    await execFile("git", ["-C", bare, "config", "receive.advertisePushOptions", "true"]);
    await execFile("git", ["init", "-b", "test", repo]); await writeFile(path.join(repo, "test.txt"), "test\n");
    await execFile("git", ["-C", repo, "add", "test.txt"]); await execFile("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "test"]);
    // A real depth-limited checkout advertises shallow boundaries before its
    // branch update, including when it needs no new pack objects on GitHub.
    if (shallow) {
      await execFile("git", ["-C", repo, "push", bare, "test:base"]);
      await execFile("git", ["clone", "--depth=1", "--branch=base", `file://${bare}`, `${repo}-shallow`]);
      await execFile("git", ["-C", `${repo}-shallow`, "checkout", "-b", "test"]);
    }
    const checkout = shallow ? `${repo}-shallow` : repo;
    const authorization = Buffer.from(`x-access-token:zgp_${"p".repeat(43)}`).toString("base64");
    await execFile("git", ["-C", checkout, "-c", `http.extraHeader=Authorization: Basic ${authorization}`, "-c", `http.postBuffer=${postBuffer}`, "push", `http://127.0.0.1:${port}${CLOUD_GITHUB_PROXY_PATH}/git/org/repo.git`, "test"], { timeout: 15000 });
    expect(writes).toBe(1);
    expect((await execFile("git", ["-C", bare, "rev-parse", "refs/heads/test"])).stdout).toBe((await execFile("git", ["-C", repo, "rev-parse", "HEAD"])).stdout);
  } finally {
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 25000);
