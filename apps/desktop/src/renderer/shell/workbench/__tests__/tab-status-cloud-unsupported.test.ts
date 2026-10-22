import { describe, expect, it } from "vitest";
import { WorkbenchStatusSources } from "../tab-status-model";

// On a cloud workspace the Changes, Files and Setup tabs showed "Couldn't
// load …" with Retry beside loaded content: the cloud worker answers reads it
// doesn't serve yet (turns, review hunks, setup and run logs, pull requests)
// with CLOUD_V2_UNSUPPORTED, and the tabs published that as a read failure.
const unsupported = Object.assign(new Error("This operation is not available in cloud workspaces yet."), { code: "CLOUD_V2_UNSUPPORTED" });

describe("cloud features that aren't available yet", () => {
  it("treat an auxiliary unsupported read as absent, so loaded content shows no banner", () => {
    const sources = new WorkbenchStatusSources();
    sources.update("body", { pending: false, primary: true, hasContent: true });
    sources.update("turns", { pending: false, error: unsupported });
    sources.update("hunks", { pending: false, error: "This operation is not available in cloud workspaces yet." });
    expect(sources.snapshot()).toMatchObject({ failure: null, hasContent: true, notice: null });
  });

  it("show a neutral note, not an error with Retry, when a tab's own read is unavailable", () => {
    const sources = new WorkbenchStatusSources();
    sources.update("terminal", { pending: false, primary: true, error: unsupported });
    const snapshot = sources.snapshot();
    expect(snapshot.failure).toBeNull();
    expect(snapshot.notice).toMatchObject({ tone: "neutral", message: "This isn't available in cloud workspaces yet." });
  });

  it("keep every other failure, including one beside an unavailable feature", () => {
    const sources = new WorkbenchStatusSources();
    sources.update("turns", { pending: false, error: unsupported });
    sources.update("body", { pending: false, primary: true, error: "The Git command could not be completed." });
    expect(sources.snapshot().failure).toBe("The Git command could not be completed.");
  });
});
