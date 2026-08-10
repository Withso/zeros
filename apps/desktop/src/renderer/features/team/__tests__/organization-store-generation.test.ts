import { describe, expect, it } from "vitest";
import type { Me } from "../control-plane";
import {
  acceptOrganizationSnapshot,
  clearTeamStore,
  getOrganizationStoreGeneration,
  getTeamStoreState,
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
});
