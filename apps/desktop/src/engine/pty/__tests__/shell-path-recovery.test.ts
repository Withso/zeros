import { describe, expect, it, vi } from "vitest";
import { createShellPathRecovery } from "../shell-path-recovery";
import { PtyService, type PtyHandle } from "../service";

describe("shell command start witnesses", () => {
  it("does not publish a retired attempt's buffered bytes into a replacement session", () => {
    const handles: Array<{ data: (data: string) => void; exit: () => void }> =
      [];
    const service = new PtyService(process.cwd(), () => {
      const callbacks = { data: (_data: string) => {}, exit: () => {} };
      handles.push(callbacks);
      return {
        pid: handles.length,
        onSpawned: () => {},
        onData: (callback) => {
          callbacks.data = callback;
        },
        onExit: (callback) => {
          callbacks.exit = () => callback(127, null);
        },
        write: () => {},
        resize: () => {},
        kill: () => {},
      } satisfies PtyHandle;
    });
    const output: string[] = [];
    service.onData((_id, data) => output.push(data));
    service.create({
      sessionId: "same",
      command: "missing-tool",
      env: { PATH: "/usr/bin" },
      recoverShellPath: true,
    });
    handles[0]!.data("\x1b]777;zeros-path");
    service.kill("same");
    service.create({ sessionId: "same" });
    handles[0]!.data("retired output");
    handles[0]!.exit();
    handles[1]!.data("current output");
    expect(output).toEqual(["current output"]);
    expect(service.has("same")).toBe(true);
    service.killAll();
  });

  it("never trusts a missing-command marker emitted after the command began", () => {
    const recovery = createShellPathRecovery("pnpm install", {
      PATH: "/usr/bin",
    })!;
    const token = /zeros-path-miss-[a-f0-9-]+/.exec(recovery.command)![0];
    recovery.filterData(`\x1b]777;${token}-started\x07`);
    recovery.filterData(`\x1b]777;${token}\x07`);
    expect(recovery.canRetry(127, null)).toBe(false);
  });

  it("preserves unsupported shell syntax instead of inserting a POSIX guard", () => {
    vi.stubEnv("SHELL", "/usr/local/bin/fish");
    try {
      expect(
        createShellPathRecovery("pnpm install", { PATH: "/usr/bin" }),
      ).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
