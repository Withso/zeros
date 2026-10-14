// shouldRepollInitialize — the gateway's "don't serve a stale, model-less
// initialize forever" rule. Cursor (the @cursor/sdk) discovers its live model
// catalog only after the agent boots, so its first initialize can be
// model-less; the gateway must re-read the adapter on subsequent requests
// until `_meta.models` lands. Refreshable account catalogs keep consulting the
// adapter's cheap cache; the adapter owns the network TTL and single flight.

import { describe, expect, it } from "vitest";

import { shouldRepollInitialize } from "../gateway";
import type { InitializeResponse } from "../types";

const init = (meta: Record<string, unknown> | null | undefined): InitializeResponse =>
  ({ _meta: meta } as unknown as InitializeResponse);

describe("shouldRepollInitialize", () => {
  it("consults a refreshable account catalog even after the first or empty answer", () => {
    for (const models of [[], [{ value: "gpt-6-astra", label: "Astra" }]]) {
      expect(shouldRepollInitialize(init({ modelsDynamic: true, modelsAccountScoped: true, models }))).toBe(true);
    }
  });
  it("does NOT re-poll a non-dynamic adapter (claude/codex use the catalog families)", () => {
    expect(shouldRepollInitialize(init({ modelEnvVar: "ANTHROPIC_MODEL" }))).toBe(false);
    expect(shouldRepollInitialize(init(null))).toBe(false);
    expect(shouldRepollInitialize(init(undefined))).toBe(false);
  });

  it("re-polls a dynamic-models adapter that has not discovered models yet", () => {
    expect(shouldRepollInitialize(init({ modelsDynamic: true }))).toBe(true);
    // Empty array still counts as "no models" — keep re-polling.
    expect(shouldRepollInitialize(init({ modelsDynamic: true, models: [] }))).toBe(true);
  });

  it("STOPS re-polling once the dynamic adapter has populated models (self-limiting)", () => {
    expect(
      shouldRepollInitialize(
        init({ modelsDynamic: true, models: [{ value: "composer-2.5", label: "Composer 2.5" }] }),
      ),
    ).toBe(false);
  });

  it("does not re-poll when modelsDynamic is falsy even if models is empty", () => {
    expect(shouldRepollInitialize(init({ modelsDynamic: false, models: [] }))).toBe(false);
  });
});
