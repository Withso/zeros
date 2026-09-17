import { describe, expect, it, vi } from "vitest";
const counters = vi.hoisted(() => ({ inspected: 0, yielded: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const entry = (index: number) => ({
    name: `unsupported-${index}.txt`,
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => {
      counters.inspected += 1;
      return true;
    },
  });
  return {
    ...actual,
    readdir: async () =>
      Array.from({ length: 10_000 }, (_, index) => entry(index)),
    opendir: async () => ({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 10_000; index++) {
          counters.yielded += 1;
          yield entry(index);
        }
      },
    }),
  };
});
import { listDesignAssets } from "../assets";

describe("Design asset discovery budget", () => {
  it("bounds scanning even when a directory contains only unsupported files", async () => {
    counters.inspected = 0;
    counters.yielded = 0;
    expect(await listDesignAssets("/fixture/workspace")).toEqual([]);
    expect(counters.inspected).toBeLessThanOrEqual(4096);
    expect(counters.yielded).toBeLessThanOrEqual(4097);
  });
});
