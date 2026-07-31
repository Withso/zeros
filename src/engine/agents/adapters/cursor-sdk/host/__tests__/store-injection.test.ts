// Regression for "Cursor is dead in the packaged app" (2026-07-30).
//
// @cursor/sdk 1.0.26 dropped the native `sqlite3` dep and made its DEFAULT
// local store the `node:sqlite` builtin. The host runs under the ELECTRON
// binary (electron/sidecar.ts: ZEROS_PTY_HOST_RUNTIME=process.execPath +
// ELECTRON_RUN_AS_NODE=1), and Electron 33 bundles Node 20.18 — no node:sqlite
// (it landed in 22.5). Every Agent.create threw; every attempt after the first
// in the same long-lived host reported only a causeless
// `Cannot access 'n' before initialization` TDZ.
//
// The host now hands the SDK its own JSONL store, so the default is never
// resolved. These tests pin that it is attached, in the right place, per
// workspace, and as one shared instance — driving the REAL cursor-host.cjs over
// its real protocol, with a stub SDK (fixtures/stub-cursor-sdk.cjs) standing in
// for the 3 MB package so no key or network is needed.

import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
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

  constructor() {
    this.child = spawn(process.execPath, [HOST], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ZEROS_CURSOR_SDK_ENTRY: STUB },
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
function startHost(): Host {
  host = new Host();
  return host;
}

afterEach(() => {
  host?.dispose();
  host = null;
});

describe("cursor host — local agent store injection", () => {
  it("attaches a store at local.store for agent.create, rooted at the SDK's own per-workspace state root", async () => {
    const h = startHost();
    await h.ready();
    const res = await h.req<{ agentId: string }>("agent.create", {
      cwd: "/w/alpha",
      local: { cwd: "/w/alpha" },
    });
    // Not "none": the SDK must never be left to resolve its own default, which
    // is the node:sqlite one Electron 33 cannot load.
    expect(res.agentId).toBe("create:store1@/state-root/w/alpha");
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
      local: { cwd: "/w/alpha", store: { instanceId: "mine", rootDir: "/mine" } },
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
