// shouldRepollInitialize — the gateway's "don't serve a stale, model-less
// initialize forever" rule. Cursor (the @cursor/sdk) discovers its live model
// catalog only after the agent boots, so its first initialize can be
// model-less; the gateway must re-read the adapter on subsequent requests
// until `_meta.models` lands, so the picker reflects the user's real account
// instead of the bundled list.

import { describe, expect, it } from "vitest";

import { shouldRepollInitialize } from "../gateway";
import type { InitializeResponse } from "../types";

const init = (meta: Record<string, unknown> | null | undefined): InitializeResponse =>
  ({ _meta: meta } as unknown as InitializeResponse);

describe("shouldRepollInitialize", () => {
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
