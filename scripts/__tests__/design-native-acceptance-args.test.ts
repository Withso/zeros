import { describe, expect, it } from "vitest";

import { parseNativeAcceptanceArgs, summarizeDocuments } from "../design-native-acceptance.mjs";

describe("native acceptance arguments", () => {
  it("measures the DOM canvas unless the recorded canvas is asked for", () => {
    expect(parseNativeAcceptanceArgs([])).toEqual({ command: "run", sourceDigest: null, canvas: "dom" });
    expect(parseNativeAcceptanceArgs(["--canvas", "recorded"])).toEqual({ command: "run", sourceDigest: null, canvas: "recorded" });
    const digest = "a".repeat(64);
    expect(parseNativeAcceptanceArgs(["--canvas", "recorded", "--source-digest", digest]))
      .toEqual({ command: "run", sourceDigest: digest, canvas: "recorded" });
  });

  it("keeps --help and --status standalone", () => {
    expect(parseNativeAcceptanceArgs(["--help"])).toEqual({ command: "help" });
    expect(parseNativeAcceptanceArgs(["--status"])).toEqual({ command: "status" });
    expect(() => parseNativeAcceptanceArgs(["--status", "--canvas"])).toThrow(/--help/);
  });

  it("groups frame documents by kind, counting every one and naming a few frames", () => {
    const row = (frame: string, kind: string, visible = true) => ({ frame, kind, attributes: [], visible });
    const rows = Array.from({ length: 10 }, (_, index) => row(`page/${index}.html`, "source"));
    expect(summarizeDocuments({ present: [...rows, row("page/a.html", "runtime", false)], mounted: [row("page/a.html", "runtime")] })).toEqual({
      mounted: { runtime: { count: 1, frames: ["page/a.html"] } },
      present: { source: { count: 10, frames: rows.slice(0, 8).map(entry => entry.frame) }, runtime: { count: 1, frames: ["page/a.html"] } },
      visible: { source: { count: 10, frames: rows.slice(0, 8).map(entry => entry.frame) } },
    });
  });

  it("rejects unknown canvases, malformed digests and repeats", () => {
    for (const args of [["--canvas", "gpu"], ["--canvas"], ["--source-digest", "abc"], ["--frames", "1"],
      ["--source-digest", "a".repeat(64), "--source-digest", "b".repeat(64)]])
      expect(() => parseNativeAcceptanceArgs(args), args.join(" ")).toThrow(/--help/);
  });
});
