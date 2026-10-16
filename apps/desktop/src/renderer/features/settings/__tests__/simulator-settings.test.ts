import { describe, expect, it } from "vitest";
import { SIMULATOR_IDLE_SHUTDOWN_CHOICES } from "@zeros/protocol/simulators";

import {
  SIMULATOR_IDLE_SHUTDOWN_OPTIONS,
  SIMULATOR_SETTINGS_ROWS,
  simulatorPreferencesFromEffective,
  simulatorSettingIsManaged,
  simulatorSettingPatch,
  simulatorSettingSnapshotSupersedesPending,
  simulatorSettingsFromEffective,
  simulatorToolRouteFromEffective,
} from "../simulator-settings";

const OPEN = { simulators: true };
const CLOSED = { simulators: false };

describe("Simulator settings", () => {
  it("lets agents use simulators and shuts idle ones down after 30 minutes by default", () => {
    const defaults = { agentsEnabled: true, idleShutdown: "30m", showAgentTouches: true };
    expect(simulatorPreferencesFromEffective(null, OPEN)).toEqual(defaults);
    expect(simulatorPreferencesFromEffective({}, OPEN)).toEqual(defaults);
    expect(simulatorPreferencesFromEffective({ simulators: "off" }, OPEN)).toEqual(defaults);
    expect(simulatorToolRouteFromEffective({}, OPEN)).toBe("zeros");
  });

  it("passes the resolved values to DeviceHub", () => {
    const effective = {
      simulators: { enabled: false, idle_shutdown: "2h", show_agent_touches: false },
    };
    expect(simulatorSettingsFromEffective(effective)).toEqual(effective.simulators);
    expect(simulatorPreferencesFromEffective(effective, OPEN)).toEqual({
      agentsEnabled: false,
      idleShutdown: "2h",
      showAgentTouches: false,
    });
    expect(simulatorToolRouteFromEffective(effective, OPEN)).toBe("off");
  });

  it("gives agents no simulators while simulators are not available", () => {
    expect(simulatorPreferencesFromEffective({}, CLOSED)).toEqual({
      agentsEnabled: false,
      idleShutdown: "30m",
      showAgentTouches: true,
    });
    expect(simulatorToolRouteFromEffective({}, CLOSED)).toBe("off");
  });

  it("keeps row copy short", () => {
    for (const row of Object.values(SIMULATOR_SETTINGS_ROWS)) {
      expect(row.hint.length).toBeLessThanOrEqual(96);
    }
    expect(SIMULATOR_SETTINGS_ROWS.enabled.label).toBe("Let agents use simulators");
    expect(SIMULATOR_SETTINGS_ROWS.idle_shutdown.label).toBe("Shut down idle simulators after");
    expect(SIMULATOR_SETTINGS_ROWS.show_agent_touches.label).toBe("Show agent touches");
  });

  it("offers every idle shutdown choice, shortest first", () => {
    expect(SIMULATOR_IDLE_SHUTDOWN_OPTIONS.map((option) => option.value)).toEqual([
      ...SIMULATOR_IDLE_SHUTDOWN_CHOICES,
    ]);
    expect(SIMULATOR_IDLE_SHUTDOWN_OPTIONS.map((option) => option.label)).toEqual([
      "15 minutes",
      "30 minutes",
      "1 hour",
      "2 hours",
      "Never",
    ]);
  });

  it("writes one key at a time", () => {
    expect(simulatorSettingPatch("enabled", false)).toEqual({ simulators: { enabled: false } });
    expect(simulatorSettingPatch("idle_shutdown", "never")).toEqual({
      simulators: { idle_shutdown: "never" },
    });
    expect(simulatorSettingPatch("show_agent_touches", true)).toEqual({
      simulators: { show_agent_touches: true },
    });
  });

  it("recognizes managed simulator leaves", () => {
    expect(simulatorSettingIsManaged({ "simulators.enabled": "managed" }, "enabled")).toBe(true);
    expect(simulatorSettingIsManaged({ "simulators.enabled": "user" }, "enabled")).toBe(false);
    expect(
      simulatorSettingIsManaged({ "simulators.idle_shutdown": "managed" }, "idle_shutdown"),
    ).toBe(true);
    expect(simulatorSettingIsManaged(undefined, "show_agent_touches")).toBe(false);
  });

  it("ignores an older write broadcast and yields to a matching or managed snapshot", () => {
    const baseline = {};
    const resolved = (simulators: Record<string, unknown>, source = "user") => ({
      effective: { simulators },
      sources: Object.fromEntries(
        Object.keys(simulators).map((key) => [`simulators.${key}`, source]),
      ),
    });
    const supersedes = (
      overrides: Partial<Parameters<typeof simulatorSettingSnapshotSupersedesPending>[0]>,
    ) =>
      simulatorSettingSnapshotSupersedesPending({
        key: "idle_shutdown",
        value: "1h",
        settled: true,
        baseline,
        resolved: resolved({ idle_shutdown: "1h" }),
        ...overrides,
      });
    expect(supersedes({})).toBe(true);
    expect(supersedes({ resolved: resolved({ idle_shutdown: "15m" }) })).toBe(false);
    expect(supersedes({ resolved: resolved({ idle_shutdown: "15m" }, "managed") })).toBe(true);
    expect(supersedes({ settled: false })).toBe(false);
    expect(supersedes({ resolved: baseline })).toBe(false);
    expect(supersedes({ resolved: null })).toBe(false);
    expect(
      simulatorSettingSnapshotSupersedesPending({
        key: "enabled",
        value: false,
        settled: true,
        baseline,
        resolved: resolved({ enabled: false }),
      }),
    ).toBe(true);
  });
});
