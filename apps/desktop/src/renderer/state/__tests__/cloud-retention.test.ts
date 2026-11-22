// Retention S3 in the app: who sees Keep, what it sends, what each refusal says, and the archived line.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspace-contract";

const h = vi.hoisted(() => ({ doc: undefined as unknown, set: vi.fn(), accept: vi.fn(), refresh: vi.fn(async () => undefined), error: vi.fn() }));
vi.mock("../cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => h.doc, acceptCloudWorkspaceDocument: h.accept, refreshCloudWorkspace: h.refresh, subscribeCloudWorkspaces: () => () => {},
}));
vi.mock("../../platform/cloud-workspaces", () => ({ setCloudWorkspaceKeep: h.set }));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: { error: h.error } }));
const { ControlPlaneError } = await import("../../features/team/control-plane");
const { cloudArchiveLineFor, cloudKeepDocument, setCloudWorkspaceKept } = await import("../cloud-retention");

const target = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const folder = `cloud://${target.organizationId}/${target.workspaceId}`;
const doc = (patch: Partial<CloudWorkspaceDocument> = {}) => ({ id: target.workspaceId, organizationId: target.organizationId, status: "in-progress",
  retention: { keep: false }, ...patch }) as CloudWorkspaceDocument;

beforeEach(() => { h.doc = undefined; for (const fn of [h.set, h.accept, h.refresh, h.error]) fn.mockClear(); });

describe("Keep in a cloud workspace's menu", () => {
  it("is offered only on a workspace that is not archived, from a server with retention, to someone who isn't a reader", () => {
    const parse = (value: unknown) => { h.doc = value; return cloudKeepDocument(folder); };
    expect(parse(doc())).not.toBeNull();
    expect(parse(doc({ retention: undefined }))).toBeNull();
    expect(parse(doc({ status: "archived" }))).toBeNull();
    // Archived but still stopping its machine: archiveReason is there already.
    expect(parse(doc({ status: "in-progress", retention: { keep: false, archiveReason: "manual" } }))).toBeNull();
    expect(parse(doc({ sharing: { readOnly: true } } as Partial<CloudWorkspaceDocument>))).toBeNull();
    expect(parse(undefined)).toBeNull();
    expect(cloudKeepDocument("/Users/me/local-folder")).toBeNull();
  });

  it("shows the server's answer: the returned document goes into the catalog, nothing is flipped first", async () => {
    const kept = doc({ retention: { keep: true } });
    h.set.mockResolvedValueOnce(kept);
    await setCloudWorkspaceKept(target, true);
    expect(h.set).toHaveBeenCalledWith(target, true);
    expect(h.accept).toHaveBeenCalledWith(kept);
    expect(h.error).not.toHaveBeenCalled();
  });

  it.each([
    [409, "keep_refused_archived", "Keep is only for a workspace that is not archived. Open it first.", "Keep is only for a workspace that is not archived. Open it first."],
    [409, "workspace_deleting", "This cloud workspace is being deleted", "This workspace is being deleted."],
    [429, "rate_limited", "Too many requests", "Too many changes to Keep."],
    [500, "internal", "x", "Couldn't keep this workspace."],
  ] as const)("on %s %s says it plainly and reads the row again", async (status, code, message, said) => {
    h.set.mockRejectedValueOnce(new ControlPlaneError(status, code, message));
    await setCloudWorkspaceKept(target, true);
    expect(h.error.mock.calls[0]![0]).toBe(said);
    expect(h.refresh).toHaveBeenCalledWith(target);
    expect(h.accept).not.toHaveBeenCalled();
  });

  it("on 404 (gone, or its server no longer runs retention) says nothing and reads the row again", async () => {
    h.set.mockRejectedValueOnce(new ControlPlaneError(404, "not_found", "Cloud workspace not found"));
    await setCloudWorkspaceKept(target, false);
    expect(h.error).not.toHaveBeenCalled();
    expect(h.refresh).toHaveBeenCalledWith(target);
  });
});

describe("an archived cloud workspace's line in the lists", () => {
  it("comes from the document, and is absent for a workspace that isn't archived or a server without retention", () => {
    h.doc = doc({ status: "archived", retention: { keep: false, archiveReason: "inactive", restores: "all" } });
    expect(cloudArchiveLineFor(folder)).toBe("Archived after 30 days without activity. Opening it restores everything.");
    h.doc = doc();
    expect(cloudArchiveLineFor(folder)).toBeNull();
    h.doc = doc({ status: "archived", retention: undefined });
    expect(cloudArchiveLineFor(folder)).toBeNull();
    expect(cloudArchiveLineFor("/Users/me/local-folder")).toBeNull();
  });
});
