import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { RendererProcessOwnerRegistry } from "../renderer-process-owners";

class Contents extends EventEmitter {
  destroyed = false;
  constructor(public pid: number) { super(); }
  isDestroyed() { return this.destroyed; }
  getOSProcessId() { return this.pid; }
  close() { this.destroyed = true; this.emit("destroyed"); }
}

describe("renderer process owners", () => {
  it("reads the current process identity after navigation or renderer replacement", () => {
    const owners = new RendererProcessOwnerRegistry();
    const contents = new Contents(100);
    owners.track(contents, "Main window");
    expect(owners.ownersByPid()).toEqual(new Map([[100, "Main window"]]));
    contents.pid = 200;
    expect(owners.ownersByPid()).toEqual(new Map([[200, "Main window"]]));
    contents.close();
    expect(owners.ownersByPid().size).toBe(0);
    expect(owners["entries"].size).toBe(0);
  });

  it("combines only closed owner labels when Chromium shares a renderer process", () => {
    const owners = new RendererProcessOwnerRegistry();
    const a = new Contents(100), b = new Contents(100), c = new Contents(100);
    owners.track(a, "Main window"); owners.track(b, "Browser tab"); owners.track(c, "Browser tab");
    expect(owners.ownersByPid().get(100)).toBe("Browser tab, Main window");
    b.close(); c.close();
    expect(owners.ownersByPid().get(100)).toBe("Main window");
  });

  it("does not retain destroyed capture windows or install duplicate listeners", () => {
    const owners = new RendererProcessOwnerRegistry();
    for (let i = 0; i < 1_000; i += 1) {
      const contents = new Contents(i + 1);
      owners.track(contents, "Design capture"); owners.track(contents, "Design capture");
      expect(contents.listenerCount("destroyed")).toBe(1);
      contents.close();
    }
    expect(owners["entries"].size).toBe(0);
  });

  it("ignores not-yet-created or unavailable native processes without starting work", () => {
    const owners = new RendererProcessOwnerRegistry();
    const contents = new Contents(0);
    owners.track(contents, "Agent-control overlay");
    expect(owners.ownersByPid().size).toBe(0);
    contents.getOSProcessId = () => { throw new Error("renderer unavailable"); };
    expect(owners.ownersByPid().size).toBe(0);
    contents.close();
    expect(owners["entries"].size).toBe(0);
  });
});
