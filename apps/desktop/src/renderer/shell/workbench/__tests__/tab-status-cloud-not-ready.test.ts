import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { WorkbenchTabFrame } from "../tab-status";
import {
  describeWorkspaceAvailability,
  describeWorkspaceRuntimeStatus,
  workbenchSourcesFor,
  workbenchStatusKey,
  type WorkbenchStatusSources,
  type WorkspaceAvailability,
} from "../tab-status-model";
import type { WorkbenchTabType } from "../tab-model";

const fixture = vi.hoisted(() => ({
  availability: { cloud: true, connection: "connected", since: 0 } as WorkspaceAvailability,
  now: 60_000,
}));
vi.mock("../../../state/workbench-availability", () => ({
  useWorkbenchAvailability: () => ({
    availability: fixture.availability,
    status: describeWorkspaceAvailability(fixture.availability, fixture.now),
    visible: true,
  }),
  registerWorkbenchFrameVisibility: () => () => {},
  reconnectWorkbenchWorkspace: vi.fn(),
}));

const cloud = cloudWorkspaceKey({ organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" });
const stores = new Set<WorkbenchStatusSources>();
function render(type: WorkbenchTabType, folder = cloud, filePath?: string) {
  const tab = { id: `not-ready-${type}`, type, title: type, ...(filePath ? { filePath } : {}) };
  const sources = workbenchSourcesFor(workbenchStatusKey(folder, tab), folder);
  stores.add(sources);
  sources.update("body", { primary: true, pending: false, hasContent: false });
  return renderToStaticMarkup(createElement(WorkbenchTabFrame, { tab, folder, active: true, children: createElement("span", null, "Confirmed content") }));
}
afterEach(() => {
  for (const sources of stores) sources.remove("body");
  stores.clear();
  fixture.availability = { cloud: true, connection: "connected", since: 0 };
  fixture.now = 60_000;
});

// Owner ruling 2026-11-13: one simple empty state, the tab's icon and one line, for every not-ready cloud case.
const LINES = {
  files: "Files appear when the workspace is ready.",
  changes: "Changes appear when the workspace is ready.",
  terminal: "Terminal appears when the workspace is ready.",
  review: "Review comments appear when the workspace is ready.",
} as const;
const NOT_READY: Partial<WorkspaceAvailability>[] = [
  { state: "setting_up" }, { state: "starting" }, { state: "waking" }, { state: "stopping" }, { state: "stopped" },
  { state: "stopped", canWake: false }, { state: "archived" }, { state: "failed" },
  // Connecting, reconnecting, and a connection that keeps failing (the w-3 inbound-route outage), with and without the prompt outbox.
  { state: "ready" }, { state: "ready", previouslyConnected: true }, { state: "ready", rejected: true },
  { state: "ready", messagesWithoutLive: true }, { state: "busy", rejected: true, messagesWithoutLive: true },
];

describe("cloud not-ready empty state", () => {
  it.each(Object.keys(LINES) as (keyof typeof LINES)[])("%s shows its icon and one line in every not-ready cloud case", type => {
    for (const state of NOT_READY) for (const now of [15_000, 60_000]) {
      fixture.availability = { cloud: true, connection: "disconnected", since: 0, ...state };
      fixture.now = now;
      const markup = render(type);
      expect(markup, JSON.stringify(state)).toContain("data-workbench-empty");
      expect(markup).toContain("<svg");
      expect(markup, JSON.stringify({ state, now })).toContain(LINES[type]);
      for (const other of Object.values(LINES)) if (other !== LINES[type]) expect(markup).not.toContain(other);
      for (const old of ["aren't available", "isn't available", "Retry", "reconnects automatically", "Open the cloud workspace"]) expect(markup).not.toContain(old);
    }
  });

  it("a single file says the same, and a tab's own read failure keeps its copy", () => {
    fixture.availability = { cloud: true, connection: "disconnected", since: 0, state: "stopped" };
    const file = render("files", cloud, "src/index.ts");
    expect(file).toContain("This file appears when the workspace is ready.");
    expect(file).not.toContain(LINES.files);
    fixture.availability = { cloud: true, connection: "connected", since: 0, state: "ready" };
    const sources = workbenchSourcesFor(workbenchStatusKey(cloud, { id: "not-ready-files", type: "files", title: "files" }), cloud);
    stores.add(sources);
    sources.update("body", { primary: true, pending: false, error: "EACCES: permission denied" });
    expect(renderToStaticMarkup(createElement(WorkbenchTabFrame, { tab: { id: "not-ready-files", type: "files", title: "files" }, folder: cloud, active: true,
      children: createElement("span") }))).toContain("Retry to load files.");
  });

  it("Local keeps its own empty states", () => {
    fixture.availability = { cloud: false, connection: "disconnected", since: 0 };
    expect(render("terminal", "/local/repo")).toContain("Retry to reconnect the terminal.");
  });

  it("a running cloud workspace whose connection keeps failing reads as connecting, not Needs attention", () => {
    const failing = { cloud: true, state: "ready", connection: "disconnected", since: 0, messagesWithoutLive: true } as WorkspaceAvailability;
    expect(describeWorkspaceRuntimeStatus(failing, 60_000)).toBe("Connecting…");
    expect(describeWorkspaceRuntimeStatus({ ...failing, rejected: true }, 60_000)).toBe("Connecting…");
    expect(describeWorkspaceRuntimeStatus({ ...failing, previouslyConnected: true }, 60_000)).toBe("Reconnecting…");
    // A definitive refusal, a worker without the prompt outbox, and Local keep today's answer.
    expect(describeWorkspaceRuntimeStatus({ ...failing, rejected: true, refused: true }, 60_000)).toBe("Needs attention");
    expect(describeWorkspaceRuntimeStatus({ ...failing, messagesWithoutLive: undefined }, 60_000)).toBe("Needs attention");
    expect(describeWorkspaceRuntimeStatus({ cloud: false, connection: "disconnected", since: 0 }, 60_000)).toBe("Needs attention");
  });
});
