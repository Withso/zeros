import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import {
  CLOUD_RUNTIME_ACCESS_ERRORS,
  CloudRuntimeAccessError,
} from "../../../platform/bridge/cloud-runtime-access-error";
import { TAB_TYPE_META, type WorkbenchTabType } from "../tab-model";
import { WorkbenchTabFrame } from "../tab-status";
import {
  describeWorkspaceAvailability,
  workbenchSourcesFor,
  workbenchStatusKey,
  type WorkbenchStatusSources,
  type WorkspaceAvailability,
} from "../tab-status-model";

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

const cloud = cloudWorkspaceKey({
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
});
const owners = ["/local/personal", "/local/organization", cloud];
const stores = new Set<WorkbenchStatusSources>();
function frame(type: WorkbenchTabType, folder = cloud) {
  const tab = { id: `availability-${type}`, type, title: type };
  const sources = workbenchSourcesFor(workbenchStatusKey(folder, tab), folder);
  stores.add(sources);
  return {
    sources,
    render: () => renderToStaticMarkup(createElement(WorkbenchTabFrame, {
      tab, folder, active: true, children: createElement("span", null, "Confirmed content"),
    })),
  };
}
const bannerTag = (markup: string) => markup.match(/<div data-workbench-banner=""[^>]*>/)?.[0];
afterEach(() => {
  for (const sources of stores) for (const id of ["body", "other", "notice"]) sources.remove(id);
  stores.clear();
  fixture.availability = { cloud: true, connection: "connected", since: 0 };
  fixture.now = 60_000;
  vi.useRealTimers();
});

