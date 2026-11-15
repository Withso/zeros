import { describe, expect, it, vi } from "vitest";
import type { Me } from "../control-plane";
import {
  acceptOrganizationSnapshot,
  clearTeamStore,
  getOrganizationStoreGeneration,
  getTeamStoreState,
  recentOrganizationSnapshot,
} from "../team-store";

const staleAccount: Me = {
  user: {
    id: "account-a",
    email: "a@example.com",
    displayName: "Account A",
    staffRole: null,
  },
  organizations: [],
  teams: [],
};

describe("organization store account generation", () => {
  it("rejects a background snapshot that finishes after sign-out", () => {
    const accountAGeneration = getOrganizationStoreGeneration();
    clearTeamStore();

    expect(
      acceptOrganizationSnapshot(staleAccount, accountAGeneration),
    ).toBe(false);
    expect(getTeamStoreState().me).toBeNull();
  });

  it("offers a just-accepted snapshot only to the same account generation and only briefly", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    try {
      clearTeamStore();
      const current = getOrganizationStoreGeneration();
      expect(await recentOrganizationSnapshot(current)).toBeUndefined();
      expect(acceptOrganizationSnapshot(staleAccount, current)).toBe(true);
      expect(await recentOrganizationSnapshot(current)).toBe(staleAccount);
      now.mockReturnValue(6_001);
      expect(await recentOrganizationSnapshot(current)).toBeUndefined();
      now.mockReturnValue(1_000);
      clearTeamStore();
      expect(await recentOrganizationSnapshot(current)).toBeUndefined();
      expect(await recentOrganizationSnapshot(getOrganizationStoreGeneration())).toBeUndefined();
    } finally { now.mockRestore(); }
  });
});
