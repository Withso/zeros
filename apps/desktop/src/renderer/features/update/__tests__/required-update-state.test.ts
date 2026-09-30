import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requiredUpdateReady,
  scheduleRequiredUpdateRestart,
} from "../required-update-state";

afterEach(() => vi.useRealTimers());

describe("forced update restart safety", () => {
  const required = {
    minimumVersion: "1.2.3-alpha.12",
    latestVersion: "1.2.3-alpha.20",
  };
  it("waits for native staging of at least the minimum supported version", () => {
    expect(
      requiredUpdateReady(
        {
          kind: "downloading",
          version: required.latestVersion,
          revision: 1,
          downloaded: 100,
        },
        required,
      ),
    ).toBe(false);
    expect(
      requiredUpdateReady(
        { kind: "ready", version: "1.2.3-alpha.9", revision: 2 },
        required,
      ),
    ).toBe(false);
    expect(
      requiredUpdateReady(
        { kind: "ready", version: "1.2.3-alpha.12", revision: 3 },
        required,
      ),
    ).toBe(true);
  });

  it("restarts only after 30 continuous idle seconds", async () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    scheduleRequiredUpdateRestart(() => true, restart);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("cancels when work resumes or staging changes", async () => {
    vi.useFakeTimers();
    const restart = vi.fn();
    const cancel = scheduleRequiredUpdateRestart(() => true, restart);
    await vi.advanceTimersByTimeAsync(20_000);
    cancel();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restart).not.toHaveBeenCalled();
  });

  it("rechecks current activity at the deadline, closing the pre-render race", async () => {
    vi.useFakeTimers();
    let idle = true;
    const restart = vi.fn();
    scheduleRequiredUpdateRestart(() => idle, restart);
    idle = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(restart).not.toHaveBeenCalled();
  });
});
