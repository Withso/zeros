import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSummary } from "../control-plane";

const state = vi.hoisted(() => ({
  cloud: true,
  organization: null as OrganizationSummary | null,
}));
vi.mock("../../../config/release-channel", async original => ({
  ...(await original<typeof import("../../../config/release-channel")>()),
  isFeatureEnabled: () => state.cloud,
}));
vi.mock("../team-store", async original => ({
  ...(await original<typeof import("../team-store")>()),
  useActiveOrganization: () => state.organization,
  getActiveOrganizationIdSnapshot: () => state.organization?.id ?? null,
}));
import { CloudWorkspacePausedNotice, useOrganizationCloudPaused } from "../cloud-workspace-pause";

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  isPersonal: false,
  role: "member",
  workspaceCapabilities: { local: false, cloud: true },
} as OrganizationSummary;

function read() {
  let paused = false;
  function Probe() {
    paused = useOrganizationCloudPaused();
    return createElement(CloudWorkspacePausedNotice);
  }
  const markup = renderToStaticMarkup(createElement(Probe));
  return { paused, markup };
}

beforeEach(() => {
  state.cloud = true;
  state.organization = organization;
});

describe("organization cloud pause", () => {
  it("pauses an organization's cloud forms for a member on Hold and says why", () => {
    state.organization = { ...organization, seat: "hold" };
    const { paused, markup } = read();
    expect(paused).toBe(true);
    expect(markup).toContain("You&#x27;re on Hold in this organization.");
  });

  it("keeps cloud available on a Pro or free seat, and before the seat is known", () => {
    for (const seat of ["pro", "free", undefined] as const) {
      state.organization = { ...organization, ...(seat ? { seat } : {}) };
      expect(read().paused).toBe(false);
    }
  });

  it("names the release pause first when this build has cloud off", () => {
    state.cloud = false;
    state.organization = { ...organization, seat: "hold" };
    const { paused, markup } = read();
    expect(paused).toBe(true);
    expect(markup).toContain("Cloud workspaces are paused");
  });

  it("never pauses Local Personal", () => {
    state.cloud = false;
    state.organization = { ...organization, isPersonal: true };
    expect(read().paused).toBe(false);
  });
});
