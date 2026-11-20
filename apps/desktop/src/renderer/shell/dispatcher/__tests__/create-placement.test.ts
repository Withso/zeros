import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../../platform/settings", () => ({
  getSetting: (key: string, fallback: unknown) => (values.has(key) ? values.get(key) : fallback),
  setSetting: (key: string, value: unknown) => values.set(key, value),
}));

import { rememberCreatePlacement, resolveCreatePlacement } from "../create-placement";

beforeEach(() => values.clear());

describe("Create placement", () => {
  it("stays on this Mac where cloud is off, whatever was saved", () => {
    expect(resolveCreatePlacement({ savedPlacement: "cloud", cloudAvailable: false, hasLocalProjects: false })).toBe("local");
  });

  it("starts in the cloud only when there is no saved choice and no local project", () => {
    expect(resolveCreatePlacement({ savedPlacement: null, cloudAvailable: true, hasLocalProjects: false })).toBe("cloud");
    expect(resolveCreatePlacement({ savedPlacement: null, cloudAvailable: true, hasLocalProjects: true })).toBe("local");
    expect(resolveCreatePlacement({ savedPlacement: "local", cloudAvailable: true, hasLocalProjects: false })).toBe("local");
  });

  it("remembers the last choice as a device preference", () => {
    rememberCreatePlacement("cloud");
    expect(values.get("create:placement:v1")).toBe("cloud");
    rememberCreatePlacement("local");
    expect(values.get("create:placement:v1")).toBe("local");
  });
});
