import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ResidentPtyHost } from "../resident-host";
import { ResidentPtyClient } from "../resident-client";
const child = vi.hoisted(() => ({ exit: (_value: { exitCode: number; signal?: number }) => {}, killed: false }));
vi.mock("node-pty", () => ({ spawn: () => ({ pid: 2147483647,
  kill: () => { child.killed = true; }, pause() {}, resume() {}, resize() {}, write() {},
  onData: () => ({ dispose() {} }), onExit: (fn: typeof child.exit) => { child.exit = fn; return { dispose() {} }; },
}) }));

it.runIf(process.platform === "linux")("waits for native PTY exit before acknowledging close", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-resident-close-"));
  const organizationId = randomUUID(), workspaceId = randomUUID(), socketPath = path.join(root, "host.sock");
  const authority = { organizationId, workspaceId, engineId: randomUUID(), generation: 1, fence: 1,
    token: randomBytes(32).toString("base64url") };
  const host = new ResidentPtyHost({ root, socketPath, organizationId, workspaceId,
    shell: "/bin/bash", identity: { uid: process.getuid!(), gid: process.getgid!() } });
  const client = new ResidentPtyClient({ socketPath, authority });
  try {
    await host.start(); host.authorize(authority); await client.connect();
    const events = vi.fn(); client.events(events);
    await client.create({ sessionId: "closing", cwd: root, cols: 80, rows: 24, env: {} });
    let closed = false;
    const closing = client.close("closing").then(() => { closed = true; });
    await expect.poll(() => child.killed).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    child.exit({ exitCode: 7, signal: 15 }); await closing;
    expect(closed).toBe(true);
    expect(events).toHaveBeenCalledExactlyOnceWith({ kind: "exit", sessionId: "closing", exitCode: 7, signal: 15 });
  } finally { child.exit({ exitCode: 0 }); client.disconnect(); await host.stop(); await rm(root, { recursive: true, force: true }); }
});
