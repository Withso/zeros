import { describe, expect, it, vi } from "vitest";
import type { Tx } from "./db.js";
import { ensurePersonalOrganization } from "./auth.js";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  display_name: "Ada",
};

describe("Personal invariant repair", () => {
  it("uses one read on the complete authenticated-request hot path", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          id: "personal_1",
          name: "Ada",
          has_organization_membership: true,
          default_team_id: "team_1",
          has_team_membership: true,
        },
      ],
    }));

    await ensurePersonalOrganization({ query } as unknown as Tx, user);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("retries with a random suffix when the preferred slug loses a race", async () => {
    let organizationInsert = 0;
    const attemptedSlugs: unknown[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("has_organization_membership")) return { rows: [] };
      if (sql.includes("INSERT INTO organizations")) {
        organizationInsert += 1;
        attemptedSlugs.push(params?.[0]);
        return organizationInsert === 1
          ? { rows: [] }
          : { rows: [{ id: "personal_1" }] };
      }
      if (sql.includes("SELECT id FROM organizations")) return { rows: [] };
      return { rows: [] };
    });

    await expect(
      ensurePersonalOrganization({ query } as unknown as Tx, user),
    ).resolves.toBeUndefined();
    expect(organizationInsert).toBe(2);
    expect(attemptedSlugs[1]).not.toBe(attemptedSlugs[0]);
    expect(attemptedSlugs[1]).toMatch(/^personal-[a-f0-9]+-[a-f0-9]+$/);
  });
});
