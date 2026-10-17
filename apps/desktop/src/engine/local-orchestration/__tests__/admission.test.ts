// Per-execution admission: only Local chats get the CLI capability, the tool
// and the PATH entry; access ends with the execution; the tool runs the same
// argv grammar as the CLI.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LOCAL_ORCHESTRATION_ENV, LOCAL_ORCHESTRATION_TOOL_SERVER, localOk } from "@zeros/protocol/local-orchestration";
import type { ChatRow } from "../../db/chats";
import type { Workspace } from "../../git/types";
import { callLocalTool, LocalOrchestrationAdmissions } from "../admission";
import { LocalDropbox } from "../dropbox";
import { LocalCapabilityRegistry, LocalOrchestrationServer } from "../server";
import type { LocalOrchestrationService } from "../service";
import type { LocalOrchestrationPorts } from "../types";

const WS = "/tmp/zeros-local-adm/ws";

const fileRace = vi.hoisted(() => ({ at: "" as "stat" | "realpath" | "", swap: () => {}, swaps: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const swap = (file: unknown, at: "stat" | "realpath") => {
    if (fileRace.at !== at || !String(file).endsWith("/brief.txt")) return;
    fileRace.at = "";
    fileRace.swaps += 1;
    fileRace.swap();
  };
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const resolved = await actual.realpath(...args);
      swap(args[0], "realpath");
      return resolved;
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      const info = await actual.stat(...args);
      swap(args[0], "stat");
      return info;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]).endsWith("/brief.txt")) {
        const stat = handle.stat.bind(handle);
        handle.stat = (async (...statArgs: Parameters<typeof handle.stat>) => {
          const info = await stat(...statArgs);
          swap(args[0], "stat");
          return info;
        }) as typeof handle.stat;
      }
      return handle;
    },
  };
});

function chat(id: string, folder: string): ChatRow {
  return {
    id,
    folder,
    agentId: "codex",
    agentName: "Codex",
    model: "gpt-6.1-sol",
    effort: "max",
    permissionMode: "auto",
    lastModeId: "auto-edit",
    prePlanModeId: null,
    fast: false,
    additionalDirectories: [],
    title: id,
    createdAt: 1,
    updatedAt: 1,
    sessionId: null,
    pinned: false,
    archived: false,
    sourceChatId: null,
    kind: null,
  };
}

function managed(id: string, wsPath: string, organizationId: string | null = null): Workspace {
  return {
    id,
    repoSlug: "r",
    repoRoot: "/tmp/zeros-local-adm/repo",
    branch: "b",
    baseBranch: "main",
    path: wsPath,
    status: "in-progress" as Workspace["status"],
    createdAt: 1,
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
    lastActiveAt: null,
    organizationId,
    placement: "local",
    present: true,
  };
}

let open = true;
let cloud = false;
const chats = new Map<string, ChatRow>();
const ports = {
  isCloudWorker: () => cloud,
  featureOpen: () => open,
  getChat: (id: string) => chats.get(id) ?? null,
  listManagedWorkspaces: () => [managed("ws_1", WS), managed("ws_org", "/tmp/zeros-local-adm/org", "org_1")],
  listProjects: () => [],
} as unknown as LocalOrchestrationPorts;
const calls: unknown[] = [];
const service = {
  call: async (scope: unknown, body: unknown) => {
    calls.push({ scope, body });
    return localOk({ ran: true }, { engine: "e" });
  },
} as unknown as LocalOrchestrationService;

let registry: LocalCapabilityRegistry;
let server: LocalOrchestrationServer;
let admissions: LocalOrchestrationAdmissions;
const disposers: Array<() => Promise<void>> = [];

