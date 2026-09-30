import { execFile as callback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createNativeGithubBroker } from "../github-native-broker";
import { createCloudGithubProxyRoutes } from "../../../../../control-plane/src/cloud-workspaces/github-write-proxy";
import type { DatabaseCloudGithubWriteGrants } from "../../../../../control-plane/src/cloud-workspaces/github-write-grants";
import type { GithubProxyAuthority } from "../../../../../control-plane/src/cloud-workspaces/github-write-grants";
const execFile = promisify(callback);

it.each(["https://github.com/org/repo.git", "https://github.com/ORG/REPO"])(
  "routes connected-account Git through the guarded proxy using %s",
  async (remote) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-http-"));
    const repo = path.join(root, "work"),
      bare = path.join(root, "repo.git");
    const upstream = createServer((request, response) => {
      const url = new URL(request.url!, "http://localhost");
      const child = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          REQUEST_METHOD: request.method,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          REMOTE_USER: "test",
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      request.pipe(child.stdin);
      let head = Buffer.alloc(0),
        sent = false;
      child.stdout.on("data", (part: Buffer) => {
        if (sent) {
          response.write(part);
          return;
        }
        head = Buffer.concat([head, part]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head.subarray(0, end).toString().split("\r\n")) {
          const i = line.indexOf(":");
          const key = line.slice(0, i).toLowerCase(),
            value = line.slice(i + 1).trim();
          if (key === "status") status = Number(value.split(" ")[0]);
          else headers[key] = value;
        }
        sent = true;
        response.writeHead(status, headers);
        response.write(head.subarray(end + 4));
      });
      child.on("close", () => response.end());
      child.on("error", () => {
        response.writeHead(500);
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const port = (upstream.address() as { port: number }).port;
    let writes = 0, live = true, connected = true, leader = process.pid;
    const grants = new Map<string, GithubProxyAuthority & { spent: boolean }>();
    const app = createCloudGithubProxyRoutes({ authorizeProxy: async (token: string, write: string | null = null) => {
      const scope = grants.get(token);
      if (!live || !scope || (write && scope.spent)) throw new Error("denied");
      if (write) { scope.spent = true; writes++; }
      return scope;
    } } as unknown as DatabaseCloudGithubWriteGrants, async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      if (url.hostname === "api.github.com") {
        expect(authorization).toBe("Bearer synthetic-connected-user");
        expect(url.pathname).toBe("/repos/org/repo");
        return Response.json({ id: 123 });
      }
      expect(authorization).toBe(`Basic ${Buffer.from("x-access-token:synthetic-connected-user").toString("base64")}`);
      return fetch(`http://127.0.0.1:${port}${url.pathname.replace("/org/", "/")}${url.search}`, init);
    });
    const broker = await createNativeGithubBroker({ directory: path.join(root, "broker"), visibleDirectory: path.join(root, "broker"),
      cwd: repo, path: process.env.PATH!, node: process.execPath,
      source: remote.endsWith(".git") ? { kind: "agent", leaseId: "11111111-1111-4111-8111-111111111111" }
        : { kind: "terminal", actorSessionId: "22222222-2222-4222-8222-222222222222" },
      peerProcess: () => leader, authorized: () => live,
      request: async request => {
        if (!connected) throw new Error("Open Zeros to authorize GitHub push for this cloud workspace");
        const token = `zgp_${randomBytes(32).toString("base64url")}`;
        const value = { owner: "org", repository: "repo", expiresAtMs: Date.now() + 60000 };
        grants.set(token, { ...value, repositoryId: "123", userToken: "synthetic-connected-user", operation: request.operation,
          prNumber: null, expectedBody: null, gitReference: `refs/heads/${request.branch}`, spent: false });
        return { ...value, token, release: async () => { grants.delete(token); } };
      },
      forward: async (url, token, init) => app.request(new Request("http://localhost/internal/v1/cloud-workspaces/github-proxy/git" + url,
        { ...init, headers: { ...init.headers, authorization: `Bearer ${token}` } })),
    });
    const env = { ...process.env, ...broker.env };
    const git = (args: string[]) => execFile(path.join(root, "broker/git"), ["-C", repo, ...args], { env, timeout: 15000 });
    try {
      await execFile("git", ["init", "--bare", bare]);
      await execFile("git", ["-C", bare, "config", "http.receivepack", "true"]);
      await execFile("git", ["init", "-b", "topic", repo]);
      await writeFile(path.join(repo, "test.txt"), randomBytes(5 * 1024 * 1024));
      await git(["add", "test.txt"]);
      await git(["-c", "user.name=Test", "-c", "user.email=42+member@users.noreply.github.com", "commit", "-m", "test"]);
      await git(["remote", "add", "origin", remote]);
      expect((await git(["remote", "get-url", "origin"])).stdout.trim()).toBe(remote);
      if (!remote.endsWith(".git")) {
        leader = 99999999;
        await expect(git(["push", "origin", "topic"])).rejects.toThrow();
        expect(grants.size).toBe(0);
        leader = process.pid;
      }
      const push = await git(["push", "--set-upstream", "origin", "topic"]);
      expect(push.stdout + push.stderr).not.toMatch(/synthetic-connected-user|zgp_/);
      expect(writes).toBe(1); expect(grants.size).toBe(0);
      await git(["fetch", "origin"]);
      const fetched = path.join(root, "fetched");
      await git(["clone", remote, fetched]);
      expect((await execFile("git", ["-C", fetched, "rev-parse", "refs/remotes/origin/topic"])).stdout).toBe((await git(["rev-parse", "HEAD"])).stdout);
      expect((await execFile("git", ["-C", bare, "rev-parse", "refs/heads/topic"])).stdout).toBe((await git(["rev-parse", "HEAD"])).stdout);
      await expect(git(["push", "origin", "HEAD:main"])).rejects.toThrow();
      await expect(git(["push", "--delete", "origin", "topic"])).rejects.toThrow();
      await expect(git(["push", "https://github.com/org/else.git", "topic"])).rejects.toThrow();
      connected = false;
      await expect(git(["push", "origin", "topic"])).rejects.toThrow("Open Zeros to authorize GitHub push for this cloud workspace");
      expect(writes).toBe(1); expect(grants.size).toBe(0);
      live = false;
      await expect(git(["fetch", "origin"])).rejects.toThrow();
    } finally {
      await broker.stopAndProve(); upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
