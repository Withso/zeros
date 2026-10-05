import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  channel: "alpha",
  runtimeMode: "prod",
  register: vi.fn(),
  capture: vi.fn(),
  init: vi.fn(),
  onFeatureFlags: vi.fn(),
}));
vi.mock("posthog-js/dist/module.full.no-external", () => ({ default: state }));
vi.mock("@/renderer/config/release-channel", () => ({
  get CHANNEL() {
    return state.channel;
  },
}));
vi.mock("@/renderer/platform/runtime", () => ({
  isLocalDevelopment: () => false,
  isElectron: () => true,
  nativeInvoke: async () => ({
    runtimeMode: state.runtimeMode,
    version: "1.2.3",
    platform: "darwin",
    arch: "arm64",
  }),
}));
vi.mock("../consent", () => ({
  isAnalyticsOptedOut: () => false,
  setAnalyticsOptedOut: vi.fn(),
}));
vi.mock("@/renderer/platform/personal-preferences", () => ({
  subscribePreferenceCache: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  state.runtimeMode = "prod";
  vi.stubEnv("VITE_POSTHOG_KEY_PROD", "phc_synthetic_project");
});
afterEach(() => vi.unstubAllEnvs());
describe("PostHog release-channel super property", () => {
  it("uses the shared project in dev even if the legacy dev-only key is present", async () => {
    state.runtimeMode = "dev";
    state.channel = "dev";
    vi.stubEnv("VITE_POSTHOG_KEY_DEV", "phc_legacy_dev_project");
    const { initAnalytics } = await import("../posthog");
    await initAnalytics();
    expect(state.init).toHaveBeenCalledWith(
      "phc_synthetic_project",
      expect.anything(),
    );
  });
  it.each([
    ["alpha", "alpha"],
    ["beta", "beta"],
    ["stable", "production"],
    ["dev", "dev"],
  ])("tags %s as %s before any event", async (channel, expected) => {
    state.channel = channel;
    const { initAnalytics, capture } = await import("../posthog");
    capture("buffered_event");
    await initAnalytics();
    expect(state.register).toHaveBeenCalledWith(
      expect.objectContaining({
        release_channel: expected,
        app_version: "1.2.3",
      }),
    );
    expect(state.register.mock.invocationCallOrder[0]).toBeLessThan(
      state.capture.mock.invocationCallOrder[0],
    );
    expect(state.init).toHaveBeenCalledWith(
      "phc_synthetic_project",
      expect.objectContaining({
        autocapture: false,
        disable_session_recording: true,
      }),
    );
  });
});