beforeEach(() => {
  fileRace.at = "";
  fileRace.swaps = 0;
  open = true;
  cloud = false;
  calls.length = 0;
  chats.clear();
  chats.set("local", chat("local", WS));
  chats.set("local-claude", chat("local-claude", WS));
  chats.set("local-cursor", chat("local-cursor", WS));
  chats.set("org", chat("org", "/tmp/zeros-local-adm/org"));
  chats.set("loose", chat("loose", fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-adm-"))));
  registry = new LocalCapabilityRegistry();
  server = new LocalOrchestrationServer(registry, async () => localOk({}, { engine: "e" }), () => "engine");
  admissions = new LocalOrchestrationAdmissions({
    ports,
    service,
    registry,
    server,
    binDir: () => "/opt/zeros/bin",
    skillFile: () => "/opt/zeros/zeros-local-cli-skill/skills/zeros-local-cli/SKILL.md",
  });
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  await server.stop();
});

const input = (conversationId: string | undefined, agentId = "codex") => ({
  agentId,
  executionId: `exec-${conversationId}`,
  cwd: WS,
  conversationId,
  signal: new AbortController().signal,
});

describe("Local CLI admission", () => {
  it("admits a Local chat with the CLI, the tool and the launcher on PATH", async () => {
    const tools = (await admissions.admit(input("local")))!;
    disposers.push(() => tools.dispose());
    expect(tools).not.toBeNull();
    const token = tools.env[LOCAL_ORCHESTRATION_ENV.token]!;
    expect(registry.resolve(token)).toEqual({ executionId: "exec-local", chatId: "local", agentId: "codex", surface: "cli" });
    expect(tools.env[LOCAL_ORCHESTRATION_ENV.url]).toBe(server.url);
    expect(tools.env[LOCAL_ORCHESTRATION_ENV.cli]).toBe("/opt/zeros/bin/zeros");
    expect(tools.env[LOCAL_ORCHESTRATION_ENV.waitMs]).toBe("8000");
    expect(tools.env[LOCAL_ORCHESTRATION_ENV.toolsCapability]).toMatch(/^Bearer /);
    expect(tools.env[LOCAL_ORCHESTRATION_ENV.toolsCapability]).not.toContain(token);
    expect(tools.pathPrepend).toEqual(["/opt/zeros/bin"]);
    expect(tools.mcpServers).toHaveLength(1);
    expect(tools.mcpServers[0]).toMatchObject({ name: LOCAL_ORCHESTRATION_TOOL_SERVER, transport: "http", defaultToolsApproval: "approve" });
    const brief = await tools.preparePrompt!();
    expect(brief).toContain("SKILL.md");
    // The first call must work on the first attempt: the tool runs inside
    // Zeros, so no shell sandbox or approval stands in its way. A Codex
    // shell has no network outside Full Access.
    expect(brief).toMatch(/zeros_local tool[^.]*\["whoami"\]/);
    expect(brief.indexOf("zeros_local tool")).toBeLessThan(brief.indexOf("zeros local "));
    expect(brief).toContain("sandbox");
    expect(brief).toContain("10 s");
  });

  it("tells every agent to start with the tool, not only Codex", async () => {
    for (const agentId of ["claude", "cursor"]) {
      const tools = (await admissions.admit(input(`local-${agentId}`, agentId)))!;
      disposers.push(() => tools.dispose());
      const brief = await tools.preparePrompt!();
      expect(brief).toMatch(/zeros_local tool[^.]*\["whoami"\]/);
      expect(brief).not.toContain("10 s");
    }
  });

  it("gives each execution a private drop folder for sandboxed shells, removed when it ends", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-adm-box-"));
    const withBox = new LocalOrchestrationAdmissions({
      ports,
      service,
      registry,
      server,
      dropbox: new LocalDropbox(registry, async () => localOk({}, { engine: "e" }), () => "engine", { root, sweepMs: 10 }),
      binDir: () => "/opt/zeros/bin",
      skillFile: () => null,
    });
    const tools = (await withBox.admit(input("local")))!;
    const dir = tools.env[LOCAL_ORCHESTRATION_ENV.dropbox]!;
    expect(path.dirname(dir)).toBe(fs.realpathSync(root));
    expect((fs.statSync(dir).mode & 0o777).toString(8)).toBe("700");
    await tools.dispose();
    expect(fs.existsSync(dir)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("ends access when the execution ends", async () => {
    const tools = (await admissions.admit(input("local")))!;
    const token = tools.env[LOCAL_ORCHESTRATION_ENV.token]!;
    tools.revoke();
    expect(registry.resolve(token)).toBeNull();
    expect(await tools.preparePrompt!()).toBe("");
    await tools.dispose();
  });

  it("admits nothing outside a Local chat or while the feature is closed", async () => {
    expect(await admissions.admit(input("org"))).toBeNull();
    expect(await admissions.admit(input("loose"))).toBeNull();
    expect(await admissions.admit(input("missing"))).toBeNull();
    expect(await admissions.admit(input(undefined))).toBeNull();
    open = false;
    expect(await admissions.admit(input("local"))).toBeNull();
    open = true;
    cloud = true;
    expect(await admissions.admit(input("local"))).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("reads a --message-file inside the chat's workspace through the tool, and nothing outside it", async () => {
    fs.mkdirSync(path.join(WS, ".context"), { recursive: true });
    fs.writeFileSync(path.join(WS, ".context", "brief.md"), "A long brief");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-adm-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");
    fs.rmSync(path.join(WS, ".context", "link.txt"), { force: true });
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(WS, ".context", "link.txt"));
    const scope = { executionId: "exec-local", chatId: "local", agentId: "codex", surface: "cli" as const };
    const signal = new AbortController().signal;
    const reader = admissions.messageFileReader("local");
    const sent = await callLocalTool(service, scope, { args: ["message", "send", "c2", "--message-file", ".context/brief.md"] }, signal, undefined, reader);
    expect(sent.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ body: { command: "message.send", args: { chat: "c2", message: "A long brief" } } });
    const created = await callLocalTool(service, scope, { args: ["workspace", "create", "--repo", "current", "--message-file", ".context/brief.md"] }, signal, undefined, reader);
    expect(created.isError).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({ body: { command: "workspace.create", args: { chat: { message: "A long brief" } } } });
    for (const escape of [path.join(outside, "secret.txt"), ".context/link.txt", "../../etc/hosts"]) {
      const refused = await callLocalTool(service, scope, { args: ["message", "send", "c2", "--message-file", escape] }, signal, undefined, reader);
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain("inside your workspace");
    }
  });

  it.each(["file", "directory"] as const)("does not read host content when the checked message %s is replaced", async (kind) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-adm-race-"));
    disposers.push(async () => { fs.rmSync(root, { recursive: true, force: true }); });
    const workspace = path.join(root, "workspace");
    const inside = path.join(workspace, "briefs");
    const outside = path.join(root, "outside");
    fs.mkdirSync(inside, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(inside, "brief.txt"), "permitted brief");
    fs.writeFileSync(path.join(outside, "brief.txt"), "outside fixture content");
    chats.set("file-reader", chat("file-reader", workspace));
    fileRace.at = kind === "file" ? "stat" : "realpath";
    fileRace.swap = () => {
      if (kind === "file") {
        fs.unlinkSync(path.join(inside, "brief.txt"));
        fs.symlinkSync(path.join(outside, "brief.txt"), path.join(inside, "brief.txt"));
      } else {
        fs.renameSync(inside, `${inside}-original`);
        fs.symlinkSync(outside, inside);
      }
    };
    const result = await admissions.messageFileReader("file-reader")("briefs/brief.txt")
      .then((text) => text, (error: unknown) => {
        expect(error).toMatchObject({ code: "USAGE" });
        return "refused";
      });
    expect(fileRace.swaps).toBe(1);
    expect(["permitted brief", "refused"]).toContain(result);
  });

  it("reads workspace symlinks and added directories that resolve to admitted files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-local-adm-links-"));
    disposers.push(async () => { fs.rmSync(root, { recursive: true, force: true }); });
    const workspace = path.join(root, "workspace");
    const added = path.join(root, "added");
    fs.mkdirSync(workspace);
    fs.mkdirSync(added);
    fs.writeFileSync(path.join(workspace, "message.txt"), "workspace message");
    fs.writeFileSync(path.join(added, "message.txt"), "added message");
    fs.symlinkSync(path.join(workspace, "message.txt"), path.join(workspace, "link.txt"));
    chats.set("file-reader", { ...chat("file-reader", workspace), additionalDirectories: [added] });
    const read = admissions.messageFileReader("file-reader");
    await expect(read("link.txt")).resolves.toBe("workspace message");
    await expect(read(path.join(added, "message.txt"))).resolves.toBe("added message");
  });

  it("runs the CLI grammar as a tool", async () => {
    const scope = { executionId: "e", chatId: "c", agentId: "codex", surface: "cli" as const };
    const signal = new AbortController().signal;
    const result = await callLocalTool(service, scope, { args: ["chat", "status", "chat-1", "--json"] }, signal);
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([{ scope: { ...scope, surface: "tool" }, body: { protocol: 1, command: "chat.status", args: { chat: "chat-1" } } }]);
    // Without a workspace reader (or for stdin) the tool cannot take a file.
    const file = await callLocalTool(service, scope, { args: ["message", "send", "c2", "--message-file", "brief.md"] }, signal);
    expect(file.isError).toBe(true);
    expect(JSON.stringify(file.content)).toContain("--message-file");
    const stdin = await callLocalTool(service, scope, { args: ["message", "send", "c2", "--message-file", "-"] }, signal, undefined, async () => "x");
    expect(stdin.isError).toBe(true);
    const bad = await callLocalTool(service, scope, { args: "chat list" }, signal);
    expect(bad.isError).toBe(true);
    const help = await callLocalTool(service, scope, { args: ["--help"] }, signal);
    expect(JSON.stringify(help.content)).toContain("zeros local");
    // The guide the brief names works through the tool too.
    const guide = await callLocalTool(service, scope, { args: ["guide"] }, signal, async () => "# Zeros Local CLI skill");
    expect(guide.isError).toBeUndefined();
    expect(JSON.stringify(guide.content)).toContain("# Zeros Local CLI skill");
    const builtIn = await callLocalTool(service, scope, { args: ["guide"] }, signal);
    expect(builtIn.isError).toBeUndefined();
    expect(JSON.stringify(builtIn.content)).toContain("zeros local");
    expect(calls).toHaveLength(1);
  });
});
