import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import type { DesignCatalogRead } from "@zeros/protocol/design-catalog";
import type { DesignWorkspaceSnapshotWire } from "../../../platform/bridge/design-bridge";
const active = vi.hoisted(() => ({ bridge: null as RuntimeClient | null }));
vi.mock("../../../platform/bridge/active-bridge", () => ({ getActiveBridge: () => active.bridge }));
import { readDesignNavigation } from "../state/design-workspace-preparation";

afterEach(() => { active.bridge = null; });
function fixture(organizationId: string | null = null) {
  const owner = { workspaceId: "local", directoryId: "design_test", organizationId, placement: "local" as const };
  const page = { id: "page", title: "Page", folder: "page", frameFiles: ["page/f0.html"], frameIds: ["f0"] };
  const snapshot: DesignWorkspaceSnapshotWire = { directoryId: owner.directoryId, protocolCapability: null, pages: [page],
    frames: [], tokens: [], assets: [], tokenSourceVersion: "tokens", lint: { workspacePath: "/local", checkedFiles: [], violations: [], healedOids: 0 } };
  const bootstrap = { owner, snapshot, catalogRevision: "a".repeat(64) };
  const catalog = (intent: number) => ({ kind: "design-catalog", version: 1, status: "ready", owner, intent, binding: "b".repeat(64),
    revision: bootstrap.catalogRevision, pages: [{ id: page.id, title: page.title, folder: page.folder, count: 1 }],
    total: 1, offset: 0, coverage: "complete", nextCursor: null, frames: [{ id: "f0", pageId: "page", source: "page/f0.html", title: "Frame",
      kind: "html", x: 0, y: 0, width: 100, height: 100, z: 0, order: 0, preparation: "unprepared" }] });
  const request = vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: bootstrap }));
  const requestConnected = vi.fn(async ({ params }: { params: DesignCatalogRead }) => ({ type: "WORKSPACE_RESPONSE", op: "design.catalog.read", result: catalog(params.intent) }));
  let status!: (value: string) => void;
  active.bridge = { supportsEngineCapability: () => true, request, requestConnected,
    onStatusChange: (listener: typeof status) => { status = listener; return vi.fn(); } } as unknown as RuntimeClient;
  return { request, requestConnected, bootstrap, snapshot, catalog, status: (value: string) => status(value) };
}
it.each([null, "organization-local"])("opens metadata for owner %s without source generations", async (organizationId) => {
  const f = fixture(organizationId);
  const result = await readDesignNavigation("local");
  expect(result?.frames).toEqual([]);
  expect(result?.preparation?.descriptions).toMatchObject([{ file: "page/f0.html", preparation: "unprepared" }]);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.requestConnected).toHaveBeenCalledTimes(1);
});
it("revalidates same-revision source authority and keeps only same-owner cover pixels", async () => {
  const f = fixture();
  const previous = { ...f.snapshot, frames: [{ file: "page/f0.html", frameId: "f0", pageId: "page", title: "Old", x: 0, y: 0,
    width: 100, height: 100, z: 0, sourceVersion: "c".repeat(24), nodeCount: 1, modifiedAt: 0 }] };
  const result = await readDesignNavigation("local", previous);
  expect(result?.frames[0]).toBe(previous.frames[0]);
  expect(result?.preparation?.current).toEqual([]);
  expect((await readDesignNavigation("local", { ...previous, directoryId: "design_other" }))?.frames).toEqual([]);
});
it("retries incoherent bootstrap/catalog metadata once without falling back to an aggregate scan", async () => {
  const f = fixture();
  f.requestConnected.mockImplementation(async ({ params }) => ({ type: "WORKSPACE_RESPONSE", op: "design.catalog.read", result: { ...f.catalog(params.intent), revision: "c".repeat(64) } }));
  await expect(readDesignNavigation("local")).rejects.toThrow(/changed/);
  expect(f.request).toHaveBeenCalledTimes(2);
  expect(f.requestConnected).toHaveBeenCalledTimes(2);
});
it("allows legacy/unsettled fallback, but transport loss never authorizes it", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", result: { unavailable: "unsupported-layout" } } as never);
  expect(await readDesignNavigation("local")).toBeNull();
  f.request.mockResolvedValueOnce({ type: "WORKSPACE_RESPONSE", result: { unavailable: "unsettled" } } as never);
  expect(await readDesignNavigation("local")).toBeNull();
  f.request.mockRejectedValueOnce(new Error("disconnected"));
  await expect(readDesignNavigation("local")).rejects.toThrow(/disconnected/);
  expect(f.requestConnected).not.toHaveBeenCalled();
});
it("rejects a retired connection and sends no Cloud Design requests", async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => { f.status("disconnected"); return { type: "WORKSPACE_RESPONSE", result: f.bootstrap }; });
  await expect(readDesignNavigation("local")).rejects.toThrow();
  expect(f.requestConnected).not.toHaveBeenCalled();
  f.request.mockClear();
  expect(await readDesignNavigation("cloud://org/workspace")).toBeNull();
  expect(f.request).not.toHaveBeenCalled();
});

it("refuses incoherent page membership even when a peer repeats the same revision", async () => {
  const f = fixture();
  f.bootstrap.snapshot.pages![0]!.frameFiles = ["page/other.html"];
  await expect(readDesignNavigation("local")).rejects.toThrow(/membership/);
});
