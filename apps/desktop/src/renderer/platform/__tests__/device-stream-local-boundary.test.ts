import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "../bridge/ws-client";
import { WorkspaceRuntimeClient, type CloudPeer } from "../bridge/workspace-runtime-client";
import { cloudWorkspaceKey } from "../bridge/cloud-workspace-key";
import type { BridgeMessage } from "../bridge/messages";

const construction = vi.hoisted(() => ({ rest: vi.fn(), stream: vi.fn(), runtime: vi.fn() }));
vi.mock("@zeros/cloud-client", async importOriginal => {
  const actual = await importOriginal<typeof import("@zeros/cloud-client")>();
  return { ...actual,
    CloudRestClient: class extends actual.CloudRestClient {
      constructor(...args: ConstructorParameters<typeof actual.CloudRestClient>) { construction.rest(); super(...args); }
    },
    DeviceStreamClient: class extends actual.DeviceStreamClient {
      constructor(...args: ConstructorParameters<typeof actual.DeviceStreamClient>) { construction.stream(); super(...args); }
    },
    connectRuntime: (...args: Parameters<typeof actual.connectRuntime>) => { construction.runtime(); return actual.connectRuntime(...args); },
  };
});

// The S3 device stream (`POST /v1/device-sessions`, `/v1/device-stream`) is
// cloud-only. Native issuance is dormant until a cloud caller explicitly opts
// in. Endpoint ownership and executable Local routing are both checked here.
const DESKTOP = join(process.cwd(), "apps", "desktop");
const ROOTS = ["src", "electron"].map(root => join(DESKTOP, root));
const DEVICE_STREAM_REFERENCE = /\/v1\/device-(?:stream|sessions)\b/;

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.test\.[a-z]+$/.test(entry)) found.push(path);
  }
  return found;
}

describe("device stream Local boundary", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  it("keeps device session endpoints inside the native cloud authority", () => {
    const files = ROOTS.flatMap(root => { try { return sources(root); } catch { return []; } });
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter(file => DEVICE_STREAM_REFERENCE.test(readFileSync(file, "utf8")))
      .map(file => relative(DESKTOP, file));
    expect(offenders).toEqual(["electron/cloud-sdk-runtime-broker.ts"]);
  });

  it.each(["/personal/local", "/organization/local"])("keeps %s routing, counts and order independent of a pending cloud admission", async folder => {
    const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
    const rows = [{ id: "local-a", folder: "/personal/local" }, { id: "local-b", folder: "/organization/local" }];
    const cloud = { id: "cloud", folder: cloudWorkspaceKey(target), placement: "cloud" };
    const local = vi.spyOn(RuntimeClient.prototype, "request").mockImplementation(async message => ({
      type: "WORKSPACE_RESPONSE", op: (message as { op?: string }).op,
      result: (message as { op?: string }).op === "workspace.list" ? { workspaces: rows } : { content: folder },
    } as BridgeMessage));
    let finish!: (peer: CloudPeer) => void;
    const opening = new Promise<CloudPeer>(resolve => { finish = resolve; });
    const open = vi.fn(async () => opening), release = vi.fn();
    const client = new WorkspaceRuntimeClient({ open, workspaces: () => [cloud], workspacesConfirmed: () => true });
    try {
      const read = () => client.request({ type: "WORKSPACE_REQUEST", op: "workspace.list", params: {} });
      const before = await read();
      expect((before as unknown as { result: { workspaces: unknown[] } }).result.workspaces).toEqual([...rows, cloud]);
      expect(open).not.toHaveBeenCalled();
      const pending = client.warmWorkspace(target).catch(() => {});
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
      for (const cwd of [folder, folder === "/personal/local" ? "/organization/local" : "/personal/local", folder]) {
        await client.request({ type: "WORKSPACE_REQUEST", op: "file.read", params: { cwd, path: "README.md" } });
        expect((await read() as unknown as { result: { workspaces: unknown[] } }).result.workspaces).toEqual([...rows, cloud]);
      }
      expect(open).toHaveBeenCalledOnce(); expect(client.executionIdentity).toMatchObject({ kind: "local" });
      expect(local.mock.calls.filter(([message]) => (message as { op?: string }).op === "file.read")).toHaveLength(3);
      expect(construction.rest).not.toHaveBeenCalled(); expect(construction.stream).not.toHaveBeenCalled(); expect(construction.runtime).not.toHaveBeenCalled();
      client.dispose(); finish({ release } as unknown as CloudPeer); await pending;
      expect(release).toHaveBeenCalledOnce();
    } finally { client.dispose(); finish({ release } as unknown as CloudPeer); }
  });
});
