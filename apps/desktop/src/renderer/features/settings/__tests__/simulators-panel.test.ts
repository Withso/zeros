import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SimulatorDevice,
  SimulatorHubSnapshot,
  SimulatorSetupStatus,
} from "@zeros/protocol/simulators";
import type { Workspace } from "../../../platform/git";
import type { SimulatorHubState } from "../../simulators/simulator-hub-store";

vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useLayoutEffect: () => {} }));

const state = vi.hoisted(() => ({
  organization: { id: "org-a", isPersonal: false } as {
    id: string;
    isPersonal: boolean;
  } | null,
  selected: "org-a" as string,
  workspace: null as Pick<Workspace, "path" | "organizationId" | "placement"> | null,
  effective: {} as Record<string, unknown>,
  sources: {} as Record<string, unknown>,
  hub: { snapshot: null, error: null, loading: false } as SimulatorHubState,
  read: vi.fn(),
  layer: vi.fn(),
  hubRead: vi.fn(),
}));
vi.mock("../../team/team-store", () => ({
  useActiveOrganization: () => state.organization,
  getActiveOrganizationIdSnapshot: () => state.selected,
}));
vi.mock("../../../state/use-active-workspace", () => ({
  useActiveWorkspace: () => ({ workspace: state.workspace }),
}));
vi.mock("../use-settings", () => ({
  useResolvedSettings: () => {
    state.read();
    return { resolved: { effective: state.effective, sources: state.sources }, refresh() {} };
  },
  useSettingsLayer: () => {
    state.layer();
    return { write: vi.fn(async () => ({})) };
  },
}));
vi.mock("../../simulators/simulator-hub-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../simulators/simulator-hub-store")>()),
  useSimulatorHub: () => {
    state.hubRead();
    return state.hub;
  },
}));
vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: vi.fn(async () => null),
  nativeListen: vi.fn(async () => () => {}),
  useNativeRuntime: () => ({ ready: false }),
}));
vi.mock("../../../platform/app", () => ({ shellOpenUrl: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements", () => ({
  toast: { error: vi.fn(), warning: vi.fn() },
}));

import { SimulatorsPanel } from "../simulators-panel";
import { workbenchSourcesFor } from "../../../shell/workbench/tab-status-model";

const PHONE: SimulatorDevice = {
  id: "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108",
  platform: "ios",
  name: "iPhone 17",
  osLabel: "iOS 27.0",
  formFactor: "phone",
  state: "shutdown",
  bootedByZeros: false,
};

function hub(setup: SimulatorSetupStatus[], devices: SimulatorDevice[] = [PHONE]): SimulatorHubState {
  const snapshot: SimulatorHubSnapshot = { version: 1, devices, setup, idleWarnings: [] };
  return { snapshot, error: null, loading: false };
}

const ios = (
  state: SimulatorSetupStatus["state"],
  download: SimulatorSetupStatus["download"] = null,
): SimulatorSetupStatus => ({ platform: "ios", state, toolLabel: "Xcode 27.0", download });

const render = () => renderToStaticMarkup(createElement(SimulatorsPanel));

beforeEach(() => {
  state.organization = { id: "org-a", isPersonal: false };
  state.selected = "org-a";
  state.workspace = {
    path: "cloud://org-a/workspace",
    organizationId: "org-a",
    placement: "cloud",
  };
  state.effective = {};
  state.sources = {};
  state.hub = { snapshot: null, error: null, loading: false };
  vi.clearAllMocks();
});

