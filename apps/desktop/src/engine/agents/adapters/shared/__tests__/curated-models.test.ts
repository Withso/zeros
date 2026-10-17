import { describe, expect, it } from "vitest";
import { isCuratedModel } from "../curated-models";

describe("isCuratedModel", () => {
  it("accepts curated rows through context suffixes, dated snapshots and aliases", () => {
    expect(isCuratedModel("claude", "claude-opus-5-5[1m]")).toBe(true);
    expect(isCuratedModel("claude", "claude-opus-4-8-20260115")).toBe(true);
    expect(isCuratedModel("claude", "sonnet-5")).toBe(true);
    expect(isCuratedModel("codex", "gpt-5.6-sol")).toBe(true);
    expect(isCuratedModel("cursor", "composer-2.5")).toBe(true);
    expect(isCuratedModel("cursor", "auto")).toBe(true);
  });

  it("rejects provider models the picker never offers", () => {
    expect(isCuratedModel("claude", "claude-sonnet-4-5-20250929")).toBe(false);
    expect(isCuratedModel("codex", "gpt-5.3-codex")).toBe(false);
    expect(isCuratedModel("cursor", "composer-2")).toBe(false);
  });

  it("does not restrict an agent family without curated rows", () => {
    expect(isCuratedModel("opencode", "anything/model")).toBe(true);
  });
});
