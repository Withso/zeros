import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudComputerV2State } from "@zeros/protocol/cloud-computer-v2";
import {
  computerBuild,
  computerBuildId,
  computerOrg,
  computerState,
  computerUser,
} from "./cloud-computer-v2-fixtures";

const state = vi.hoisted(() => ({
  feature: true,
  role: "developer" as string | null,
  personal: false,
  snapshot: undefined as CloudComputerV2State | undefined,
  reads: [] as { key: string | null; enabled: boolean }[],
}));
// These assertions cover static state and accessibility; editor/focus effects
// are exercised by the real-browser smoke, not React's server renderer.
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});
vi.mock("../../team/team-store", () => ({
  useTeams: () => ({
    me: { user: { id: computerUser, staffRole: state.role } },
  }),
  useActiveOrganization: () => ({
    id: computerOrg,
    isPersonal: state.personal,
  }),
  getTeamStoreState: () => ({
    me: { user: { id: computerUser, staffRole: state.role } },
  }),
  getOrganizationStoreGeneration: () => 0,
}));
vi.mock("../internal-features", () => ({
  useInternalFeatureActive: (key: string) =>
    key === "cloudComputerV2" &&
    state.feature &&
    (state.role === "developer" || state.role === "platform_owner"),
}));
vi.mock("../../../platform/cloud-workspaces", () => ({
  cloudAccountRequest: vi.fn(),
}));
vi.mock("../../../state/use-cached-read", () => ({
  useCachedRead: (
    cache: unknown,
    key: string | null,
    _fetch: unknown,
    options: { enabled: boolean },
  ) => {
    state.reads.push({ key, enabled: options.enabled });
    let data: unknown;
    if (cache === cloudComputerV2Cache) data = state.snapshot;
    else if (cache === cloudComputerCache)
      data = {
        revision: 0,
        document: { repositories: [], installScript: "", timeoutSeconds: 30 },
        history: [],
        resources: { cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 },
        canManage: true,
        configured: true,
        draftVersion: 0,
      };
    else if (cache === cloudComputerV2BuildCache)
      data = state.snapshot?.latestBuild;
    else if (cache === cloudComputerV2LogsCache)
      data = { entries: [], truncated: true };
    return {
      data,
      error: null,
      loading: !data,
      refreshing: false,
      refresh: vi.fn(),
    };
  },
}));
import { cloudComputerCache } from "../cloud-computer-client";
import {
  cloudComputerV2Cache,
  cloudComputerV2BuildCache,
  cloudComputerV2LogsCache,
} from "../cloud-computer-v2-client";
import { CloudComputerV2Panel } from "../cloud-computer-v2-panel";
import { CloudComputerPanel } from "../cloud-computer-panel";

const render = (active = true) =>
  renderToStaticMarkup(
    createElement(CloudComputerV2Panel, { surfaceActive: active }),
  );
beforeEach(() => {
  state.feature = true;
  state.role = "developer";
  state.personal = false;
  state.snapshot = computerState();
  state.reads = [];
});