describe("Simulators settings panel", () => {
  it("does not show a transient native hub failure before its bounded retry", () => {
    state.workspace = { path: "/workspace", organizationId: "org-a", placement: "local" };
    state.hub = { snapshot: null, loading: false, error: "temporary device read failure" };
    expect(render()).not.toContain("temporary device read failure");
  });
  it("shows placement guidance for a cloud workspace without reading Local settings or devices", () => {
    const html = render();
    expect(html).toContain("Unavailable in cloud workspaces");
    expect(html).not.toContain('role="switch"');
    expect(state.read).not.toHaveBeenCalled();
    expect(state.layer).not.toHaveBeenCalled();
    expect(state.hubRead).not.toHaveBeenCalled();
  });

  it("does not flash Local controls while the organization is loading", () => {
    state.organization = null;
    state.workspace = { path: "/workspace", organizationId: "org-a", placement: "local" };
    const html = render();
    expect(html).not.toContain('role="switch"');
    expect(state.read).not.toHaveBeenCalled();
    expect(state.hubRead).not.toHaveBeenCalled();
  });

  it.each(["local", undefined] as const)(
    "offers simulator controls for an organization-local workspace (placement: %s)",
    (placement) => {
      state.workspace = { path: "/workspace", organizationId: "org-a", placement };
      const html = render();
      expect(html).toContain('id="simulators-enabled"');
      expect(html).not.toContain("Unavailable in cloud workspaces");
      expect(state.read).toHaveBeenCalledOnce();
      expect(state.layer).toHaveBeenCalledOnce();
      expect(state.hubRead).toHaveBeenCalledOnce();
    },
  );

  it("keeps organization guidance for another owner's Local workspace", () => {
    state.workspace = { path: "/workspace", organizationId: "org-b", placement: "local" };
    expect(render()).toContain("Unavailable in cloud workspaces");
    expect(state.hubRead).not.toHaveBeenCalled();
  });

  it("lets agents use simulators and show their touches by default", () => {
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    const html = render();
    expect(html).toMatch(/aria-checked="true"[^>]*id="simulators-enabled"/);
    expect(html).toMatch(/aria-checked="true"[^>]*id="simulators-show-agent-touches"/);
    expect(html).toContain('aria-label="Shut down idle simulators after"');
    expect(html).not.toContain("Managed");
  });

  it("dims touch dots while agents can't use simulators", () => {
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    state.effective = { simulators: { enabled: false } };
    const html = render();
    expect(html).toMatch(/aria-checked="false"[^>]*id="simulators-enabled"/);
    expect(html).toMatch(
      /disabled=""[^>]*id="simulators-show-agent-touches"|id="simulators-show-agent-touches"[^>]*disabled=""/,
    );
  });

  it("marks managed rows instead of offering an override", () => {
    state.organization = { id: "personal", isPersonal: true };
    state.selected = "";
    state.sources = { "simulators.enabled": "managed", "simulators.idle_shutdown": "managed" };
    const html = render();
    expect(html.match(/Managed/g)).toHaveLength(2);
    expect(html).toMatch(/disabled=""[^>]*id="simulators-enabled"|id="simulators-enabled"[^>]*disabled=""/);
  });

  describe("setup", () => {
    beforeEach(() => {
      state.organization = { id: "personal", isPersonal: true };
      state.selected = "";
    });

    it("waits for the first device read", () => {
      expect(render()).toContain("Checking for Xcode…");
    });

    it("says what is installed once everything is ready", () => {
      state.hub = hub([ios("ready")]);
      const html = render();
      expect(html).toContain("iOS Simulator");
      expect(html).toContain("Xcode and Simulator installed");
      expect(html).toContain("Xcode 27.0");
      expect(html).not.toContain("Check again");
    });

    it("links to Xcode when it is missing", () => {
      state.hub = hub([ios("tools-missing")], []);
      const html = render();
      expect(html).toContain("Xcode isn&#x27;t installed");
      expect(html).toContain("Get Xcode");
      expect(html).toContain("Check again");
    });

    it("installs a missing runtime and shows its download", () => {
      state.hub = hub([ios("runtime-missing")], []);
      expect(render()).toContain("Install iOS runtime");
      state.hub = hub([ios("runtime-missing", { state: "downloading", progress: 0.42 })], []);
      const html = render();
      expect(html).toContain("Downloading the iOS runtime… 42%");
      expect(html).toContain("Cancel");
    });

    it("offers another read when recovery confirms a persistent failure", () => {
      state.hub = { snapshot: null, error: "Zeros couldn't read the simulators.", loading: false };
      const sources = workbenchSourcesFor("read:simulator-settings-hub", "");
      sources.update("persistent", { error: new Error(state.hub.error!), pending: false });
      try {
        const html = render();
        expect(html).toContain("Zeros couldn&#x27;t read the simulators.");
        expect(html).toContain("Check again");
      } finally { sources.remove("persistent"); }
    });

    it("lists Android only once the hub reports it", () => {
      state.hub = hub([ios("ready")]);
      expect(render()).not.toContain("Android Simulator");
      state.hub = hub([
        ios("ready"),
        { platform: "android", state: "tools-missing", toolLabel: null, download: null },
      ]);
      const html = render();
      expect(html).toContain("Android Simulator");
      expect(html).toContain("Android Studio isn&#x27;t installed");
      expect(html).toContain("Get Android Studio");
    });

    it("creates the Android device setup names when there is none", () => {
      const android: SimulatorSetupStatus = {
        platform: "android",
        state: "ready",
        toolLabel: "Android Emulator 36.1.9",
        download: null,
        newDevice: "Pixel 10 with Android 17",
        creating: false,
        studioInstalled: true,
      };
      state.hub = hub([ios("ready"), android]);
      let html = render();
      expect(html).toContain("No Android simulators yet");
      expect(html).toContain("Create a Pixel 10 with Android 17");
      expect(html).toContain("Create device");
      state.hub = hub([ios("ready"), { ...android, creating: true }]);
      html = render();
      expect(html).toContain("Creating Pixel 10 with Android 17…");
      expect(html).not.toContain("Create device");
    });
  });
});
