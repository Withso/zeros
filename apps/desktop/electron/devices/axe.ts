// AXe, the open-source (MIT) iOS Simulator automation tool Zeros bundles for
// the live view and the user's own touches and typing. It drives the
// simulator's HID directly, so input needs no app or accessibility service on
// the device.

import { spawn } from "node:child_process";
import path from "node:path";

import type { SimulatorKey } from "@zeros/protocol/simulators";

import type { SimulatorHidInput } from "./device-hub";
import type { FrameStreamProcess } from "./live-view";
import type { ToolRunner } from "./tool-runner";

/** AXe, or another tool staged in its folder. */
export function axeBinaryPath(options: {
  packaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  exists(file: string): boolean;
  name?: string;
}): string | null {
  const name = options.name ?? "axe";
  const file = options.packaged
    ? path.join(options.resourcesPath, "axe", name)
    : path.join(options.repoRoot, "binaries", "axe", name);
  return options.exists(file) ? file : null;
}

/** USB HID keyboard usages. */
export const HID_KEYS: Record<SimulatorKey, number> = {
  enter: 40,
  escape: 41,
  backspace: 42,
  tab: 43,
  space: 44,
  delete: 76,
  "arrow-right": 79,
  "arrow-left": 80,
  "arrow-down": 81,
  "arrow-up": 82,
};

function coordinate(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export interface AxeInvocation {
  args: string[];
  stdin?: string;
}

export function axeInputInvocation(udid: string, input: SimulatorHidInput): AxeInvocation {
  switch (input.kind) {
    case "tap":
      return {
        args: ["tap", "-x", coordinate(input.at.x), "-y", coordinate(input.at.y), "--udid", udid],
      };
    case "drag":
      // A long press holds one point; AXe refuses a drag that goes nowhere.
      if (input.from.x === input.to.x && input.from.y === input.to.y) {
        return {
          args: [
            "touch",
            "-x",
            coordinate(input.from.x),
            "-y",
            coordinate(input.from.y),
            "--down",
            "--up",
            "--delay",
            (input.durationMs / 1_000).toFixed(2),
            "--udid",
            udid,
          ],
        };
      }
      return {
        args: [
          "drag",
          "--start-x",
          coordinate(input.from.x),
          "--start-y",
          coordinate(input.from.y),
          "--end-x",
          coordinate(input.to.x),
          "--end-y",
          coordinate(input.to.y),
          "--duration",
          (input.durationMs / 1_000).toFixed(2),
          "--udid",
          udid,
        ],
      };
    case "text":
      // Through stdin, so text that looks like a flag is still typed.
      return { args: ["type", "--stdin", "--udid", udid], stdin: input.text };
    case "key":
      return { args: ["key", String(HID_KEYS[input.key]), "--udid", udid] };
    case "button":
      return { args: ["button", input.button, "--udid", udid] };
  }
}

/** Runs input for each device in order; different devices run in parallel. */
export class AxeInput {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly binary: () => string | null,
    private readonly run: ToolRunner,
  ) {}

  available(): boolean {
    return this.binary() !== null;
  }

  perform(udid: string, input: SimulatorHidInput): Promise<void> {
    const previous = this.queues.get(udid) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const file = this.binary();
        if (!file) throw new Error("This build of Zeros has no simulator input tool.");
        const { args, stdin } = axeInputInvocation(udid, input);
        await this.run(file, args, {
          timeoutMs: input.kind === "drag" ? input.durationMs + 15_000 : 15_000,
          ...(stdin === undefined ? {} : { input: stdin }),
        });
      });
    const settled = next.catch(() => undefined);
    this.queues.set(udid, settled);
    void settled.then(() => {
      if (this.queues.get(udid) === settled) this.queues.delete(udid);
    });
    return next;
  }
}

export function spawnAxeFrameStream(
  binary: () => string | null,
): (udid: string, options: { scale: number; fps: number }) => FrameStreamProcess {
  return (udid, options) => {
    const file = binary();
    if (!file) throw new Error("This build of Zeros has no simulator view tool.");
    return spawn(
      file,
      [
        "stream-video",
        "--udid",
        udid,
        "--format",
        "bgra",
        "--fps",
        String(options.fps),
        "--scale",
        String(options.scale),
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
  };
}
