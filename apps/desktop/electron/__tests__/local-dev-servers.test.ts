import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_LISTENERS,
  MAX_SCOPE_EXCLUDES,
  createLocalDevServerLister,
  cwdInScope,
  decodeHtmlEntities,
  extractHtmlTitle,
  filterCandidates,
  isLoopbackOrWildcardHost,
  isPathWithinFolder,
  listLocalDevServers,
  parseLsofCwd,
  parseLsofListeners,
  probeHttp,
  resolveLocalDevServerScope,
  zerosListenerExclusions,
  type ExecRunner,
  type ListDeps,
  type LocalDevServerScope,
} from "../browser/local-dev-servers";
import { ENGINE_BASE_PORT_PROD } from "../../src/engine/runtime";

const NO_EXCLUSIONS = { ports: new Set<number>(), pids: new Set<number>() };
const WEB: LocalDevServerScope = { root: "/Users/me/web", exclude: [] };

function deps(overrides: Partial<ListDeps> = {}): ListDeps {
  return {
    platform: "darwin",
    exec: async () => ({ stdout: "", error: null }),
    lsofPath: () => "/usr/sbin/lsof",
    httpProbe: async () => ({ status: 200 }),
    now: () => Date.now(),
    exclusions: () => NO_EXCLUSIONS,
    ...overrides,
  };
}

/** Listing and cwd lookups answered from one table: pid → [command, bind, cwd]. */
function lsofTable(rows: Record<number, [string, string, string]>): ExecRunner {
  return async (_file, args) => {
    if (args.includes("cwd")) {
      const wanted = new Set(args[args.indexOf("-p") + 1]!.split(",").map(Number));
      return {
        stdout: Object.entries(rows)
          .filter(([pid]) => wanted.has(Number(pid)))
          .map(([pid, [, , cwd]]) => `p${pid}\nfcwd\nn${cwd}\n`)
          .join(""),
        error: null,
      };
    }
    return {
      stdout: Object.entries(rows)
        .map(([pid, [command, bind]]) => `p${pid}\nc${command}\nf1\nn${bind}\n`)
        .join(""),
      error: null,
    };
  };
}

describe("lsof parsing", () => {
  it("keeps loopback and wildcard LISTEN sockets, one per port", () => {
    const output = [
      "p101",
      "cnode",
      "f21",
      "n*:3000",
      "f22",
      "n[::]:3000",
      "p202",
      "cpython3",
      "f5",
      "n127.0.0.1:8000",
      "p303",
      "cpostgres",
      "f7",
      "n192.168.1.20:5432",
      "p404",
      "cbun",
      "f9",
      "n[::1]:5173",
      "f10",
      "n127.0.0.1:5173->127.0.0.1:61000",
      "",
    ].join("\n");
    expect(parseLsofListeners(output)).toEqual([
      { pid: 101, command: "node", port: 3000, hosts: ["*", "[::]"] },
      { pid: 404, command: "bun", port: 5173, hosts: ["[::1]"] },
      { pid: 202, command: "python3", port: 8000, hosts: ["127.0.0.1"] },
    ]);
  });

  it("ignores malformed records", () => {
    expect(parseLsofListeners("pabc\nn*:notaport\nn*:70000\nnnoport\n")).toEqual([]);
  });

  it("classifies hosts", () => {
    for (const host of ["*", "0.0.0.0", "[::]", "127.0.0.1", "[::1]"])
      expect(isLoopbackOrWildcardHost(host)).toBe(true);
    for (const host of ["10.0.0.4", "[fe80::1]", "example.test"])
      expect(isLoopbackOrWildcardHost(host)).toBe(false);
  });

  it("parses process working directories", () => {
    const cwds = parseLsofCwd("p101\nfcwd\nn/Users/me/app\np202\nfcwd\nn/\np303\nfcwd\nnrelative\n");
    expect(cwds.get(101)).toBe("/Users/me/app");
    expect(cwds.get(202)).toBe("/");
    expect(cwds.has(303)).toBe(false);
  });
});

