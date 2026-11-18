import { describe, expect, it, vi } from "vitest";
import { dropPublicSchema } from "./test-database.js";

describe("test database rebuild", () => {
  const deadlock = Object.assign(new Error("deadlock detected"), { code: "40P01" });
  it("retries a schema drop that lost a deadlock to a leftover session", async () => {
    const query = vi.fn().mockRejectedValueOnce(deadlock).mockResolvedValueOnce({});
    await dropPublicSchema({ query } as never);
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("gives up after its attempts and never retries other errors", async () => {
    await expect(dropPublicSchema({ query: vi.fn().mockRejectedValue(deadlock) } as never)).rejects.toBe(deadlock);
    const other = Object.assign(new Error("permission denied"), { code: "42501" });
    const query = vi.fn().mockRejectedValue(other);
    await expect(dropPublicSchema({ query } as never)).rejects.toBe(other);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
