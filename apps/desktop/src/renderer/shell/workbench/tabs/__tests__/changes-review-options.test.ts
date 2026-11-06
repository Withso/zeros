import { describe, expect, it, vi } from "vitest";
import { changesReviewOptions } from "../changes-review-options";

const range = { start: 2, end: 2 };

describe("Changes review options", () => {
  it("opens no composer from a conflict card or placeholder", () => {
    const review = { onLineSelected: vi.fn(), onGutterUtilityClick: vi.fn(), enableLineSelection: true };
    const options = changesReviewOptions(review);
    const file = { item: { type: "file" } };
    options.onLineSelected(range, file);
    options.onLineSelected(null, file);
    options.onGutterUtilityClick(range, file);
    expect(review.onLineSelected).not.toHaveBeenCalled();
    expect(review.onGutterUtilityClick).not.toHaveBeenCalled();
    expect(options.enableLineSelection).toBe(true);
  });

  it("passes a diff card's selection through unchanged", () => {
    const review = { onLineSelected: vi.fn(), onGutterUtilityClick: vi.fn() };
    const options = changesReviewOptions(review);
    const diff = { item: { type: "diff" } };
    options.onLineSelected(range, diff);
    options.onGutterUtilityClick(range, diff);
    expect(review.onLineSelected).toHaveBeenCalledWith(range, diff);
    expect(review.onGutterUtilityClick).toHaveBeenCalledWith(range, diff);
  });
});
