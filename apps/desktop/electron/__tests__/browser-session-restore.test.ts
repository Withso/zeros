import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

import { attachOrRestoreBrowserSession } from "../browser-session-restore";
import type { BrowserSessionState } from "../browser-automation";

const bounds = { x: 20, y: 40, width: 900, height: 700 };
const target = {} as BrowserWindow;
const state: BrowserSessionState = {
  taskId: "task-1",
  url: "https://example.com/after-restart",
  title: "Restored",
  loading: false,
  status: "ready",
  provider: "isolated",
};

describe("attachOrRestoreBrowserSession", () => {
  it("recreates a missing process lease from the persisted exact URL", async () => {
    const attach = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(state);
    const control = vi.fn().mockResolvedValue({
      success: true,
      contentItems: [],
    });

    await expect(
      attachOrRestoreBrowserSession(
        { attach, control },
        "task-1",
        target,
        bounds,
        state.url,
      ),
    ).resolves.toEqual(state);
    expect(control).toHaveBeenCalledWith("task-1", "open", {
      url: state.url,
      width: bounds.width,
      height: bounds.height,
    });
    expect(attach).toHaveBeenCalledTimes(2);
  });

  it("does not navigate again when the lease still exists", async () => {
    const attach = vi.fn().mockReturnValue(state);
    const control = vi.fn();

    await expect(
      attachOrRestoreBrowserSession(
        { attach, control },
        "task-1",
        target,
        bounds,
        state.url,
      ),
    ).resolves.toEqual(state);
    expect(control).not.toHaveBeenCalled();
  });

  it("surfaces navigation failures instead of silently falling back to an iframe", async () => {
    const attach = vi.fn().mockReturnValue(null);
    const control = vi.fn().mockResolvedValue({
      success: false,
      contentItems: [{ type: "inputText", text: "Navigation timed out." }],
    });

    await expect(
      attachOrRestoreBrowserSession(
        { attach, control },
        "task-1",
        target,
        bounds,
        state.url,
      ),
    ).rejects.toThrow("Navigation timed out.");
  });
});
