import { expect, it } from "vitest";
import { cursorTokenUsage } from "../usage-accounting";

it.each([29942, 14996, undefined])(
  "preserves native cache-inclusive input with SDK total %s",
  (totalTokens) => {
    // Numeric-only capture from the worker's former 1.0.40 pin. Its total
    // added cache buckets a second time; the input field itself is inclusive.
    const native = {
      inputTokens: 14956,
      outputTokens: 40,
      cacheReadTokens: 14897,
      cacheWriteTokens: 49,
    };
    expect(cursorTokenUsage({ ...native, totalTokens })).toEqual(native);
  },
);