describe("HTML title extraction", () => {
  it("decodes entities, strips markup and collapses whitespace", () => {
    expect(
      extractHtmlTitle("<html><head><TITLE data-x>\n  Vite &amp; React &#8212; &#x41;pp <b>x</b>\n</TITLE>"),
    ).toBe("Vite & React — App x");
  });

  it("caps length and drops control characters", () => {
    const title = extractHtmlTitle(`<title>${"a".repeat(400)}\u0007</title>`);
    expect(title!.length).toBeLessThanOrEqual(120);
    expect(title!.endsWith("…")).toBe(true);
    expect(extractHtmlTitle("<title>\u0000\u0001</title>")).toBeUndefined();
    expect(extractHtmlTitle("<p>no title</p>")).toBeUndefined();
  });

  it("leaves invalid or unknown entities intact", () => {
    expect(decodeHtmlEntities("&bogus; &#0; &#xD800; &lt;")).toBe("&bogus; &#0; &#xD800; <");
  });
});

describe("candidate exclusion", () => {
  const socket = (port: number, pid: number | null, command: string | null) => ({
    port,
    pid,
    command,
    hosts: ["*"],
  });

  it("drops Zeros listeners by exact PID and port, keeping engine descendants", () => {
    const exclusions = zerosListenerExclusions({
      mainPid: 10,
      enginePid: 20,
      enginePort: 31002,
      engineBase: 31000,
      rendererDevUrl: "http://localhost:6400",
      vitePort: "6401",
    });
    const kept = filterCandidates(
      [
        socket(3000, 30, "node"), // started in a Zeros terminal (engine child)
        socket(4100, 10, "Zeros"),
        socket(4200, 20, "node"),
        socket(31002, 40, "node"),
        socket(31005, 41, "node"),
        socket(ENGINE_BASE_PORT_PROD, 42, "node"),
        socket(6400, 50, "node"),
        socket(6401, 51, "node"),
      ],
      exclusions,
    );
    expect(kept.map((row) => row.port)).toEqual([3000]);
  });

  it("drops privileged ports, system services and non-runtime ephemeral listeners", () => {
    const kept = filterCandidates(
      [
        socket(80, 1, "node"),
        socket(5000, 2, "ControlCe"),
        socket(7000, 3, "AirPlayXPCHelper"),
        socket(55000, 4, "SomeHelper"),
        socket(55001, 5, "node"),
        socket(8080, null, null),
      ],
      NO_EXCLUSIONS,
    );
    expect(kept.map((row) => row.port)).toEqual([55001, 8080]);
  });

  it("bounds the listener count", () => {
    const many = Array.from({ length: 300 }, (_, i) => socket(10_000 + i, i + 1, "node"));
    expect(filterCandidates(many, NO_EXCLUSIONS)).toHaveLength(MAX_LISTENERS);
  });
});

describe("workspace scope", () => {
  it("matches folders on path boundaries and honors nested workspaces", () => {
    expect(isPathWithinFolder("/a/web", "/a/web")).toBe(true);
    expect(isPathWithinFolder("/a/web/apps/api", "/a/web")).toBe(true);
    expect(isPathWithinFolder("/a/web-old", "/a/web")).toBe(false);
    const scope = { root: "/a/web", exclude: ["/a/web/.claude/worktrees/x"] };
    expect(cwdInScope("/a/web/apps", scope)).toBe(true);
    expect(cwdInScope("/a/web/.claude/worktrees/x", scope)).toBe(false);
    expect(cwdInScope("/a/web/.claude/worktrees/x/app", scope)).toBe(false);
    expect(cwdInScope("/a/web/.claude/worktrees/xy", scope)).toBe(true);
    expect(cwdInScope(undefined, scope)).toBe(false);
    expect(cwdInScope("/", scope)).toBe(false);
  });

  it("canonicalizes the root and keeps only nested exclusions", async () => {
    const realpath = vi.fn(async (target: string) => {
      if (target === "/tmp/site/") return "/private/tmp/site";
      if (target.startsWith("/tmp/")) return `/private${target}`;
      if (target === "/missing/dir/") throw Object.assign(new Error("nope"), { code: "ENOENT" });
      return target;
    });
    await expect(
      resolveLocalDevServerScope(
        {
          root: "/tmp/site/",
          exclude: ["/tmp/site/.claude/worktrees/b", "/tmp/site/.claude/worktrees/a", "/tmp/site", "/tmp/other", "/tmp/site/.claude/worktrees/a"],
        },
        realpath,
      ),
    ).resolves.toEqual({
      root: "/private/tmp/site",
      exclude: ["/private/tmp/site/.claude/worktrees/a", "/private/tmp/site/.claude/worktrees/b"],
    });
    await expect(resolveLocalDevServerScope({ root: "/missing/dir/" }, realpath)).resolves.toEqual({
      root: "/missing/dir",
      exclude: [],
    });
  });

  it("rejects malformed scopes and the filesystem root", async () => {
    const realpath = async (target: string) => (target === "/link-to-root" ? "/" : target);
    for (const args of [
      {},
      { root: "relative/path" },
      { root: "/a\0b" },
      { root: `/${"a".repeat(5_000)}` },
      { root: "/" },
      { root: "/link-to-root" },
      { root: "/a", exclude: "/a/b" },
      { root: "/a", exclude: [42] },
      { root: "/a", exclude: Array.from({ length: MAX_SCOPE_EXCLUDES + 1 }, (_, i) => `/a/${i}`) },
    ])
      await expect(resolveLocalDevServerScope(args as Record<string, unknown>, realpath)).rejects.toThrow(
        /Invalid local server scope/,
      );
  });
});

