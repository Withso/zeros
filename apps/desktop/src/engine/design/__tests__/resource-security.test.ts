import { expect, it } from "vitest";
import { expandDesignComponents } from "../components";
import { designAgentEditPreview } from "../agent-drafts";

it("stops the whole component expansion at a shared instance budget", async () => {
  const source = "<zd-card></zd-card>".repeat(2200);
  const result = await expandDesignComponents("/work/security", source, {
    "components/card.html": "<!doctype html><html><body><div>Content</div></body></html>",
  });
  expect(result.html).toBe(source);
  expect(result.errors.some(error => /budget|limit/.test(error.message))).toBe(true);
  expect(result.errors.length).toBeLessThanOrEqual(128);
});

it("rejects replacement amplification before allocating preview output", () => {
  expect(designAgentEditPreview("x".repeat(4096), {
    old_string: "x", new_string: "y".repeat(1024), replace_all: true,
  }, new Set(["old_string", "new_string"]))).toBeNull();
});

it("charges every MultiEdit step to the same output ceiling", () => {
  expect(designAgentEditPreview("x".repeat(4096), { edits: [
    { old_string: "x", new_string: "y".repeat(128), replace_all: true },
    { old_string: "y", new_string: "z".repeat(8), replace_all: true },
  ] }, new Set(["edits.0.old_string", "edits.0.new_string", "edits.1.old_string", "edits.1.new_string"]))).toBeNull();
});
