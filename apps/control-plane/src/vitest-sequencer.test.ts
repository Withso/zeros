import type { TestSpecification, Vitest } from "vitest/node";
import { describe, expect, it } from "vitest";
import ControlPlaneSequencer from "../vitest.sequencer.js";

const root = "/checkout/apps/control-plane";
const spec = (file: string) => ({ moduleId: `${root}/${file}` }) as TestSpecification;
const sequencer = (shard?: { index: number; count: number }) =>
  new ControlPlaneSequencer({ config: { root, shard } } as unknown as Vitest);

describe("control-plane test sequencer", () => {
  const parts = Array.from({ length: 8 }, (_, index) => spec(`src/migrations-${index + 1}.test.ts`));
  const others = Array.from({ length: 24 }, (_, index) => spec(`src/file-${index}.test.ts`));
  const files = [...others, ...parts];
  const names = (specs: TestSpecification[]) => specs.map((entry) => entry.moduleId.slice(root.length + 1));

  it("pins migration part N to shard N and shares every other file out exactly once", async () => {
    const seen: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
      const chosen = names(await sequencer({ index, count: 8 }).shard(files));
      expect(chosen.filter((file) => file.startsWith("src/migrations-"))).toEqual([`src/migrations-${index}.test.ts`]);
      seen.push(...chosen);
    }
    expect(seen.sort()).toEqual(names(files).sort());
  });

  it("wraps parts onto fewer shards", async () => {
    const chosen = names(await sequencer({ index: 2, count: 4 }).shard(parts));
    expect(chosen).toEqual(["src/migrations-2.test.ts", "src/migrations-6.test.ts"]);
  });

  it("leaves an unsharded run untouched", async () => {
    expect(await sequencer().shard(files)).toEqual(files);
  });
});