describe("listLocalDevServers", () => {
  it("confirms HTTP, resolves cwd and returns localhost URLs", async () => {
    const exec = vi.fn<ExecRunner>(async (_file, args) =>
      args.includes("cwd")
        ? { stdout: "p101\nfcwd\nn/Users/me/web\np102\nfcwd\nn/Users/me/web/tools\n", error: null }
        : {
            stdout: "p101\ncnode\nf1\nn*:5173\np102\ncnode\nf2\nn127.0.0.1:9229\n",
            error: null,
          },
    );
    const httpProbe = vi.fn(async (_address: string, port: number) =>
      port === 5173 ? { status: 200, title: "My app" } : null,
    );
    const result = await listLocalDevServers(deps({ exec, httpProbe }), WEB);
    expect(result).toEqual({
      root: "/Users/me/web",
      servers: [
        {
          port: 5173,
          url: "http://localhost:5173",
          title: "My app",
          processName: "node",
          cwd: "/Users/me/web",
        },
      ],
    });
    expect(exec.mock.calls[0]![1]).toEqual(["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]);
    expect(exec.mock.calls[1]![1]).toEqual(["-a", "-p", "101,102", "-d", "cwd", "-Fpn"]);
    for (const [address] of httpProbe.mock.calls)
      expect(["127.0.0.1", "::1"]).toContain(address);
  });

  it("lists only servers started inside the workspace and never contacts the rest", async () => {
    const exec = lsofTable({
      101: ["node", "*:3000", "/Users/me/web"],
      102: ["node", "*:3001", "/Users/me/web/apps/api"],
      103: ["node", "*:3002", "/Users/me/web/.claude/worktrees/feature"],
      104: ["node", "*:3003", "/Users/me/web-old"],
      105: ["python3", "127.0.0.1:8000", "/Users/me/other"],
      106: ["SomeApp", "127.0.0.1:14498", "/"],
    });
    const httpProbe = vi.fn(async (_address: string, _port: number) => ({ status: 200 }));
    const result = await listLocalDevServers(deps({ exec, httpProbe }), {
      root: "/Users/me/web",
      exclude: ["/Users/me/web/.claude/worktrees/feature"],
    });
    expect(result.servers.map((server) => [server.port, server.cwd])).toEqual([
      [3000, "/Users/me/web"],
      [3001, "/Users/me/web/apps/api"],
    ]);
    expect(new Set(httpProbe.mock.calls.map(([, port]) => port))).toEqual(new Set([3000, 3001]));
  });

  it("lists a nested workspace's own servers when it is the scope", async () => {
    const exec = lsofTable({
      101: ["node", "*:3000", "/Users/me/web"],
      103: ["node", "*:3002", "/Users/me/web/.claude/worktrees/feature/app"],
    });
    const result = await listLocalDevServers(deps({ exec }), {
      root: "/Users/me/web/.claude/worktrees/feature",
      exclude: [],
    });
    expect(result.servers.map((server) => server.port)).toEqual([3002]);
  });

  it("treats lsof exit 1 without output as no listeners", async () => {
    const exec = vi.fn<ExecRunner>(async () => ({
      stdout: "",
      error: Object.assign(new Error("exit 1"), { code: 1 }),
    }));
    const httpProbe = vi.fn(async () => ({ status: 200 }));
    const result = await listLocalDevServers(deps({ exec, httpProbe }), WEB);
    expect(result.servers).toEqual([]);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(httpProbe).not.toHaveBeenCalled();
  });

  it("drops the unterminated last record when lsof is killed by its timeout", async () => {
    const killed = Object.assign(new Error("timeout"), { killed: true, code: null });
    const exec: ExecRunner = async (_file, args) =>
      args.includes("cwd")
        ? { stdout: "p101\nfcwd\nn/Users/me/web\np102\nfcwd\nn/Users/me/web\n", error: null }
        : { stdout: "p101\ncnode\nf1\nn*:3000\np102\ncnode\nf2\nn*:30", error: killed };
    const result = await listLocalDevServers(deps({ exec }), WEB);
    expect(result.servers.map((server) => server.port)).toEqual([3000]);
  });

  it("rejects when lsof is unavailable or produces nothing before its timeout", async () => {
    for (const error of [
      Object.assign(new Error("missing"), { code: "ENOENT" }),
      Object.assign(new Error("timeout"), { killed: true, code: null }),
    ]) {
      const httpProbe = vi.fn(async () => ({ status: 200 }));
      await expect(
        listLocalDevServers(deps({ exec: async () => ({ stdout: "", error }), httpProbe }), WEB),
      ).rejects.toThrow(/unavailable/);
      expect(httpProbe).not.toHaveBeenCalled();
    }
  });

  it("rejects on Windows without spawning lsof or probing ports", async () => {
    const exec = vi.fn<ExecRunner>(async () => ({ stdout: "", error: null }));
    const httpProbe = vi.fn(async () => ({ status: 200 }));
    await expect(
      listLocalDevServers(deps({ platform: "win32", exec, httpProbe }), WEB),
    ).rejects.toThrow(/unavailable/);
    expect(exec).not.toHaveBeenCalled();
    expect(httpProbe).not.toHaveBeenCalled();
  });

  it("shares one in-flight discovery per scope and briefly reuses its result", async () => {
    let now = 1_000;
    const exec = vi.fn<ExecRunner>(async () => ({ stdout: "", error: null }));
    const list = createLocalDevServerLister(deps({ exec, now: () => now }));
    const first = list(WEB);
    expect(list({ root: "/Users/me/web", exclude: [] })).toBe(first);
    const other = list({ root: "/Users/me/api", exclude: [] });
    expect(other).not.toBe(first);
    expect(list({ root: "/Users/me/web", exclude: ["/Users/me/web/nested"] })).not.toBe(first);
    await Promise.all([first, other]);
    expect(exec).toHaveBeenCalledTimes(3);
    await list(WEB);
    expect(exec).toHaveBeenCalledTimes(3);
    now += 1_001;
    await list(WEB);
    expect(exec).toHaveBeenCalledTimes(4);
  });
});

describe("loopback probes", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  async function serve(handler: http.RequestListener): Promise<number> {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  it("reads the title and sends a localhost Host header", async () => {
    let host: string | undefined;
    const port = await serve((request, response) => {
      host = request.headers.host;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Storybook &amp; Docs</title>");
    });
    await expect(probeHttp("127.0.0.1", port, 700)).resolves.toEqual({
      status: 200,
      title: "Storybook & Docs",
    });
    expect(host).toBe(`localhost:${port}`);
  });

  it("does not follow redirects and ignores non-HTML bodies", async () => {
    const port = await serve((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "http://example.test/");
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    await expect(probeHttp("127.0.0.1", port, 700)).resolves.toEqual({ status: 302, title: undefined });
  });

  it("resolves null for a non-HTTP listener and for closed ports", async () => {
    const port = await serve(() => {
      /* never answers */
    });
    await expect(probeHttp("127.0.0.1", port, 150)).resolves.toBeNull();
    const closed = await serve(() => {});
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(probeHttp("127.0.0.1", closed, 250)).resolves.toBeNull();
  });

  it("refuses non-loopback addresses", () => {
    expect(() => probeHttp("10.0.0.1", 80, 100)).toThrow(/loopback-only/);
    expect(() => probeHttp("example.test", 80, 100)).toThrow(/loopback-only/);
  });
});
