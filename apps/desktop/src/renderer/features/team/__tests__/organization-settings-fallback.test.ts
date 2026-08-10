import { describe, expect, it, vi } from "vitest";

import {
  ControlPlaneError,
  withLegacyOrganizationSettingsFallback,
} from "../control-plane";

describe("organization settings mixed-version fallback", () => {
  it("uses the legacy Team alias when the organization route is unavailable", async () => {
    const legacy = vi.fn().mockResolvedValue({ doc: { source: "legacy" } });

    await expect(
      withLegacyOrganizationSettingsFallback(async () => {
        throw new ControlPlaneError(404, "not_found", "Not found");
      }, legacy),
    ).resolves.toEqual({ doc: { source: "legacy" } });
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("does not hide non-route failures behind the legacy alias", async () => {
    const failure = new ControlPlaneError(503, "unavailable", "Unavailable");
    const legacy = vi.fn();

    await expect(
      withLegacyOrganizationSettingsFallback(async () => {
        throw failure;
      }, legacy),
    ).rejects.toBe(failure);
    expect(legacy).not.toHaveBeenCalled();
  });
});
