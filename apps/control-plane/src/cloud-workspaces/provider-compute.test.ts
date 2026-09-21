import { describe, expect, it } from 'vitest';
import { computeMicroUsd } from './provider-compute.js';

describe('integer cumulative compute pricing', () => {
  it('rounds cumulative usage once so repeated polling does not create charges', () => {
    expect(computeMicroUsd(0, 3)).toBe(0);
    expect(computeMicroUsd(1, 3)).toBe(333334);
    expect(computeMicroUsd(2, 3)).toBe(666667);
    expect(computeMicroUsd(3, 3)).toBe(1000000);
    const first = computeMicroUsd(1, 3), second = computeMicroUsd(2, 3), third = computeMicroUsd(3, 3);
    expect(first + (second - first) + (third - second)).toBe(1000000);
  });
  it('avoids intermediate floating point overflow for large counters', () => {
    expect(computeMicroUsd(Number.MAX_SAFE_INTEGER, 1000000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => computeMicroUsd(Number.MAX_SAFE_INTEGER, 1)).toThrow();
  });
  it.each([[NaN, 100000], [1.1, 100000], [-1, 100000], [1, 0], [1, 0.5], [1, Infinity]])('rejects invalid metering: %j', (seconds, rate) => {
    expect(() => computeMicroUsd(seconds, rate)).toThrow();
  });
});
