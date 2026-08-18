import { describe, expect, it } from "vitest";

import { AdmissionCancelledError, AdmissionGate } from "../admission-gate";

/** A job whose completion the test controls, so ordering is deterministic
 *  rather than timing-dependent. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks settle so the gate's drain can run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("admission gate", () => {
  it("runs at most `limit` admissions at once", async () => {
    const gate = new AdmissionGate({ limit: 2 });
    const jobs = [deferred(), deferred(), deferred()];
    const started: number[] = [];

    const runs = jobs.map((job, index) =>
      gate.run("interactive", async () => {
        started.push(index);
        await job.promise;
      }),
    );
    await settle();

    expect(started).toEqual([0, 1]);
    expect(gate.snapshot().running).toBe(2);

    jobs[0]!.resolve();
    await settle();
    expect(started).toEqual([0, 1, 2]);

    jobs[1]!.resolve();
    jobs[2]!.resolve();
    await Promise.all(runs);
    expect(gate.snapshot()).toEqual({
      running: 0,
      runningBackground: 0,
      queued: 0,
    });
  });

  it("lets an interactive admission jump ahead of queued background work", async () => {
    // The real case: five chat-title one-shots are queued when the user starts
    // a chat. The chat must not wait for all five.
    const gate = new AdmissionGate({ limit: 2 });
    const blocker = deferred();
    const titlesBlocker = deferred();
    const order: string[] = [];

    const running = gate.run("interactive", async () => {
      order.push("running");
      await blocker.promise;
    });
    await settle();

    const background = [0, 1, 2].map((index) =>
      gate.run("background", async () => {
        order.push(`title-${index}`);
        await titlesBlocker.promise;
      }),
    );
    await settle();
    // One background slot is available, so exactly one title got in.
    expect(order).toEqual(["running", "title-0"]);

    // The user starts a chat. It is queued LAST, behind two titles.
    const interactive = gate.run("interactive", async () => {
      order.push("session");
    });
    blocker.resolve();
    await settle();

    expect(order).toContain("session");
    expect(order).not.toContain("title-1");

    titlesBlocker.resolve();
    await Promise.all([running, interactive, ...background]);
    expect(order.indexOf("session")).toBeLessThan(order.indexOf("title-1"));
  });

  it("never lets background work occupy every slot", async () => {
    const gate = new AdmissionGate({ limit: 2 });
    const jobs = [deferred(), deferred()];

    const runs = jobs.map((job) =>
      gate.run("background", async () => {
        await job.promise;
      }),
    );
    await settle();

    expect(gate.snapshot()).toMatchObject({ running: 1, runningBackground: 1 });

    jobs[0]!.resolve();
    jobs[1]!.resolve();
    await Promise.all(runs);
  });

  it("reports the queue wait so a gated admission cannot log as fast", async () => {
    // Stage timers only start once a slot is held. Without the wait, a session
    // that queued for ten seconds logs a two-second admission while the user
    // watches a spinner — the exact measurement mistake this work started from.
    const gate = new AdmissionGate({ limit: 1 });
    const blocker = deferred();
    const first = gate.run("interactive", async () => {
      await blocker.promise;
    });

    let observed: { waitedMs: number; runningOnEntry: number } | null = null;
    const second = gate.run("interactive", async (slot) => {
      observed = { ...slot };
    });
    await settle();
    expect(observed).toBeNull();

    blocker.resolve();
    await Promise.all([first, second]);
    expect(observed).not.toBeNull();
    expect(observed!.waitedMs).toBeGreaterThanOrEqual(0);
    expect(observed!.runningOnEntry).toBe(0);

    // The admission that never queued reports no wait behind it.
    let solo: number | null = null;
    await gate.run("interactive", async (slot) => {
      solo = slot.runningOnEntry;
    });
    expect(solo).toBe(0);
  });

  it("releases the slot when an admission is refused", async () => {
    // Admission fails closed by design, so rejection is the common path — a
    // refused boundary must not permanently shrink the gate.
    const gate = new AdmissionGate({ limit: 1 });

    await expect(
      gate.run("interactive", async () => {
        throw new Error("ZSR is unavailable");
      }),
    ).rejects.toThrow("ZSR is unavailable");

    expect(gate.snapshot().running).toBe(0);
    await expect(gate.run("interactive", async () => "admitted")).resolves.toBe(
      "admitted",
    );
  });

  it("keeps background work reachable when nothing interactive is waiting", async () => {
    const gate = new AdmissionGate({ limit: 2 });
    await expect(gate.run("background", async () => "title")).resolves.toBe(
      "title",
    );
  });

  it("cancels a queued admission without it ever holding a slot", async () => {
    // The real case: the user creates a chat, immediately closes it, and
    // creates another. Before cancellation, the closed chat's admission still
    // built a full world (5-9 s of stage work) plus a proven teardown, in
    // front of the chat the user actually kept.
    const gate = new AdmissionGate({ limit: 1 });
    const blocker = deferred();
    const first = gate.run("interactive", async () => {
      await blocker.promise;
    });

    const controller = new AbortController();
    let ran = false;
    const cancelled = gate.run(
      "interactive",
      async () => {
        ran = true;
      },
      { signal: controller.signal },
    );
    await settle();
    expect(gate.snapshot().queued).toBe(1);

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(AdmissionCancelledError);
    expect(ran).toBe(false);
    expect(gate.snapshot().queued).toBe(0);

    // The gate is undamaged: the running admission finishes and a later one
    // still gets the slot.
    blocker.resolve();
    await first;
    await expect(gate.run("interactive", async () => "next")).resolves.toBe(
      "next",
    );
  });

  it("ignores cancellation once the admission holds a slot", async () => {
    // Once admit() starts building, aborting it would leave half-built live
    // resources outside the proven-teardown path. The caller's own stale-bind
    // check retires the finished boundary instead.
    const gate = new AdmissionGate({ limit: 1 });
    const blocker = deferred();
    const controller = new AbortController();

    const run = gate.run(
      "interactive",
      async () => {
        await blocker.promise;
        return "built";
      },
      { signal: controller.signal },
    );
    await settle();
    controller.abort();
    blocker.resolve();
    await expect(run).resolves.toBe("built");
    expect(gate.snapshot().running).toBe(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const gate = new AdmissionGate({ limit: 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      gate.run("interactive", async () => "never", {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(AdmissionCancelledError);
    expect(gate.snapshot()).toEqual({
      running: 0,
      runningBackground: 0,
      queued: 0,
    });
  });

  it("a cancelled waiter does not block later queue drains", async () => {
    // Splicing the waiter out must leave the queue drainable: the admission
    // behind the cancelled one runs as soon as the slot frees.
    const gate = new AdmissionGate({ limit: 1 });
    const blocker = deferred();
    const first = gate.run("interactive", async () => {
      await blocker.promise;
    });
    const controller = new AbortController();
    const cancelled = gate.run("interactive", async () => "cancelled", {
      signal: controller.signal,
    });
    const order: string[] = [];
    const third = gate.run("interactive", async () => {
      order.push("third");
    });
    await settle();
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(AdmissionCancelledError);

    blocker.resolve();
    await Promise.all([first, third]);
    expect(order).toEqual(["third"]);
  });

  it("clamps a nonsensical configuration instead of stalling", () => {
    expect(
      new AdmissionGate({ limit: 0, backgroundLimit: 0 }).snapshot(),
    ).toEqual({ running: 0, runningBackground: 0, queued: 0 });
    // limit 1 cannot reserve a slot away from background, or background would
    // never run at all.
    const gate = new AdmissionGate({ limit: 1 });
    void gate.run("background", async () => undefined);
    expect(gate.snapshot().running).toBe(1);
  });
});
