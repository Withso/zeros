import { beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({
  generation: 1,
  values: new Map<string, boolean>(),
  calls: [] as Array<{ path: string; method?: string; body?: unknown }>,
  hold: undefined as undefined | Promise<void>,
  fail: false,
}));
vi.mock("../../team/team-store", () => ({ getOrganizationStoreGeneration: () => control.generation }));
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAccountRequest: async (path: string, schema: { parse(value: unknown): unknown }, input?: { body: { workspaceApiAccess: boolean }; method?: string }) => {
    control.calls.push({ path, ...(input ? { method: input.method, body: input.body } : {}) });
    await control.hold;
    if (control.fail) throw new Error("unavailable");
    const organization = /organizations\/([^/]+)\/api-access/.exec(path)![1];
    if (input) control.values.set(organization, input.body.workspaceApiAccess);
    return schema.parse({ workspaceApiAccess: control.values.get(organization) ?? true });
  },
}));
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceApiAccessSetting, showsWorkspaceApiAccess } from "../workspace-api-access-setting";
import { clearWorkspaceApiAccess, loadWorkspaceApiAccess, saveWorkspaceApiAccess, workspaceApiAccessSnapshot } from "../workspace-api-access";

const A = "11111111-1111-4111-8111-111111111111", B = "33333333-3333-4333-8333-333333333333";
beforeEach(() => {
  control.generation = 1; control.values = new Map(); control.calls = []; control.hold = undefined; control.fail = false;
  clearWorkspaceApiAccess();
});

describe("workspace API access setting", () => {
  it("reads and writes the organization's own route, defaulting to on", async () => {
    await expect(loadWorkspaceApiAccess(A)).resolves.toBe(true);
    await saveWorkspaceApiAccess(A, false);
    expect(control.calls).toEqual([
      { path: `/v1/cloud-v2/organizations/${A}/api-access` },
      { path: `/v1/cloud-v2/organizations/${A}/api-access`, method: "PUT", body: { workspaceApiAccess: false } },
    ]);
    expect(workspaceApiAccessSnapshot(A)).toMatchObject({ value: false, saving: false, failed: false });
  });

  it("shares a read in flight and keeps the last confirmed value while it revalidates", async () => {
    await loadWorkspaceApiAccess(A);
    let release!: () => void; control.hold = new Promise(resolve => { release = resolve; });
    const [first, second] = [loadWorkspaceApiAccess(A), loadWorkspaceApiAccess(A)];
    expect(workspaceApiAccessSnapshot(A).value).toBe(true);
    release(); await Promise.all([first, second]);
    expect(control.calls.filter(call => !call.method)).toHaveLength(2);
  });

  it("keeps each organization's value apart through A → B → A, and a late read cannot undo a newer write", async () => {
    control.values.set(B, false);
    await loadWorkspaceApiAccess(A); await loadWorkspaceApiAccess(B);
    expect([workspaceApiAccessSnapshot(A).value, workspaceApiAccessSnapshot(B).value]).toEqual([true, false]);
    let release!: () => void; control.hold = new Promise(resolve => { release = resolve; });
    const reading = loadWorkspaceApiAccess(A);
    control.hold = undefined;
    await saveWorkspaceApiAccess(A, false);
    control.values.set(A, true); release(); await reading;
    expect(workspaceApiAccessSnapshot(A).value).toBe(false);
    expect(workspaceApiAccessSnapshot(B).value).toBe(false);
  });

  it("shows a write at once and reverts it when the server refuses", async () => {
    await loadWorkspaceApiAccess(A);
    control.fail = true;
    const saving = saveWorkspaceApiAccess(A, false);
    expect(workspaceApiAccessSnapshot(A)).toMatchObject({ value: false, saving: true });
    await expect(saving).rejects.toThrow();
    expect(workspaceApiAccessSnapshot(A)).toMatchObject({ value: true, saving: false });
  });

  it("forgets every value when the account changes", async () => {
    await loadWorkspaceApiAccess(A);
    control.generation = 2;
    expect(workspaceApiAccessSnapshot(A).value).toBeUndefined();
    control.fail = true;
    await expect(loadWorkspaceApiAccess(A)).rejects.toThrow();
    expect(workspaceApiAccessSnapshot(A)).toMatchObject({ value: undefined, failed: true });
  });
});

describe("workspace API access row", () => {
  it("appears for a cloud organization the account may use, never for the Local owner, an organization without cloud, or a paused account", () => {
    expect(showsWorkspaceApiAccess({ isPersonal: false, workspaceCapabilities: { cloud: true } }, true)).toBe(true);
    expect(showsWorkspaceApiAccess({ isPersonal: true, workspaceCapabilities: { cloud: true } }, true)).toBe(false);
    expect(showsWorkspaceApiAccess({ isPersonal: false, workspaceCapabilities: { cloud: false } }, true)).toBe(false);
    expect(showsWorkspaceApiAccess({ isPersonal: false }, true)).toBe(false);
    expect(showsWorkspaceApiAccess({ isPersonal: false, workspaceCapabilities: { cloud: true } }, false)).toBe(false);
    expect(showsWorkspaceApiAccess(undefined, true)).toBe(false);
  });

  it("renders one labelled switch, disabled until the organization's value is known", async () => {
    const before = renderToStaticMarkup(createElement(WorkspaceApiAccessSetting, { organizationId: A, surfaceActive: false }));
    expect(before).toContain("Workspace API access");
    expect(before).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/);
    await loadWorkspaceApiAccess(A);
    const after = renderToStaticMarkup(createElement(WorkspaceApiAccessSetting, { organizationId: A, surfaceActive: false }));
    expect(after).toContain('aria-checked="true"');
    expect(after).not.toMatch(/role="switch"[^>]*disabled=""/);
  });
});