describe("cloud workbench banner ownership", () => {
  it.each(Object.keys(TAB_TYPE_META) as WorkbenchTabType[])(
    "keeps %s free of cloud lifecycle and connection banners, with or without cached content",
    (type) => {
      const view = frame(type);
      const states: Partial<WorkspaceAvailability>[] = [
        ...["creating", "provisioning", "setting_up", "starting", "waking", "restoring", "stopping", "stopped", "sleeping", "archived", "failed", "error", "deleting", "deleted"].map(state => ({ state })),
        { state: "stopped", canWake: false },
        { state: "stopped", stopError: { code: "cloud_workspace_safety_failure", message: "Managed compute stopped after a safety check failed" } },
        { rejected: true },
        { previouslyConnected: true },
        {},
      ];
      for (const hasContent of [false, true]) {
        view.sources.update("body", { primary: true, pending: false, hasContent });
        for (const state of states) for (const now of [0, 10_000, 45_000, 60_000]) {
          fixture.availability = { cloud: true, connection: "disconnected", since: 0, ...state };
          fixture.now = now;
          const markup = view.render();
          expect(bannerTag(markup), JSON.stringify({ state, now, hasContent })).toContain('hidden=""');
          expect(markup).not.toContain("Retry loading");
          expect(markup).not.toContain("Retry to");
          if (hasContent) {
            expect(markup).not.toContain("data-workbench-empty");
            expect(markup).not.toContain('inert=""');
          }
        }
      }
    },
  );

  it.each(owners)("keeps tab-specific failures and recovery for %s", folder => {
    fixture.availability = { cloud: folder === cloud, connection: "connected", since: 0 };
    for (const type of Object.keys(TAB_TYPE_META) as WorkbenchTabType[]) {
      const view = frame(type, folder);
      for (const error of ["EACCES: permission denied", "Git fetch failed: connection reset", "Request timeout: WORKSPACE_REQUEST", "Could not read cloud-config.json"]) {
        view.sources.update("body", { primary: true, pending: false, error });
        const markup = view.render();
        expect(bannerTag(markup)).not.toContain('hidden=""');
        expect(markup).toContain('data-tone="error"');
        expect(markup).toContain("Retry loading");
        expect(markup).toContain("data-workbench-empty");
      }
      view.sources.update("body", { primary: true, pending: false, hasContent: true });
      expect(bannerTag(view.render())).toContain('hidden=""');
      expect(view.render()).not.toContain("data-workbench-empty");
    }
  });

  it.each(owners.slice(0, 2))("retains engine failure banners for %s", folder => {
    fixture.availability = { cloud: false, connection: "disconnected", since: 0 };
    const markup = frame("files", folder).render();
    expect(bannerTag(markup)).not.toContain('hidden=""');
    expect(markup).toContain("Zeros engine.");
    expect(markup).toContain("Retry loading files");
  });

  it.each(owners.slice(0, 2))("retains transport read failures after reconnecting %s", folder => {
    fixture.availability = { cloud: false, connection: "connected", since: 0 };
    const view = frame("files", folder);
    for (const error of ["Request timeout: engine disconnected", "Engine swapping — request aborted", "Client disposed"]) {
      view.sources.update("body", { primary: true, pending: false, hasContent: true, error });
      const markup = view.render();
      expect(bannerTag(markup)).not.toContain('hidden=""');
      expect(markup).toContain("Retry loading files");
      expect(markup).not.toContain("data-workbench-empty");
    }
  });

  const connectionErrors = [
    "Cloud workspace is setting_up. Wait for setup",
    "Cloud workspace is sleeping",
    "Cloud workspace is disconnected; reconnect before sending this action",
    "Request timeout: engine disconnected",
    "Request timeout: WORKSPACE_REQUEST (reconnecting)",
    "Request timeout: WORKSPACE_REQUEST (queue full)",
    "Cloud connection changed while the request was running",
    "The cloud workspace did not start in time",
    "Cloud connection cancelled",
    "Cloud connection returned a different workspace",
    "Cloud workspace did not confirm its checkout",
    "Cloud workspace generation changed during admission",
    "Cloud workspace transport is busy",
    "Cloud account changed before dispatch",
    "Cloud account changed before the response arrived",
    "Runtime execution identity changed while connecting",
    "Runtime connection rejected",
    "Client disposed",
    "Engine swapping — request aborted",
    ...Object.values(CLOUD_RUNTIME_ACCESS_ERRORS).map(error => error.message),
    ...Object.keys(CLOUD_RUNTIME_ACCESS_ERRORS).map(code => new CloudRuntimeAccessError({ code, status: 503 })),
  ];
  it.each(connectionErrors)("does not repackage cloud infrastructure failure %s as a tab error", error => {
    const view = frame("files");
    view.sources.update("body", { primary: true, pending: false, hasContent: true, error });
    expect(bannerTag(view.render())).toContain('hidden=""');
    // Filtering the primary connection error must not swallow another read's real failure.
    view.sources.update("other", { pending: false, error: "File permission denied" });
    expect(view.sources.snapshot().failure).toBe("File permission denied");
    expect(bannerTag(view.render())).not.toContain('hidden=""');
    expect(view.render()).not.toContain("data-workbench-empty");
  });

  it("still retries a cloud transport read once without displaying its failure", async () => {
    vi.useFakeTimers();
    const view = frame("files");
    const retry = vi.fn(async () => {});
    view.sources.update("body", { primary: true, pending: false, error: "Cloud workspace is disconnected", retry });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(bannerTag(view.render())).toContain('hidden=""');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps feature notices and exact-owner errors when switching Local → cloud → Local", () => {
    const local = frame("changes", owners[0]);
    const remote = frame("changes");
    local.sources.update("body", { primary: true, pending: false, error: "Local Git read failed" });
    remote.sources.update("body", { primary: true, pending: false, hasContent: true });
    remote.sources.update("notice", { pending: false, notice: { tone: "neutral", message: "Shallow Git history" } });
    fixture.availability = { cloud: false, connection: "connected", since: 0 };
    expect(bannerTag(local.render())).not.toContain('hidden=""');
    fixture.availability = { cloud: true, connection: "connected", since: 0 };
    expect(remote.render()).toContain("Shallow Git history");
    expect(remote.render()).not.toContain("Local Git read failed");
    fixture.availability = { cloud: false, connection: "connected", since: 0 };
    expect(local.render()).toContain("Local Git read failed");
    expect(local.render()).not.toContain("Shallow Git history");
  });
});
