// Regression history: @cursor/sdk 1.0.26 changed its default local store to the
// `node:sqlite` builtin. The then-shipped Electron 33 runtime embedded Node
// 20.18, before node:sqlite existed, so Agent.create failed in packaged builds.
//
// The host now hands the SDK its own JSONL store, so the default is never
// resolved. These tests pin that it is attached, in the right place, per
// workspace, and as one shared instance — driving the REAL cursor-host.cjs over
// its real protocol, with a stub SDK (fixtures/stub-cursor-sdk.cjs) standing in
// for the 3 MB package so no key or network is needed.

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST = path.join(HERE, "..", "cursor-host.cjs");
const STUB = path.join(HERE, "fixtures", "stub-cursor-sdk.cjs");

/** A live cursor-host.cjs subprocess, driven over its NDJSON stdio protocol. */
class Host {
  private child: ChildProcess;
  private buf = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readyPromise: Promise<void>;

  constructor(
    options: {
      cwd?: string;
      stateRoot?: string;
      defaultStateRoot?: string;
      httpsProxy?: string;
      http2Target?: string;
      ripgrepBoundaryProbe?: boolean;
      reportScanTtl?: boolean;
      ripwalkCacheTtlMs?: string;
    } = {},
  ) {
    this.child = spawn(process.execPath, [HOST], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cwd,
      env: {
        ...process.env,
        ZEROS_CURSOR_SDK_ENTRY: STUB,
        ...(options.stateRoot
          ? { ZEROS_CURSOR_STATE_ROOT: options.stateRoot }
          : {}),
        ...(options.defaultStateRoot
          ? {
              ZEROS_CURSOR_STUB_DEFAULT_STATE_ROOT: options.defaultStateRoot,
            }
          : {}),
        ...(options.httpsProxy
          ? {
              HTTP_PROXY: options.httpsProxy,
              HTTPS_PROXY: options.httpsProxy,
              NO_PROXY: "",
              NODE_USE_ENV_PROXY: "1",
            }
          : {}),
        ...(options.http2Target
          ? { ZEROS_CURSOR_STUB_HTTP2_TARGET: options.http2Target }
          : {}),
        ...(options.ripgrepBoundaryProbe
          ? {
              CURSOR_RIPGREP_PATH: process.execPath,
              ZEROS_CURSOR_STUB_RIPGREP_BOUNDARY: "1",
            }
          : {}),
        ...(options.reportScanTtl
          ? { ZEROS_CURSOR_STUB_REPORT_SCAN_TTL: "1" }
          : {}),
        ...(options.ripwalkCacheTtlMs === undefined
          ? {}
          : { CURSOR_RIPWALK_CACHE_TTL_MS: options.ripwalkCacheTtlMs }),
      },
    });
    let signalReady = () => {};
    this.readyPromise = new Promise<void>((r) => (signalReady = () => r()));
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf("\n");
      while (nl !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        nl = this.buf.indexOf("\n");
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as {
          k: string;
          id?: number;
          ok?: boolean;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.k === "ready") signalReady();
        if (msg.k !== "res" || msg.id === undefined) continue;
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error?.message ?? "host error"));
      }
    });
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  req<T>(op: string, args: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) =>
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      }),
    );
    this.child.stdin?.write(JSON.stringify({ k: "req", id, op, args }) + "\n");
    return p;
  }

  dispose() {
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

let host: Host | null = null;
function startHost(options?: ConstructorParameters<typeof Host>[0]): Host {
  host = new Host(options);
  return host;
}

afterEach(() => {
  host?.dispose();
  host = null;
});

describe("cursor host — workspace scan cache TTL", () => {
  // The host prewarms the workspace executor during session start so the first
  // turn doesn't pay for the scan. The SDK's 20s default expires that warm scan
  // while the user is still reading the chat they just opened, so the turn
  // re-walks anyway and the prewarm buys nothing.
  it("widens the scan cache so a prewarmed workspace survives until the user sends", async () => {
    const h = startHost({ reportScanTtl: true });
    await h.ready();
    const res = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    expect(res.agentId).toBe(`scanTtl:${5 * 60_000}`);
  });

  it("defers to an operator-set CURSOR_RIPWALK_CACHE_TTL_MS", async () => {
    // The SDK reads a configured value AHEAD of the env var, so honouring the
    // environment means configuring nothing at all — not configuring a value we
    // believe matches it.
    const h = startHost({ reportScanTtl: true, ripwalkCacheTtlMs: "60000" });
    await h.ready();
    const res = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    expect(res.agentId).toBe("scanTtl:unset");
  });
});

describe("cursor host — local agent store injection", () => {
  it("keeps Cursor ripgrep scans away from the protected canonical .git entry", async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "zeros-cursor-ripgrep-boundary-"),
    );
    try {
      const h = startHost({
        stateRoot: path.join(temporary, "private-state"),
        ripgrepBoundaryProbe: true,
      });
      await h.ready();
      const res = await h.req<{ agentId: string }>("agent.create", {
        cwd: "/w/alpha",
        local: { cwd: "/w/alpha" },
      });
      const args = JSON.parse(
        res.agentId.slice("ripgrep:".length),
      ) as string[];
      const searchPathSeparator = args.indexOf("--");
      expect(searchPathSeparator).toBeGreaterThan(0);
      expect(args.slice(0, searchPathSeparator)).toEqual(
        expect.arrayContaining([
          "--iglob",
          "!.git",
          "--iglob",
          "!**/.git",
        ]),
      );
      expect(args.slice(searchPathSeparator)).toEqual(["--", "src"]);
    } finally {
      host?.dispose();
      host = null;
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("routes Cursor's node:http2 transport through the contained HTTPS proxy", async () => {
    const connectLines: string[] = [];
    const tunnelPrefixes: Buffer[] = [];
    let resolveTunnelPrefix = () => {};
    const tunnelPrefixObserved = new Promise<void>((resolve) => {
      resolveTunnelPrefix = resolve;
    });
    const proxy: Server = createServer((socket) => {
      let request = Buffer.alloc(0);
      let connected = false;
      const captureTunnelPrefix = (bytes: Buffer) => {
        if (tunnelPrefixes.length > 0 || bytes.length < 3) return;
        tunnelPrefixes.push(bytes.subarray(0, 3));
        resolveTunnelPrefix();
        socket.destroy();
      };
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (connected) {
          captureTunnelPrefix(bytes);
          return;
        }
        request = Buffer.concat([request, bytes]);
        const marker = request.indexOf("\r\n\r\n");
        if (marker === -1) return;
        const head = request.subarray(0, marker).toString("latin1");
        connectLines.push(head.split("\r\n", 1)[0] ?? "");
        connected = true;
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        captureTunnelPrefix(request.subarray(marker + 4));
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = proxy.address();
      if (!address || typeof address === "string")
        throw new Error("test proxy has no TCP port");
      const h = startHost({
        httpsProxy: `http://127.0.0.1:${address.port}`,
        http2Target: "https://api2.cursor.invalid",
      });
      await h.ready();
      await h.req("agent.create", {
        cwd: "/w/alpha",
        local: { cwd: "/w/alpha" },
      });
      await Promise.race([
        tunnelPrefixObserved,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("test proxy saw no tunnel payload")),
            2_000,
          ),
        ),
      ]);
      expect(connectLines).toEqual([
        "CONNECT api2.cursor.invalid:443 HTTP/1.1",
      ]);
      // SRT must see a TLS ClientHello so it can terminate the exact authority
      // and substitute the masked credential. A raw HTTP/2 preface ("PRI")
      // would be opaque-tunnelled and can never receive credential injection.
      expect(tunnelPrefixes[0]?.[0]).toBe(0x16);
      expect(tunnelPrefixes[0]?.[1]).toBe(0x03);
    } finally {
      host?.dispose();
      host = null;
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("attaches a store at local.store for agent.create, rooted at the SDK's own per-workspace state root", async () => {
    const h = startHost();
    await h.ready();
    const res = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    // Not "none": the SDK must never be left to resolve its own default, which
    // is the node:sqlite default that caused the historical packaged failure.
    expect(res.agentId).toBe("create:store1@/state-root/w/alpha");
  });

  it("seeds and exclusively uses the ZSR private provider-state root", async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "zeros-cursor-host-state-"),
    );
    try {
      const workspace = path.join(temporary, "workspace");
      const source = path.join(temporary, "normal-state");
      const privateState = path.join(temporary, "private-state");
      await Promise.all([
        mkdir(workspace, { recursive: true }),
        mkdir(source, { recursive: true }),
        mkdir(privateState, { recursive: true }),
      ]);
      await writeFile(
        path.join(source, "agents.ndjson"),
        '{"agentId":"existing"}\n',
      );
      const h = startHost({
        cwd: workspace,
        stateRoot: privateState,
        defaultStateRoot: source,
      });
      await h.ready();
      expect(
        await readFile(path.join(privateState, "agents.ndjson"), "utf8"),
      ).toBe('{"agentId":"existing"}\n');
      const res = await h.req<{ agentId: string }>("agent.create", {
        cwd: workspace,
        local: { cwd: workspace },
      });
      expect(res.agentId).toBe(`create:store1@${privateState}`);
    } finally {
      host?.dispose();
      host = null;
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("attaches a store for agent.resume too — resume hits the same default-store path as create", async () => {
    const h = startHost();
    await h.ready();
    const res = await h.req<{ agentId: string }>("agent.resume", {
      agentId: "agent-1",
      opts: { cwd: "/w/alpha", local: { cwd: "/w/alpha" } },
    });
    expect(res.agentId).toBe("resume:store1@/state-root/w/alpha");
  });

  it("puts agent.list's store at the TOP level, where ListAgentsOptions takes it — not under local", async () => {
    const h = startHost();
    await h.ready();
    const res = await h.req<{ items: Array<{ top: string; nested: string }> }>(
      "agent.list",
      { opts: { runtime: "local", cwd: "/w/alpha" } },
    );
    expect(res.items[0].top).toBe("store1@/state-root/w/alpha");
    expect(res.items[0].nested).toBe("none");
  });

  it("still attaches a store to agent.list when there is NO cwd — the chat-history path that silently returned empty", async () => {
    // apps/desktop/src/engine/zeros-engine.ts passes cwd: undefined when a relay client's cwd falls
    // outside the workspace allowlist, leaving the adapter to list the SDK's
    // default location. getDefaultSdkStateRoot(undefined) throws, so the old
    // guard bailed out and left Agent.list on the node:sqlite default — which
    // failed in the historical runtime, and listSessions' catch turned that into an
    // empty chat list with no error shown.
    const h = startHost();
    await h.ready();
    const res = await h.req<{ items: Array<{ top: string; nested: string }> }>(
      "agent.list",
      { opts: { runtime: "local" } },
    );
    // Rooted at the ref the SDK itself falls back to. The host inherits this
    // process's cwd here; in production it is resolveHostCwd().
    expect(res.items[0].top).toBe(`store1@/state-root${process.cwd()}`);
  });

  it("leaves a non-local agent.list alone — a cloud listing has no local store", async () => {
    const h = startHost();
    await h.ready();
    const res = await h.req<{ items: Array<{ top: string; nested: string }> }>(
      "agent.list",
      { opts: { runtime: "cloud" } },
    );
    expect(res.items[0].top).toBe("none");
  });

  it("reuses ONE store instance per workspace — the SDK requires the same instance across calls", async () => {
    const h = startHost();
    await h.ready();
    const a = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    const b = await h.req<{ agentId: string }>("agent.resume", {
      agentId: "agent-1",
      opts: { cwd: "/w/alpha", local: { cwd: "/w/alpha" } },
    });
    expect(a.agentId).toBe("create:store1@/state-root/w/alpha");
    expect(b.agentId).toBe("resume:store1@/state-root/w/alpha");
  });

  it("keeps workspaces isolated — a different cwd gets a different store", async () => {
    const h = startHost();
    await h.ready();
    const a = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    const b = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/beta",
      local: { cwd: "/w/beta" },
    });
    expect(a.agentId).toBe("create:store1@/state-root/w/alpha");
    expect(b.agentId).toBe("create:store2@/state-root/w/beta");
  });

  it("falls back to the top-level cwd when local.cwd is absent", async () => {
    const h = startHost();
    await h.ready();
    const res = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
    });
    expect(res.agentId).toBe("create:store1@/state-root/w/alpha");
  });

  it("leaves a caller-supplied store alone", async () => {
    const h = startHost();
    await h.ready();
    // A store cannot cross the JSON bridge, so a real caller can't send one —
    // but the guard is what keeps a future in-host caller from being silently
    // overridden, so it is pinned rather than left to chance.
    const res = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: {
        cwd: "/w/alpha",
        store: { instanceId: "mine", rootDir: "/mine" },
      },
    });
    expect(res.agentId).toBe("create:mine@/mine");
  });

  it("store.open returns a live store — not the {storeId: null} that silently killed error recovery", async () => {
    const h = startHost();
    await h.ready();
    const opened = await h.req<{ storeId: string | null }>("store.open", {
      workspaceRef: "/w/alpha",
    });
    expect(opened.storeId).not.toBeNull();
  });

  it("hands store.open the SAME instance the agent writes through, so readRunError sees the agent's own rows", async () => {
    const h = startHost();
    await h.ready();
    const created = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    const opened = await h.req<{ storeId: string | null }>("store.open", {
      workspaceRef: "/w/alpha",
    });
    const doc = await h.req<{ error: string }>("store.runGet", {
      storeId: opened.storeId,
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(created.agentId).toBe("create:store1@/state-root/w/alpha");
    expect(doc.error).toBe("store1@/state-root/w/alpha");
  });

  it("keeps the store alive after a handle is disposed — the instance is shared with live agents", async () => {
    const h = startHost();
    await h.ready();
    const first = await h.req<{ storeId: string | null }>("store.open", {
      workspaceRef: "/w/alpha",
    });
    await h.req("store.dispose", { storeId: first.storeId });
    // Disposing one handle must not tear down the shared per-workspace store:
    // a later agent.create still gets store1, not a rebuilt store2.
    const res = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    expect(res.agentId).toBe("create:store1@/state-root/w/alpha");
  });
});
