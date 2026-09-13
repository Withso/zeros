import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTerminalTabIndicators,
  peekTerminalTabIndicators,
  publishTerminalTabIndicators,
} from "../terminal-tab-indicators";

beforeEach(() => clearTerminalTabIndicators(() => true));
describe("shared terminal indicators", () => {
  it("publishes a changed Run icon even when its status is unchanged", () => {
    const original = { running: false, exited: false, dot: null, icon: "play" };
    publishTerminalTabIndicators("/a", { run: original });
    const before = peekTerminalTabIndicators("/a");
    const changed = { ...original, icon: "flask-conical" };
    publishTerminalTabIndicators("/a", { run: changed });
    expect(peekTerminalTabIndicators("/a")).not.toBe(before);
    expect(peekTerminalTabIndicators("/a").run).toEqual(changed);
    const confirmed = peekTerminalTabIndicators("/a");
    publishTerminalTabIndicators("/a", { run: { ...changed } });
    expect(peekTerminalTabIndicators("/a")).toBe(confirmed);
  });
  it("keeps exact workspace snapshots and stable references across status revalidation", () => {
    publishTerminalTabIndicators("/a", {
      setup: { running: false, exited: false, dot: "passed" },
    });
    const a = peekTerminalTabIndicators("/a");
    publishTerminalTabIndicators("/b", {
      setup: { running: false, exited: false, dot: "failed" },
    });
    publishTerminalTabIndicators("/a", {
      setup: { running: false, exited: false, dot: "passed" },
    });
    expect(peekTerminalTabIndicators("/a")).toBe(a);
    expect(peekTerminalTabIndicators("/b").setup.dot).toBe("failed");
  });
  it("bounds old workspace snapshots and prunes owners without clearing other workspaces", () => {
    for (let index = 0; index < 140; index += 1)
      publishTerminalTabIndicators(`/workspace/${index}`, {
        shell: { running: false, exited: true, dot: null },
      });
    expect(peekTerminalTabIndicators("/workspace/0")).toEqual({});
    expect(peekTerminalTabIndicators("/workspace/139").shell.exited).toBe(true);
    clearTerminalTabIndicators((folder) => folder === "/workspace/139");
    expect(peekTerminalTabIndicators("/workspace/139")).toEqual({});
    expect(peekTerminalTabIndicators("/workspace/138").shell.exited).toBe(true);
  });
});
