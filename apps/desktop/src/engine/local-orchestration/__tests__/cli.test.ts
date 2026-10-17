import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_ERROR_CODES,
  LOCAL_MAX_MESSAGE_CHARS,
  LOCAL_ORCHESTRATION_CALL_PATH,
  LOCAL_WAIT_DEFAULT_MS,
  LOCAL_WAIT_MAX_CLI_MS,
  localExitCode,
  localFail,
  localOk,
} from "@zeros/protocol/local-orchestration";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_CLI_REQUEST_TIMEOUT_MS, LOCAL_CLI_WAIT_MARGIN_MS, runLocalCli, type LocalCliIO } from "../cli";
import { LocalDropbox } from "../dropbox";
import { LocalCapabilityRegistry } from "../server";

const capability = "unit-test-local-capability";
const endpoint = "http://127.0.0.1:43123";
function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const fetch = vi.fn<LocalCliIO["fetch"]>().mockImplementation(async () => response(localOk({ state: "idle" }, { engine: "boot-1" })));
  const readFile = vi.fn<LocalCliIO["readFile"]>().mockResolvedValue("file brief");
  const io: LocalCliIO = {
    env: { ZEROS_LOCAL_URL: endpoint, ZEROS_LOCAL_TOKEN: capability },
    stdin: (async function* () { yield "stdin brief"; })(),
    stdout: (text) => { stdout.push(text); },
    stderr: (text) => { stderr.push(text); },
    fetch, readFile, cwd: () => "/work tree", now: () => Date.now(),
  };
  return { io, stdout, stderr, fetch, readFile, envelope: () => JSON.parse(stdout.join("")) };
}
afterEach(() => vi.useRealTimers());

