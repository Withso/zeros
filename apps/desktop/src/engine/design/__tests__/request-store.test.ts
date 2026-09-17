import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesignRequestStore,
  DESIGN_REQUEST_LIMIT,
  type DesignRequestRecord,
} from "../request-store";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("durable Design request retention", () => {
  it("keeps accepting fresh work after bounded receipt eviction and refuses a retired request after restart", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "zeros-design-request-store-"),
    );
    roots.push(root);
    const now = 10_000;
    const record = (index: number): DesignRequestRecord => ({
      id: `request-${index}`,
      actorId: "actor",
      signature: "a".repeat(64),
      createdAt: index + 1,
      status: "committed",
      result: { saved: index },
    });
    const store = new DesignRequestStore(root, "design-test", () => now);
    const records = Array.from({ length: DESIGN_REQUEST_LIMIT }, (_, index) =>
      record(index),
    );
    store.write(records);
    const next = await store.read();
    store.add(next, record(DESIGN_REQUEST_LIMIT));
    expect(next).toHaveLength(DESIGN_REQUEST_LIMIT);
    const resumed = new DesignRequestStore(root, "design-test", () => now);
    const retained = await resumed.read();
    expect(retained.find((entry) => entry.id === "request-0")).toBeUndefined();
    expect(() => resumed.add(retained, record(0))).toThrow(/retired|retention/);
    expect(
      (await resumed.read()).some(
        (entry) => entry.id === `request-${DESIGN_REQUEST_LIMIT}`,
      ),
    ).toBe(true);
  });
});