describe("Cloud Computer v2 settings states", () => {
  it("offers the first default build in one action and keeps the Phase D control disabled", () => {
    const html = render();
    expect(html).toContain("Not built yet");
    expect(html).toContain("Build computer");
    expect(html).toContain("Successful builds activate automatically");
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>Configure with an agent<\/button>/,
    );
    expect(html).toContain("Coming soon");
    expect(html).not.toContain(">Activate<");
  });

  it("shows progress, cursor logs and cancel while retaining the active version", () => {
    const active = computerBuild();
    const running = computerBuild({
      id: "77777777-7777-4777-8777-777777777777",
      version: 2,
      state: "running",
      stage: "install",
      templateState: "pending",
    });
    state.snapshot = computerState({
      state: "building",
      active,
      latestBuild: running,
      history: { builds: [running, active], nextCursor: null },
    });
    const html = render();
    expect(html).toContain("Active v1");
    expect(html).toContain("Building v2");
    expect(html).toContain("Installing software");
    expect(html).toContain("Step 5");
    expect(html).toContain("Cancel build");
    expect(html).toContain('role="log"');
    expect(html).toContain("Earlier output was truncated");
    expect(
      state.reads.filter((row) => row.key?.includes(running.id)),
    ).toHaveLength(2);
  });

  it("shows only retained successful history activation and retired success rebuilding", () => {
    const active = computerBuild();
    const rows = [
      active,
      computerBuild({ id: "77777777-7777-4777-8777-777777777777", version: 2 }),
      computerBuild({
        id: "88888888-8888-4888-8888-888888888888",
        version: 3,
        templateState: "retired",
      }),
      ...(["failed", "cancelled", "superseded"] as const).map((status, index) =>
        computerBuild({
          id: `99999999-9999-4999-8999-${String(index).padStart(12, "0")}`,
          version: index + 4,
          state: status,
          templateState: "retired",
        }),
      ),
    ];
    state.snapshot = computerState({
      state: "active",
      active,
      history: { builds: rows, nextCursor: "older-page" },
    });
    const html = render();
    expect(html.match(/>Activate<\/button>/g)).toHaveLength(1);
    expect(html.match(/>Rebuild<\/button>/g)).toHaveLength(1);
    expect(html).toContain("Older versions");
    for (const status of ["failed", "cancelled", "superseded"])
      expect(html).toContain(status);
  });

  it("shows server unbuilt changes, environment metadata, org sharing, and privileged build guidance", () => {
    state.snapshot = computerState({
      state: "active",
      active: computerBuild(),
      unbuiltChanges: true,
      draft: {
        ...computerState().draft,
        environment: [{ name: "EXAMPLE", set: true }],
      },
    });
    const html = render();
    expect(html).toContain("Unbuilt changes");
    expect(html).toContain(">Discard<");
    expect(html).toContain("EXAMPLE");
    expect(html).toContain(">Set<");
    expect(html).toContain("Replace");
    expect(html).toContain("without their own GitHub access");
    expect(html).toContain("root privileges");
    expect(html).not.toContain("setup script editor");
  });

  it("keeps failed and cancelled builds visible with the previous active computer", () => {
    for (const status of ["failed", "cancelled", "superseded"] as const) {
      state.snapshot = computerState({
        state: "active",
        active: computerBuild(),
        latestBuild: computerBuild({ state: status, stage: "install" }),
      });
      const html = render();
      expect(html).toContain(status);
      expect(html).toContain("The active computer is still available");
      expect(html).toContain("Build computer");
    }
  });

  it("explains safe timeout and integrity failures without dropping the active version", () => {
    for (const [code, message] of [
      ["build_timeout", "The build timed out."],
      ["integrity_failed", "Protected file verification failed."],
    ] as const) {
      state.snapshot = computerState({
        state: "active",
        active: computerBuild(),
        latestBuild: computerBuild({
          state: "failed",
          stage: "integrity",
          errorCode: code,
        }),
      });
      const html = render();
      expect(html).toContain(message);
      expect(html).toContain("Checking protected files");
      expect(html).toContain("Active v1");
    }
  });

  it("retains hidden state while disabling all controls and every read", () => {
    const build = computerBuild({ state: "running", stage: "install" });
    state.snapshot = computerState({
      state: "building",
      latestBuild: build,
      history: { builds: [build], nextCursor: null },
    });
    const html = render(false);
    expect(html).toContain('inert=""');
    expect(html).toContain('aria-hidden="true"');
    expect(
      [...html.matchAll(/<button\b[^>]*>/g)].every(([button]) =>
        button.includes("disabled"),
      ),
    ).toBe(true);
    expect(state.reads.every((row) => !row.enabled)).toBe(true);
  });

  it("requires the effective staff gate and a collaborative org before mounting any v2 read", () => {
    for (const role of [null, "support_admin"]) {
      state.role = role;
      state.reads = [];
      expect(render()).toBe("");
      expect(state.reads).toEqual([]);
    }
    state.role = "developer";
    state.feature = false;
    expect(render()).toBe("");
    state.feature = true;
    state.personal = true;
    expect(render()).toBe("");
  });

  it("preserves the legacy panel when the internal feature is off", () => {
    state.feature = false;
    const html = renderToStaticMarkup(createElement(CloudComputerPanel));
    expect(html).toContain("System and runtime files are read-only");
    expect(html).toContain("Each member must have their own GitHub access");
    expect(html).not.toContain("Configure with an agent");
    expect(
      state.reads.filter((row) => row.enabled).map((row) => row.key),
    ).toEqual([JSON.stringify([computerUser, computerOrg])]);
    expect(html).not.toContain(computerBuildId);
  });
});
