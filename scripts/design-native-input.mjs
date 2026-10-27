import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { nativeDesignWheelDelta } from "./design-native-view.mjs";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("./design-native-input.py", import.meta.url));

/** CDP's individual mouseWheel commands synthesize an end phase per command.
 * A real trackpad has one begin, continuous changes, then an empty end. Keep
 * CDP coverage for its transport, but qualify native latency with this stream. */
export function macDesignGesturePlan({ pid, name, startZoom, x, y, steps = 720, rateHz = 120 }) {
  assert(Number.isSafeInteger(pid) && pid > 0, "A native gesture needs its isolated app PID.");
  assert(Number.isFinite(x) && Number.isFinite(y), "A native gesture needs screen coordinates.");
  assert(Number.isSafeInteger(steps) && steps > 0 && steps <= 2400 && steps % 4 === 0);
  assert(Number.isFinite(rateHz) && rateHz >= 30 && rateHz <= 240);
  const events = Array.from({ length: steps }, (_, step) => {
    const { deltaX, deltaY, modifiers } = nativeDesignWheelDelta({ name, step, steps, startZoom });
    return { deltaX, deltaY, modifiers, phase: step === 0 ? 1 : 2 };
  });
  events.push({ deltaX: 0, deltaY: 0, modifiers: events[0].modifiers, phase: 4 });
  return { pid, x, y, rateHz, events };
}

export async function dispatchMacDesignGesture(input, { signal, run = execute, platform = process.platform } = {}) {
  assert.equal(platform, "darwin", "Native gesture qualification requires macOS.");
  const plan = macDesignGesturePlan(input);
  let stdout;
  try {
    ({ stdout } = await run("/usr/bin/python3", [helper, JSON.stringify(plan)], {
      signal, timeout: Math.ceil(plan.events.length / plan.rateHz * 1000) + 10_000,
      maxBuffer: 16 * 1024,
    }));
  } catch (error) {
    // execFile puts the complete serialized gesture in its message. Keep the
    // helper's bounded failure reason so a saved report remains recoverable;
    // neither the original error/cause nor arbitrary child output belongs in it.
    const reason = typeof error?.stderr === "string" ? error.stderr.split("\n")
      .findLast(line => /^(?:RuntimeError|InterruptedError|AssertionError):/.test(line)) : undefined;
    throw new Error(`Native gesture subprocess failed${reason ? `: ${reason.slice(0, 512)}` : "."}`);
  }
  const receipt = JSON.parse(stdout);
  assert(receipt.backend === "CoreGraphics" && receipt.pid === plan.pid &&
    Number.isSafeInteger(receipt.windowId) && receipt.windowId > 0 &&
    receipt.dispatched === plan.events.length - 1 && receipt.ended === true &&
    receipt.rateHz === plan.rateHz && Number.isFinite(receipt.durationMs) && receipt.durationMs > 0,
  "The native gesture did not confirm complete delivery to its isolated app.");
  return receipt;
}
