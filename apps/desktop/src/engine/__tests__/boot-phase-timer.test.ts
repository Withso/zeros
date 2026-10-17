import { expect, it } from "vitest";
import { BootPhaseTimer } from "../boot-phase-timer";

it("names only the slow boot phases, slowest first", () => {
  let now = 0;
  const timer = new BootPhaseTimer(() => now);
  now = 40; timer.mark("process-recovery");
  now = 1_340; timer.mark("archive-refs");
  now = 1_400; timer.mark("seed");
  now = 9_400; timer.mark("design-reconcile");
  expect(timer.slowPhases()).toBe("design-reconcile=8000ms archive-refs=1300ms");
  expect(new BootPhaseTimer(() => 0).slowPhases()).toBeNull();
});
