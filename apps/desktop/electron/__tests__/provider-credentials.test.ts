import { expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ reads: 0 }));
vi.mock("../secret-store", () => ({
  getSecret: (key: string) => {
    if (key !== "provider-accounts-cursor") return null;
    fixture.reads++;
    const id =
      fixture.reads === 1
        ? "00000000-0000-4000-8000-000000000001"
        : "00000000-0000-4000-8000-000000000002";
    return JSON.stringify({
      version: 1,
      initialized: true,
      method: "account",
      activeId: id,
      accounts: [
        {
          id,
          state: "connected",
          credential: { apiKey: `fixture-${id}`, expiresAtMs: 9999999999999 },
        },
      ],
    });
  },
  hasSecret: () => false,
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  secretsFilePath: () => "/private/fixture/secrets.json",
}));
import { readProviderCredentialsForEngine } from "../provider-credentials";

it("projects a Cursor credential and account identity from the same native snapshot", () => {
  const projection = readProviderCredentialsForEngine();
  expect(fixture.reads).toBe(1);
  expect(projection.cursorSubscription?.apiKey).toBe(
    `fixture-${projection.accountProfiles?.cursor?.id}`,
  );
});
