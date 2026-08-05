import { describe, expect, it } from "vitest";

import { cursorTaskOpenState } from "../renderers/cursor-task-state";

describe("Cursor Task live child visibility", () => {
  it("opens when the first streamed child arrives", () => {
    expect(cursorTaskOpenState(null, 0)).toBe(false);
    expect(cursorTaskOpenState(null, 1)).toBe(true);
  });

  it("keeps an explicit user collapse sticky while more children stream", () => {
    expect(cursorTaskOpenState(false, 12)).toBe(false);
    expect(cursorTaskOpenState(true, 0)).toBe(true);
  });
});
