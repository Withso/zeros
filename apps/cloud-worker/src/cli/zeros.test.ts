import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run, type CliIo } from "./zeros";

const TOKEN = `zw2a_${"C".repeat(43)}`;
const KEY = `zk_${"K".repeat(43)}`;
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
interface Seen { method: string; path: string; headers: IncomingMessage["headers"]; body?: unknown }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

/** A fake of the Zeros API: each handler answers a "METHOD /path" key. */
async function fakeApi(routes: Record<string, (seen: Seen) => { status?: number; body?: unknown; raw?: string }>) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8"), url = new URL(req.url!, "http://fixture");
    const entry: Seen = { method: req.method!, path: url.pathname + url.search, headers: req.headers, ...(text ? { body: JSON.parse(text) } : {}) };
    seen.push(entry);
    const route = routes[`${req.method} ${url.pathname}`] ?? (() => ({ status: 404, body: { error: { code: "not_found", message: "Not found." } } }));
    const answer = route(entry);
    res.writeHead(answer.status ?? 200, { "Content-Type": "application/json" }).end(answer.raw ?? JSON.stringify(answer.body ?? {}));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise(resolve => server.close(() => resolve())));
  return { seen, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v0` };
}
function io(env: Record<string, string | undefined>, extra: Partial<CliIo> = {}) {
  let stdout = "", stderr = "";
  return { io: { env, stdout: (text: string) => { stdout += text; }, stderr: (text: string) => { stderr += text; }, ...extra } satisfies CliIo,
    out: () => stdout, err: () => stderr };
}

describe("zeros cloud", () => {
  it("explains that API access is not enabled when the control plane delivered nothing", async () => {
    const t = io({ ZEROS_WORKSPACE_ID: WORKSPACE, ZEROS_SESSION_ID: "chat" });
    expect(await run(["cloud", "me"], t.io)).toBe(3);
    expect(t.err()).toContain("Zeros API access is not enabled for this workspace");
    expect(t.out()).toBe("");
  });

  it("acts with the workspace token, attributes the chat and prints the object unchanged with --json", async () => {
    const me = { userId: "u", email: "fixture@example.test", organizationId: "o", organizationName: "Org", credential: "workspace_token", workspaceId: WORKSPACE };
    const api = await fakeApi({ "GET /api/v0/me": () => ({ body: me }) });
    const t = io({ ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN, ZEROS_WORKSPACE_ID: WORKSPACE, ZEROS_SESSION_ID: "chat-1" });
    expect(await run(["cloud", "me", "--json"], t.io)).toBe(0);
    expect(JSON.parse(t.out())).toEqual(me);
    expect(api.seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.seen[0].headers["x-zeros-session-id"]).toBe("chat-1");
  });

  it("prefers the user's ZEROS_API_KEY over the workspace token", async () => {
    const api = await fakeApi({ "GET /api/v0/models": () => ({ body: { data: [] } }) });
    const t = io({ ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN, ZEROS_API_KEY: KEY });
    expect(await run(["cloud", "models"], t.io)).toBe(0);
    expect(api.seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(api.seen[0].headers).not.toHaveProperty("x-zeros-session-id");
  });

  it("defaults the workspace to this one and maps every workspace verb to its route", async () => {
    const workspace = { id: WORKSPACE, number: 7, name: "fixture", status: "ready", repository: "o/r", branch: "b" };
    const answer = () => ({ body: workspace });
    const api = await fakeApi({ [`GET /api/v0/workspaces/${WORKSPACE}`]: answer, [`GET /api/v0/workspaces/${WORKSPACE}/status`]: answer,
      ...Object.fromEntries(["archive", "unarchive", "sleep", "wake", "rename"].map(verb => [`POST /api/v0/workspaces/${WORKSPACE}/${verb}`, answer])),
      [`GET /api/v0/workspaces/${WORKSPACE}/sessions`]: () => ({ body: { data: [], offset: 0, hasMore: false } }) });
    const env = { ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN, ZEROS_WORKSPACE_ID: WORKSPACE };
    for (const verb of ["get", "status", "archive", "unarchive", "sleep", "wake"]) expect(await run(["cloud", "workspace", verb], io(env).io)).toBe(0);
    expect(await run(["cloud", "workspace", "rename", "--name", "New title"], io(env).io)).toBe(0);
    expect(await run(["cloud", "workspace", "sessions", "--include-archived", "--limit", "5"], io(env).io)).toBe(0);
    expect(api.seen.map(entry => `${entry.method} ${entry.path}`)).toEqual([
      `GET /api/v0/workspaces/${WORKSPACE}`, `GET /api/v0/workspaces/${WORKSPACE}/status`,
      ...["archive", "unarchive", "sleep", "wake", "rename"].map(verb => `POST /api/v0/workspaces/${WORKSPACE}/${verb}`),
      `GET /api/v0/workspaces/${WORKSPACE}/sessions?limit=5&includeArchived=true`]);
    expect(api.seen.find(entry => entry.path.endsWith("/rename"))!.body).toEqual({ name: "New title" });
  });

  it("creates a workspace with a first message and an idempotency key, and lists with filters", async () => {
    const api = await fakeApi({ "POST /api/v0/workspaces": () => ({ status: 201, body: { workspace: { id: WORKSPACE }, session: { id: "s" } } }),
      "GET /api/v0/workspaces": () => ({ body: { data: [{ id: WORKSPACE, number: 3, status: "ready", name: "n", repository: "o/r", branch: "b" }], offset: 0, hasMore: true } }) });
    const env = { ZEROS_API_URL: api.url, ZEROS_API_KEY: KEY };
    expect(await run(["cloud", "workspace", "create", "--repository", "o/r", "--message", "Fix it"], io(env).io)).toBe(2);
    const t = io(env);
    expect(await run(["cloud", "workspace", "create", "--repository", "o/r", "--agent", "codex", "--message", "Fix it", "--session-name", "First chat", "--idempotency-key", "k1"], t.io)).toBe(0);
    const list = io(env);
    expect(await run(["cloud", "workspace", "list", "--state", "running", "--name", "fix", "--include-archived"], list.io)).toBe(0);
    expect(api.seen[0]).toMatchObject({ method: "POST", path: "/api/v0/workspaces", body: { repository: "o/r", agent: "codex", message: "Fix it", sessionName: "First chat" } });
    expect(api.seen[0].headers["idempotency-key"]).toBe("k1");
    expect(api.seen[1].path).toBe("/api/v0/workspaces?state=running&name=fix&includeArchived=true");
    expect(list.out()).toBe(`${WORKSPACE}  #3  ready  n  o/r  b\n(more: use --offset)\n`);
  });

  it("passes repeatable --env KEY=VALUE pairs on workspace create and refuses malformed or repeated names", async () => {
    const api = await fakeApi({ "POST /api/v0/workspaces": () => ({ status: 201, body: { workspace: { id: WORKSPACE } } }) });
    const env = { ZEROS_API_URL: api.url, ZEROS_API_KEY: KEY };
    expect(await run(["cloud", "workspace", "create", "--repository", "o/r", "--env", "APP_MODE=staging", "--env", "EMPTY=", "--env", "URL=https://x.test/?a=b"], io(env).io)).toBe(0);
    expect(api.seen[0]!.body).toEqual({ repository: "o/r", env: { APP_MODE: "staging", EMPTY: "", URL: "https://x.test/?a=b" } });
    for (const bad of [["--env", "NOVALUE"], ["--env", "=value"], ["--env", "A=1", "--env", "A=2"]]) {
      const t = io(env);
      expect(await run(["cloud", "workspace", "create", "--repository", "o/r", ...bad], t.io)).toBe(2);
      expect(t.err()).toContain("--env");
    }
    expect(api.seen).toHaveLength(1);
    const help = io({}); await run(["cloud", "--help"], help.io);
    expect(help.out()).toContain("[--env KEY=VALUE]");
  });

  it("sends a message from a file or standard input and creates sessions in this workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zeros-cli-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "prompt.md"), "From a file\n");
    const api = await fakeApi({ "POST /api/v0/sessions/s1/messages": () => ({ status: 201, body: { id: "m1" } }),
      "POST /api/v0/sessions": () => ({ status: 201, body: { session: { id: "s2" }, message: { id: "m2" } } }) });
    const env = { ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN, ZEROS_WORKSPACE_ID: WORKSPACE };
    expect(await run(["cloud", "message", "send", "--session", "s1", "--message-file", join(directory, "prompt.md"), "--message-id", "mid"], io(env).io)).toBe(0);
    expect(await run(["cloud", "message", "send", "--session", "s1", "--message-file", "-"], io(env, { stdin: async () => "From stdin" }).io)).toBe(0);
    expect(await run(["cloud", "session", "create", "--agent", "claude", "--message", "Hello", "--name", "Fix login"], io(env).io)).toBe(0);
    expect(await run(["cloud", "message", "send", "--session", "s1", "--message", "a", "--message-file", "-"], io(env).io)).toBe(2);
    expect(api.seen.map(entry => entry.body)).toEqual([{ message: "From a file\n", messageId: "mid" }, { message: "From stdin" },
      { workspaceId: WORKSPACE, agent: "claude", message: "Hello", name: "Fix login" }]);
  });

  it("renames, archives and unarchives a session", async () => {
    const session = { id: "s1", workspaceId: WORKSPACE, name: "Renamed", archived: false };
    const answer = () => ({ body: session });
    const api = await fakeApi({ "POST /api/v0/sessions/s1/rename": answer, "POST /api/v0/sessions/s1/archive": answer, "POST /api/v0/sessions/s1/unarchive": answer });
    const env = { ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN };
    expect(await run(["cloud", "session", "rename", "s1", "--name", "Renamed"], io(env).io)).toBe(0);
    expect(await run(["cloud", "session", "archive", "s1"], io(env).io)).toBe(0);
    expect(await run(["cloud", "session", "unarchive", "s1"], io(env).io)).toBe(0);
    expect(api.seen.map(entry => [entry.method, entry.path, entry.body])).toEqual([
      ["POST", "/api/v0/sessions/s1/rename", { name: "Renamed" }], ["POST", "/api/v0/sessions/s1/archive", undefined], ["POST", "/api/v0/sessions/s1/unarchive", undefined]]);
    expect(await run(["cloud", "session", "rename", "s1"], io(env).io)).toBe(2);
    expect(await run(["cloud", "session", "archive"], io(env).io)).toBe(2);
    const help = io({}); await run(["cloud", "--help"], help.io);
    expect(help.out()).toContain("session rename <id> --name n");
    expect(help.out()).toContain("session get|status|cancel|archive|unarchive <id>");
  });

  it("reads one message of a session", async () => {
    const message = { id: "m1", sessionId: "s1", index: 3, type: "assistant", content: { text: "done" }, createdAt: "2026-11-10T00:00:00Z" };
    const api = await fakeApi({ "GET /api/v0/sessions/s1/messages/m1": () => ({ body: message }) });
    const env = { ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN };
    const t = io(env);
    expect(await run(["cloud", "message", "get", "--session", "s1", "m1", "--json"], t.io)).toBe(0);
    expect(JSON.parse(t.out())).toEqual(message);
    expect(await run(["cloud", "message", "get", "--session", "s1"], io(env).io)).toBe(2);
    expect(await run(["cloud", "message", "get", "m1"], io(env).io)).toBe(2);
    const help = io({}); await run(["cloud", "--help"], help.io);
    expect(help.out()).toContain("message get --session id <message-id>");
  });

  it("waits until a session is idle or in error, returning at once if it already is, and gives up at the timeout", async () => {
    const statuses = ["working", "working", "idle"];
    const api = await fakeApi({ "GET /api/v0/sessions/s1/status": () => ({ body: { workspaceId: WORKSPACE, sessionId: "s1", status: statuses.shift() ?? "idle", updatedAt: 1 } }),
      "GET /api/v0/sessions/s2/status": () => ({ body: { workspaceId: WORKSPACE, sessionId: "s2", status: "working", updatedAt: 1 } }) });
    let clock = 0;
    const timing = { sleep: async (ms: number) => { clock += ms; }, now: () => clock };
    const env = { ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN };
    expect(await run(["cloud", "session", "wait", "s1", "--json"], io(env, timing).io)).toBe(0);
    expect(api.seen.filter(entry => entry.path.startsWith("/api/v0/sessions/s1"))).toHaveLength(3);
    const before = api.seen.length;
    expect(await run(["cloud", "session", "wait", "s1"], io(env, timing).io)).toBe(0);
    expect(api.seen.length - before).toBe(1);
    const late = io(env, timing);
    expect(await run(["cloud", "session", "wait", "s2", "--timeout", "10", "--interval", "2"], late.io)).toBe(1);
    expect(late.err()).toContain("Timed out");
  });

  it("maps errors to exit codes and never prints the credential, even with --debug", async () => {
    const api = await fakeApi({
      "GET /api/v0/me": () => ({ status: 401, body: { error: { code: "unauthorized", message: `Bad credential ${TOKEN}` } } }),
      "GET /api/v0/models": () => ({ status: 503, body: { error: { code: "unavailable", message: "Try again." } } }),
      "GET /api/v0/sessions/missing": () => ({ status: 404, body: { error: { code: "not_found", message: "Not found." } } }),
    });
    const env = { ZEROS_API_URL: api.url, ZEROS_API_TOKEN: TOKEN };
    const auth = io(env), server = io(env), missing = io(env);
    expect(await run(["cloud", "me", "--debug"], auth.io)).toBe(3);
    expect(await run(["cloud", "models"], server.io)).toBe(4);
    expect(await run(["cloud", "session", "get", "missing"], missing.io)).toBe(1);
    expect(await run(["cloud", "session", "get"], io(env).io)).toBe(2);
    expect(await run(["cloud", "workspace", "frobnicate"], io(env).io)).toBe(2);
    expect(await run(["cloud", "me", "--bogus"], io(env).io)).toBe(2);
    expect(auth.err()).toContain("GET /api/v0/me 401");
    for (const output of [auth, server, missing]) expect(output.out() + output.err()).not.toContain(TOKEN);
    expect(missing.err()).toBe("zeros: Not found. (not_found)\n");
  });

  it("refuses a plain-http API base outside loopback and an unreachable server is a server failure", async () => {
    expect(await run(["cloud", "me"], io({ ZEROS_API_URL: "http://api.example.test/api/v0", ZEROS_API_TOKEN: TOKEN }).io)).toBe(2);
    const unreachable = io({ ZEROS_API_URL: "http://127.0.0.1:1/api/v0", ZEROS_API_TOKEN: TOKEN });
    expect(await run(["cloud", "me"], unreachable.io)).toBe(4);
    expect(unreachable.err()).toBe("zeros: The Zeros API could not be reached.\n");
  });

  it("points zeros local at the Mac and prints usage for no command", async () => {
    const local = io({});
    expect(await run(["local", "workspace", "list"], local.io)).toBe(2);
    expect(local.err()).toContain("zeros local runs only in the Zeros app on your Mac");
    const empty = io({});
    expect(await run([], empty.io)).toBe(2);
    expect(empty.out()).toContain("Usage: zeros cloud");
    expect(await run(["cloud", "--help"], io({}).io)).toBe(0);
  });
});
