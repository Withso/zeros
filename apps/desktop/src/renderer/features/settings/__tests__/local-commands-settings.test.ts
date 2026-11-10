// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ always: false, org: true, writes: [] as unknown[] }));
vi.mock("../../../platform/runtime", async original => ({ ...await original<typeof import("../../../platform/runtime")>(), isElectron: () => true }));
vi.mock("../../../platform/local-commands", () => ({
  getAlwaysAllowLocalCommands: async () => state.always,
  setAlwaysAllowLocalCommands: async (value: boolean) => { state.writes.push(["always", value]); state.always = value; return value; },
  readLocalCommandsEnabled: async () => state.org,
  writeLocalCommandsEnabled: async (_org: string, value: boolean) => { state.writes.push(["org", value]); state.org = value; return value; },
}));
import { AlwaysAllowLocalCommands, OrganizationLocalCommands } from "../local-commands-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: Array<{ unmount(): void }> = [];
afterEach(() => act(() => roots.splice(0).forEach(root => root.unmount())));
beforeEach(() => { state.always = false; state.org = true; state.writes = []; });
async function mount(element: ReturnType<typeof createElement>) {
  const node = document.createElement("div"); const root = createRoot(node); roots.push(root);
  await act(async () => { root.render(element); });
  return node;
}
const toggle = (node: HTMLElement, name: string) => node.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${name}"]`)!;

describe("local command settings", () => {
  it("reads this Mac's Always allow from main and writes it back", async () => {
    const node = await mount(createElement(AlwaysAllowLocalCommands, { surfaceActive: true }));
    expect(toggle(node, "Always allow local commands").getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle(node, "Always allow local commands").click(); });
    expect(state.writes).toEqual([["always", true]]);
    expect(toggle(node, "Always allow local commands").getAttribute("aria-checked")).toBe("true");
  });

  it("lets owners and admins change the organization switch, and shows members its value read-only", async () => {
    const admin = await mount(createElement(OrganizationLocalCommands, { organizationId: "22222222-2222-4222-8222-222222222222", canChange: true, surfaceActive: true }));
    await act(async () => { toggle(admin, "Local commands").click(); });
    expect(state.writes).toEqual([["org", false]]);
    const member = await mount(createElement(OrganizationLocalCommands, { organizationId: "22222222-2222-4222-8222-222222222222", canChange: false, surfaceActive: true }));
    expect(toggle(member, "Local commands").disabled).toBe(true);
    expect(member.textContent).toContain("Organization owners and admins change this.");
  });
});
