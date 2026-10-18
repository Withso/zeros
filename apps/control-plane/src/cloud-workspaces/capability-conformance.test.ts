import { describe, expect, it } from "vitest";

import { buildCapabilityConformance, conformanceOutcome, seedConformanceState } from "./capability-conformance-test-utils.js";
import { CAPABILITY_ERROR_CODES } from "./capability-contract.js";
import { CapabilityVerifier } from "./capability-verifier.js";

const fixture = buildCapabilityConformance();

describe("S1 conformance vectors", () => {
  it("build the same bytes every time", () => {
    expect(buildCapabilityConformance()).toEqual(fixture);
  });

  it("cover every verification step and every verifier error code", () => {
    const steps = new Set(fixture.vectors.flatMap(vector => vector.expect.ok ? [] : [vector.expect.step]));
    expect([...steps].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const codes = new Set(fixture.vectors.flatMap(vector => vector.expect.ok ? [] : [vector.expect.code]));
    // capability_missing and capability_issuer_unavailable belong to the
    // transport and the issuer, never to token verification.
    expect([...codes].sort()).toEqual(CAPABILITY_ERROR_CODES.filter(code => code !== "capability_missing" && code !== "capability_issuer_unavailable").sort());
    for (const pin of ["zeros:engine/client", "zeros:realtime/client", "zeros:api/engine"])
      expect(fixture.vectors.some(vector => `${vector.pin.aud}/${vector.pin.knd}` === pin), pin).toBe(true);
  });

  for (const vector of fixture.vectors) {
    it(`core verifier: ${vector.name}`, async () => {
      const verifier = new CapabilityVerifier({ issuer: fixture.issuer, now: () => vector.nowMs });
      verifier.applyKeys(fixture.keys);
      seedConformanceState(verifier, vector);
      let result = await verifier.verify(vector.token, vector.pin, vector.context);
      if (vector.repeat) result = await verifier.verify(vector.token, vector.pin, vector.context);
      expect(conformanceOutcome(result)).toEqual(vector.expect);
    });
  }
});
