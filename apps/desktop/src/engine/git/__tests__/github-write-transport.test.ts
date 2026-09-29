import { execFile as execFileCallback, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { prepareGitCredentialInvocation, closeGitCredentialBrokerForTesting } from "../credential-broker";
import { runWithGithubWriteCredential } from "../github-write-context";
const execFile = promisify(execFileCallback);
it("pushes through the scoped proxy using Git's real credential helper without changing the remote", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-github-proxy-test-"));
  const repo = path.join(root, "work"), bare = path.join(root, "repo.git");
  const seen: string[] = [], proxyToken = `zgp_${"p".repeat(43)}`;
  const server = createServer((request, response) => {
    if (!request.headers.authorization) { response.writeHead(401, { "www-authenticate": 'Basic realm="test"' }); response.end(); return; }
    if (request.headers.authorization !== `Basic ${Buffer.from(`x-access-token:${proxyToken}`).toString("base64")}`) { response.writeHead(403); response.end(); return; }
    const url = new URL(request.url!, "http://localhost"); seen.push(url.pathname);
    if (!url.pathname.startsWith("/proxy/org/repo.git/")) { response.writeHead(403); response.end(); return; }
    const child = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname.replace("/proxy/org/", "/"),
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
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port, gitBaseUrl = `http://127.0.0.1:${port}/proxy/`;
    await execFile("git", ["init", "--bare", bare]); await execFile("git", ["-C", bare, "config", "http.receivepack", "true"]);
    await execFile("git", ["init", "-b", "test", repo]); await writeFile(path.join(repo, "test.txt"), "test\n");
    await execFile("git", ["-C", repo, "add", "test.txt"]); await execFile("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "test"]);
    await execFile("git", ["-C", repo, "remote", "add", "origin", "https://github.com/org/repo.git"]);
    await runWithGithubWriteCredential({ token: proxyToken, owner: "org", repository: "repo", expiresAtMs: Date.now() + 60000, gitBaseUrl, apiBaseUrl: `${gitBaseUrl}api` }, () => true, async () => {
      const invocation = (await prepareGitCredentialInvocation({ contextId: "test", protocol: "https", host: "github.com", authority: "github.com", path: "org/repo.git" }))!;
      try { await execFile("git", [...invocation.gitConfigArgs, "-C", repo, "push", "origin", "test"], { env: { ...process.env, ...invocation.env }, timeout: 15000 }); }
      finally { invocation.release?.(); }
    });
    expect(seen).toContain("/proxy/org/repo.git/git-receive-pack");
    const source = await execFile("git", ["-C", repo, "rev-parse", "HEAD"]), destination = await execFile("git", ["-C", bare, "rev-parse", "refs/heads/test"]);
    expect(destination.stdout).toBe(source.stdout);
    expect((await execFile("git", ["-C", repo, "remote", "get-url", "origin"])).stdout.trim()).toBe("https://github.com/org/repo.git");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await closeGitCredentialBrokerForTesting(); await rm(root, { recursive: true, force: true }); }
}, 25000);
