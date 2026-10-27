import { expect, it } from "vitest";
import { designResourceCounters, retainDesignResource } from "../state/design-resource-counters";

it("reads bounded anonymous allocation counters without retaining resource owners", () => {
  const first = retainDesignResource("frameSurfaces");
  const second = retainDesignResource("frameSurfaces");
  const sample = designResourceCounters();
  expect(sample.frameSurfaces).toEqual({ current: 2, peak: 2, admitted: 2 });
  first();
  first();
  second();
  expect(designResourceCounters().frameSurfaces).toEqual({ current: 0, peak: 2, admitted: 2 });
  expect(sample.frameSurfaces.current).toBe(2);
});
