import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_RECORDING_AHEAD_BATCH,
  DESIGN_RECORDING_AHEAD_QUIET_MS,
  DesignRecordingAhead,
  type DesignRecordingAheadDeps,
  type DesignRecordingAheadTarget,
} from "../recording-ahead";

const target = (patch: Partial<DesignRecordingAheadTarget> = {}): DesignRecordingAheadTarget => ({
  workspaceId: "ws_1", root: "/checkouts/app", directoryId: "design_1", theme: null, colorScheme: "light", ...patch,
});
const change = (frames: string[], patch: { catalog?: boolean; all?: boolean; directoryId?: string } = {}) =>
  ({ directoryId: "design_1", sequence: 1, frames, catalog: false, all: false, ...patch });

function fakes(catalog: string[][] = [["page-1/a.html", "page-1/b.html"]]) {
  let busy = false;
  const frames = vi.fn(async () => catalog.length > 1 ? catalog.shift()! : catalog[0]!);
  const revision = vi.fn(async (): Promise<string | null> => "r".repeat(64));
  const prepare = vi.fn(async (_target: DesignRecordingAheadTarget, _revision: string, files: readonly string[]) =>
    files.map((file) => ({ file, sourceVersion: `v-${file}` })));
  const record = vi.fn(async (_target: DesignRecordingAheadTarget, _frames: ReadonlyArray<{ file: string; sourceVersion: string }>) => {});
  const deps: DesignRecordingAheadDeps = { frames, revision, prepare, record, busy: () => busy,
    folder: (t) => `${t.root}/Zeros Design` };
  return { deps, frames, revision, prepare, record, setBusy: (value: boolean) => { busy = value; } };
}

describe("recording Design frames ahead of their next open", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("records the frames a change names, once the changes have rested", async () => {
    const f = fakes();
    const ahead = new DesignRecordingAhead(f.deps);
    ahead.noteTarget(target());
    ahead.noteChange("/checkouts/app", change(["page-1/a.html"]));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS - 500);
    // An agent keeps writing: the quiet period restarts.
    ahead.noteChange("/checkouts/app", change(["page-1/b.html"]));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS - 1);
    expect(f.prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
    expect(f.prepare.mock.calls[0]![2]).toEqual(["page-1/a.html", "page-1/b.html"]);
    expect(f.record.mock.calls[0]![1]).toEqual([
      { file: "page-1/a.html", sourceVersion: "v-page-1/a.html" }, { file: "page-1/b.html", sourceVersion: "v-page-1/b.html" }]);
    ahead.stop();
  });

  it("waits while the canvas is recording what it shows", async () => {
    const f = fakes();
    const ahead = new DesignRecordingAhead(f.deps);
    ahead.noteTarget(target());
    f.setBusy(true);
    ahead.noteChange("/checkouts/app", change(["page-1/a.html"]));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS + 5_000);
    expect(f.prepare).not.toHaveBeenCalled();
    f.setBusy(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
    ahead.stop();
  });

  it("records nothing for a checkout whose canvas hasn't drawn recordings, or for whole-directory changes", async () => {
    const f = fakes();
    const ahead = new DesignRecordingAhead(f.deps);
    ahead.noteChange("/checkouts/app", change(["page-1/a.html"]));
    ahead.noteTarget(target());
    ahead.noteChange("/checkouts/app", change([], { all: true, catalog: true }));
    ahead.noteChange("/checkouts/app", change(["page-1/a.html"], { directoryId: "design_other" }));
    ahead.noteChange("/checkouts/other", change(["page-1/a.html"]));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS * 3);
    expect(f.prepare).not.toHaveBeenCalled();
    ahead.stop();
  });

  it("records frames new to the catalog since the canvas first drew, not every unrecorded frame", async () => {
    // An agent adds a frame: the change names only the catalog.
    const f = fakes([["page-1/a.html", "page-1/b.html"], ["page-1/a.html", "page-1/b.html", "page-2/new.html"]]);
    const ahead = new DesignRecordingAhead(f.deps);
    await ahead.noteTarget(target());
    ahead.noteChange("/checkouts/app", change([], { catalog: true }));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
    expect(f.prepare.mock.calls[0]![2]).toEqual(["page-2/new.html"]);
    ahead.stop();
  });

  it("records a frame whose own source file changed, though no change event named it", async () => {
    // After a restart the engine has prepared nothing, so its change events
    // can't name frames an agent edits on a page no canvas has opened.
    const f = fakes();
    const ahead = new DesignRecordingAhead(f.deps);
    await ahead.noteTarget(target());
    ahead.noteFile("/checkouts/app", "/checkouts/app/Zeros Design/page-1/b.html");
    ahead.noteFile("/checkouts/app", "/checkouts/app/Zeros Design/styles/tokens.css");
    ahead.noteFile("/checkouts/app", "/checkouts/app/src/b.html");
    ahead.noteFile("/checkouts/other", "/checkouts/other/Zeros Design/page-1/a.html");
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
    expect(f.prepare.mock.calls[0]![2]).toEqual(["page-1/b.html"]);
    ahead.stop();
  });

  it("records in the theme and color scheme the canvas drew last", async () => {
    const f = fakes();
    const ahead = new DesignRecordingAhead(f.deps);
    ahead.noteTarget(target());
    ahead.noteChange("/checkouts/app", change(["page-1/a.html"]));
    ahead.noteTarget(target({ theme: "brand", colorScheme: "dark" }));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(1));
    expect(f.record.mock.calls[0]![0]).toMatchObject({ theme: "brand", colorScheme: "dark" });
    ahead.stop();
  });

  it("works in small batches, and a failed batch leaves the rest to record", async () => {
    const files = Array.from({ length: DESIGN_RECORDING_AHEAD_BATCH * 2 + 1 }, (_, i) => `page-1/f${i}.html`);
    const f = fakes();
    f.prepare.mockRejectedValueOnce(new Error("The Design catalog changed while preparing."));
    const ahead = new DesignRecordingAhead(f.deps);
    ahead.noteTarget(target());
    ahead.noteChange("/checkouts/app", change(files));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(3));
    expect(f.prepare.mock.calls.map((call) => call[2].length)).toEqual([DESIGN_RECORDING_AHEAD_BATCH, DESIGN_RECORDING_AHEAD_BATCH, 1]);
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(2));
    ahead.stop();
  });

  it("drops a directory that is no longer active, and does nothing once stopped", async () => {
    const f = fakes();
    f.revision.mockResolvedValueOnce(null);
    const ahead = new DesignRecordingAhead(f.deps);
    ahead.noteTarget(target());
    ahead.noteChange("/checkouts/app", change(["page-1/a.html"]));
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS);
    await vi.waitFor(() => expect(f.revision).toHaveBeenCalledTimes(1));
    expect(f.prepare).not.toHaveBeenCalled();
    ahead.noteChange("/checkouts/app", change(["page-1/b.html"]));
    ahead.stop();
    await vi.advanceTimersByTimeAsync(DESIGN_RECORDING_AHEAD_QUIET_MS * 2);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