describe("Local CLI", () => {
  it("posts the versioned call with a header capability, never in argv or the body", async () => {
    const h = harness();
    const argv = ["message", "send", "zeros-dev://chat/a", "--message", "Work", "--request-id", "send-1", "--json"];
    expect(await runLocalCli(argv, h.io)).toBe(0);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe(endpoint + LOCAL_ORCHESTRATION_CALL_PATH);
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer " + capability, "Content-Type": "application/json" } });
    expect(JSON.parse(init!.body as string)).toEqual({ protocol: 1, command: "message.send", args: { chat: "zeros-dev://chat/a", message: "Work" }, requestId: "send-1" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(argv)).not.toContain(capability);
    expect(h.stdout.join("") + h.stderr.join("")).not.toContain(capability);
    expect(h.envelope()).toEqual(localOk({ state: "idle" }, { engine: "boot-1" }));
  });

  it.each(LOCAL_ERROR_CODES)("maps an engine %s failure to the protocol exit code", async (code) => {
    const h = harness();
    const failure = localFail(code, "A safe diagnostic.");
    h.fetch.mockResolvedValue(response(failure, code === "NO_CAPABILITY" ? 401 : code === "USAGE" ? 400 : 200));
    expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(localExitCode(failure));
    expect(h.envelope()).toEqual(failure);
  });

  it.each([{}, { ZEROS_LOCAL_URL: endpoint }, { ZEROS_LOCAL_TOKEN: capability }])("requires both injected capability fields", async (env) => {
    const h = harness();
    h.io.env = env;
    expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(4);
    expect(h.envelope().error.code).toBe("NO_CAPABILITY");
    expect(h.envelope().error.message).toMatch(/run this inside a Zeros Local agent chat/i);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["https://127.0.0.1:43123", "http://example.com", "http://localhost:43123", "http://user:password@127.0.0.1:43123", endpoint + "/other", endpoint + "/?token=bad"])("does not send a bearer to an invalid endpoint %s", async (url) => {
    const h = harness();
    h.io.env = { ...h.io.env, ZEROS_LOCAL_URL: url };
    expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(4);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.stdout.join("")).not.toContain(url);
  });

  it("reports bad argv before making a request", async () => {
    const h = harness();
    expect(await runLocalCli(["chat", "create", "--wat", "--json"], h.io)).toBe(2);
    expect(h.envelope().error.message).toContain("Unknown option --wat");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("prints help, version and guide without a capability", async () => {
    for (const argv of [["--help", "--json"], ["--version", "--json"], ["guide", "--json"]]) {
      const h = harness();
      h.io.env = { ZEROS_LOCAL_SKILL: "/installation/SKILL.md" };
      h.readFile.mockResolvedValue("# Installed Local CLI skill\n");
      expect(await runLocalCli(argv, h.io)).toBe(0);
      expect(h.envelope().ok).toBe(true);
      expect(h.envelope().protocol).toBe(1);
      if (argv[0] === "guide") expect(h.envelope().result.guide).toContain("Installed Local CLI");
      if (argv[0] === "--version") expect(h.envelope().result.version).toEqual(expect.any(String));
      expect(h.fetch).not.toHaveBeenCalled();
    }
  });

  it("has a useful guide fallback when the packaged file cannot be read", async () => {
    const h = harness();
    h.readFile.mockRejectedValue(new Error("unreadable"));
    expect(await runLocalCli(["guide"], h.io)).toBe(0);
    expect(h.stdout.join("")).toContain("zeros local whoami");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["chat", "workspace", "message"])("resolves a %s message file relative to cwd and revalidates the call", async (group) => {
    const h = harness();
    const prefix = group === "workspace" ? [group, "create", "--repo", "current"] : group === "message" ? [group, "send", "a"] : [group, "create"];
    expect(await runLocalCli([...prefix, "--message-file", "brief file.md", "--json"], h.io)).toBe(0);
    expect(h.readFile).toHaveBeenCalledWith("/work tree/brief file.md");
    const body = JSON.parse(h.fetch.mock.calls[0]![1]!.body as string);
    expect(group === "workspace" ? body.args.chat.message : body.args.message).toBe("file brief");
    expect(body).not.toHaveProperty("messageFile");
    expect(body.args).not.toHaveProperty("messageFile");
  });

  it("reads stdin with UTF-8 characters split across chunks", async () => {
    const h = harness();
    const bytes = Buffer.from("Review 🦊\nnext line\n");
    h.io.stdin = (async function* () { for (const byte of bytes) yield Uint8Array.of(byte); })();
    expect(await runLocalCli(["chat", "create", "--message-file", "-", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.fetch.mock.calls[0]![1]!.body as string).args.message).toBe("Review 🦊\nnext line\n");
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it.each(["", "x".repeat(LOCAL_MAX_MESSAGE_CHARS + 1)])("rejects an empty or oversized file message", async (content) => {
    const h = harness();
    h.readFile.mockResolvedValue(content);
    expect(await runLocalCli(["chat", "create", "--message-file", "brief", "--json"], h.io)).toBe(2);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("stops reading stdin as soon as the message bound is exceeded", async () => {
    const h = harness();
    let closed = false;
    let overread = false;
    h.io.stdin = (async function* () {
      try {
        yield "x".repeat(LOCAL_MAX_MESSAGE_CHARS);
        yield "x";
        overread = true;
        yield "never";
      } finally { closed = true; }
    })();
    expect(await runLocalCli(["message", "send", "a", "--message-file", "-", "--json"], h.io)).toBe(2);
    expect(closed).toBe(true);
    expect(overread).toBe(false);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not echo filesystem errors which might contain credential material", async () => {
    const h = harness();
    h.readFile.mockRejectedValue(new Error(capability));
    expect(await runLocalCli(["chat", "create", "--message-file", "bad", "--json"], h.io)).toBe(2);
    expect(h.stdout.join("") + h.stderr.join("")).not.toContain(capability);
  });

  it.each([
    [undefined, [], LOCAL_WAIT_DEFAULT_MS],
    ["9000", [], 9000],
    ["invalid", [], LOCAL_WAIT_DEFAULT_MS],
    ["600000", [], LOCAL_WAIT_MAX_CLI_MS],
    ["9000", ["--timeout", "0"], 0],
    ["9000", ["--timeout", "600"], LOCAL_WAIT_MAX_CLI_MS],
  ] as const)("bounds waits using env %s and argv %j", async (waitMs, flags, expected) => {
    const h = harness();
    h.io.env = { ...h.io.env, ZEROS_LOCAL_WAIT_MS: waitMs };
    expect(await runLocalCli(["chat", "wait", "a", ...flags, "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.fetch.mock.calls[0]![1]!.body as string).args.timeoutMs).toBe(expected);
  });

  it("keeps stdout machine-readable while emitting wait keepalives only during the request", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: (value: Response) => void;
    h.fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const run = runLocalCli(["chat", "wait", "a", "--timeout", "60", "--json"], h.io);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.stderr).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(h.stdout).toHaveLength(0);
    expect(h.stderr.map((line) => JSON.parse(line))).toEqual([
      { type: "keepalive", command: "chat.wait", elapsedMs: 15_000 },
      { type: "keepalive", command: "chat.wait", elapsedMs: 30_000 },
    ]);
    finish(response(localOk({ reason: "done", status: "failed" }, { engine: "boot-1" })));
    expect(await run).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.stderr).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits 5 with the full result when the engine's wait timed out", async () => {
    const h = harness();
    const result = { reason: "timeout", timedOut: true, results: [{ chatId: "a", met: false, state: "working" }] };
    h.fetch.mockResolvedValue(response(localOk(result, { engine: "boot-1" })));
    expect(await runLocalCli(["chat", "wait", "a", "--json"], h.io)).toBe(5);
    expect(h.envelope()).toEqual(localOk(result, { engine: "boot-1" }));
    h.stdout.length = 0;
    h.fetch.mockResolvedValue(response(localOk({ ...result, timedOut: false, reason: "terminal" }, { engine: "boot-1" })));
    expect(await runLocalCli(["chat", "wait", "a", "--json"], h.io)).toBe(0);
  });

  it("bounds a hung wait by its timeout plus margin and aborts the HTTP request", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetch.mockReturnValue(new Promise(() => {}));
    const run = runLocalCli(["chat", "wait", "a", "--json"], h.io);
    await vi.advanceTimersByTimeAsync(LOCAL_WAIT_DEFAULT_MS + LOCAL_CLI_WAIT_MARGIN_MS);
    expect(await run).toBe(5);
    expect(h.envelope().error.code).toBe("TIMEOUT");
    expect(h.fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a lost mutation reply as unknown and preserves the retry request ID", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetch.mockReturnValue(new Promise(() => {}));
    const run = runLocalCli(["chat", "create", "--message", "Work", "--request-id", "create-1", "--json"], h.io);
    await vi.advanceTimersByTimeAsync(LOCAL_CLI_REQUEST_TIMEOUT_MS);
    expect(await run).toBe(8);
    expect(h.envelope().error).toMatchObject({ code: "OUTCOME_UNKNOWN", details: { requestId: "create-1" } });
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("maps connection refusal to engine restart without echoing network exceptions", async () => {
    const h = harness();
    h.fetch.mockRejectedValue(Object.assign(new Error(capability), { cause: { code: "ECONNREFUSED" } }));
    expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(4);
    expect(h.envelope().error.code).toBe("ENGINE_RESTARTED");
    expect(h.stdout.join("")).not.toContain(capability);
  });

  it.each([
    ["Bun", { code: "ConnectionRefused" }],
    ["Node", { cause: { code: "ECONNREFUSED" } }],
  ])("knows a refused %s connection never sent a mutation", async (_runtime, shape) => {
    const h = harness();
    h.fetch.mockRejectedValue(Object.assign(new Error("connect failed"), shape));
    expect(await runLocalCli(["message", "send", "a", "--message", "Work", "--request-id", "send-3", "--json"], h.io)).toBe(4);
    expect(h.envelope().error.code).toBe("ENGINE_RESTARTED");
  });

  it.each([
    ["seatbelt EPERM", { cause: { code: "EPERM" } }],
    ["Bun socket", { code: "FailedToOpenSocket" }],
    ["EACCES", { cause: { code: "EACCES" } }],
  ])("points a sandboxed shell (%s) at the zeros_local tool", async (_label, shape) => {
    const h = harness();
    h.fetch.mockRejectedValue(Object.assign(new Error("denied"), shape));
    expect(await runLocalCli(["chat", "create", "--message", "Work", "--json"], h.io)).toBe(4);
    expect(h.envelope().error.code).toBe("NO_CAPABILITY");
    expect(h.envelope().error.message).toMatch(/zeros_local/);
  });

  describe("a sandboxed shell with a drop folder", () => {
    const scope = { executionId: "exec-1", chatId: "chat-1", agentId: "codex", surface: "cli" as const };
    const dirs: string[] = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });
    const sandboxed = (h: ReturnType<typeof harness>) =>
      h.fetch.mockRejectedValue(Object.assign(new Error("connect EPERM"), { cause: { code: "EPERM" } }));

    it("reaches Zeros on the first attempt when loopback is denied", async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-cli-box-"));
      dirs.push(root);
      const registry = new LocalCapabilityRegistry();
      const calls: unknown[] = [];
      const dropbox = new LocalDropbox(registry, async (caller, body) => {
        calls.push({ caller, body });
        return localOk({ chat: { chatId: caller.chatId } }, { engine: "boot-1" });
      }, () => "boot-1", { root, sweepMs: 10 });
      const box = await dropbox.open(scope);
      const h = harness();
      sandboxed(h);
      h.io.env = { ...h.io.env, ZEROS_LOCAL_TOKEN: registry.mint(scope), ZEROS_LOCAL_DROPBOX: box.dir };
      expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(0);
      expect(h.envelope()).toEqual(localOk({ chat: { chatId: "chat-1" } }, { engine: "boot-1" }));
      expect(calls).toEqual([{ caller: scope, body: { protocol: 1, command: "whoami", args: {} } }]);
      // Nothing is left behind for the agent to trip over.
      expect(fs.readdirSync(box.dir)).toEqual([]);
      await box.close();
    });

    it("says nothing was sent when no engine picks the request up", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-cli-box-"));
      dirs.push(dir);
      const h = harness();
      sandboxed(h);
      h.io.env = { ...h.io.env, ZEROS_LOCAL_DROPBOX: dir };
      h.io.dropboxPickupMs = 50;
      expect(await runLocalCli(["chat", "create", "--message", "Work", "--json"], h.io)).toBe(4);
      expect(h.envelope().error.code).toBe("NO_CAPABILITY");
      expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("points at the zeros_local tool when the folder cannot be written either", async () => {
      const h = harness();
      sandboxed(h);
      h.io.env = { ...h.io.env, ZEROS_LOCAL_DROPBOX: path.join(os.tmpdir(), "zeros-local-missing", "nope") };
      expect(await runLocalCli(["chat", "create", "--message", "Work", "--json"], h.io)).toBe(4);
      expect(h.envelope().error.code).toBe("NO_CAPABILITY");
      expect(h.envelope().error.message).toMatch(/zeros_local/);
    });
  });

  it("treats an unreadable mutation reply as an unknown outcome", async () => {
    const h = harness();
    h.fetch.mockResolvedValue(new Response("truncated response", { status: 200 }));
    expect(await runLocalCli(["message", "send", "a", "--message", "Work", "--request-id", "send-2", "--json"], h.io)).toBe(8);
    expect(h.envelope().error.code).toBe("OUTCOME_UNKNOWN");
    expect(h.envelope().error.details.requestId).toBe("send-2");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("bounds UTF-8 request bytes even when each individual answer is within its character limit", async () => {
    const h = harness();
    const answers = Array.from({ length: 32 }, (_, index) => ({ questionId: String(index), selectedOptionIds: [], freeText: "🦊".repeat(10_000) }));
    expect(await runLocalCli(["card", "answer", "c", "--answers", JSON.stringify(answers), "--json"], h.io)).toBe(2);
    expect(h.envelope().error.message).toContain("byte limit");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ok: true, protocol: 2, result: {}, meta: { engine: "other" } },
    { ok: false, protocol: 0, error: { code: "USAGE", message: "version", retryable: false } },
  ])("rejects a mismatched response protocol", async (body) => {
    const h = harness();
    h.fetch.mockResolvedValue(response(body));
    expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(7);
    expect(h.envelope().error.code).toBe("PROTOCOL_MISMATCH");
  });

  it.each([{}, { ok: true, protocol: 1, result: {} }, { ok: false, protocol: 1, error: { code: "INVENTED", message: "bad", retryable: false } }])("rejects an invalid response envelope", async (body) => {
    const h = harness();
    h.fetch.mockResolvedValue(response(body));
    expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(7);
    expect(h.envelope().error.code).toBe("UNAVAILABLE");
  });

  it("scrubs the bearer even if a malformed server echoes it in values or property names", async () => {
    const h = harness();
    h.fetch.mockResolvedValue(response(localFail("INTERNAL", "Bad " + capability, { details: { [capability]: capability } })));
    expect(await runLocalCli(["whoami", "--json"], h.io)).toBe(1);
    expect(h.stdout.join("") + h.stderr.join("")).not.toContain(capability);
    expect(h.envelope().error.message).toContain("[redacted]");
  });

  it("escapes remote terminal controls in human output and keeps errors on stderr", async () => {
    const h = harness();
    h.fetch.mockResolvedValue(response(localOk({ chats: [{ chatId: "a", title: "bad\u001b[2J\r\u009btitle", state: "idle", link: "zeros://chat/a" }] }, { engine: "b" })));
    expect(await runLocalCli(["chat", "list"], h.io)).toBe(0);
    expect([...h.stdout.join("")].some((char) => char !== "\n" && (char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)))).toBe(false);
    expect(h.stdout.join("")).toContain("zeros://chat/a");
    h.fetch.mockResolvedValue(response(localFail("BUSY", "busy\u001b[2J")));
    h.stdout.length = 0;
    expect(await runLocalCli(["chat", "status", "a"], h.io)).toBe(6);
    expect(h.stdout).toHaveLength(0);
    expect(h.stderr.join("")).toContain("BUSY");
    expect(h.stderr.join("")).not.toContain("\u001b");
  });

  it("redacts credentials before escaping nested human-readable values", async () => {
    const h = harness();
    const quoted = 'unit-quoted"capability\\value';
    h.io.env = { ...h.io.env, ZEROS_LOCAL_TOKEN: quoted };
    h.fetch.mockResolvedValue(response(localFail("INTERNAL", "Failed", { details: { nested: { credential: quoted } } })));
    expect(await runLocalCli(["whoami"], h.io)).toBe(1);
    expect(h.stderr.join("")).not.toContain("unit-quoted");
    expect(h.stderr.join("")).toContain("[redacted]");
  });
});
