import { describe, expect, it, vi } from "vitest";
import { capturePickerSelection } from "../picker-capture";
import type { SelectedElement } from "../use-iframe-webview";

const element = (x = 0): SelectedElement => ({
  selector: "div", tag: "div", rect: { x, y: 0, width: 100, height: 100 },
  click: { x, y: 0 }, altKey: false, hasShadowRoot: false, href: "https://example.test/",
});

describe("picker capture budgets", () => {
  it("shares native captures while charging every retained screenshot", async () => {
    const capture = vi.fn(async () => "x".repeat(1024 * 1024));
    const result = await capturePickerSelection(Array.from({ length: 32 }, () => element()), capture, () => true);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(result.reduce((sum, value) => sum + (value.screenshot?.length ?? 0), 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(result).toHaveLength(32);
  });

  it("starts at most eight unique captures and preserves every selection", async () => {
    const capture = vi.fn(async () => "image");
    const result = await capturePickerSelection(Array.from({ length: 32 }, (_, i) => element(i)), capture, () => true);
    expect(capture).toHaveBeenCalledTimes(8);
    expect(result).toHaveLength(32);
  });

  it("drops results and starts no more work after the selection is superseded", async () => {
    let active = true;
    const capture = vi.fn(async () => { active = false; return "image"; });
    expect(await capturePickerSelection([element(), element(1)], capture, () => active)).toEqual([]);
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
