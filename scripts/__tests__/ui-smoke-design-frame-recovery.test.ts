import { describe, expect, it } from "vitest";

import { runDesignFrameRecoverySmoke } from "../ui-smoke-design-frame-recovery.mjs";

function immediateNativeFailure(failObservation = false) {
  const stop = new Error("Readiness assertions completed");
  const observationFailure = new Error("Readiness observation failed");
  const routes = new Map<string, (route: unknown) => Promise<void>>();
  const checks: string[] = [];
  let nativeFrame = false;
  let response: Promise<void> | undefined;
  let evaluations = 0;
  const page = {
    url: () => "http://127.0.0.1:4100/harness.html",
    route: async (
      pattern: string,
      handler: (route: unknown) => Promise<void>,
    ) => {
      routes.set(pattern, handler);
    },
    unroute: async (pattern: string) => {
      if (pattern === "**/__design-native/**") await response;
      routes.delete(pattern);
    },
    setViewportSize: async () => {},
    goto: async () => {},
    locator: () => ({
      waitFor: async () => {},
      getAttribute: async () => null,
      count: async () => 0,
    }),
    evaluate: async () => {
      if (evaluations++ > 0) return true;
      nativeFrame = true;
      response = routes.get("**/__design-native/**")!({
        request: () => ({
          url: () =>
            `http://127.0.0.1:4100/__design-native/${"c".repeat(64)}/home.html`,
        }),
        // A native response can complete before Playwright's next observation.
        fulfill: async () => {
          nativeFrame = false;
        },
      });
      return { "home.html": "<!doctype html><h1>Fixture</h1>" };
    },
    waitForFunction: async () => {
      if (failObservation) throw observationFailure;
      await Promise.resolve();
      if (!nativeFrame)
        throw new Error(
          "Native fallback completed before readiness observation",
        );
    },
  };
  return {
    page,
    stop,
    observationFailure,
    checks,
    responseFinished: () => !nativeFrame,
    check: (name: string, ok: boolean) => {
      expect(ok, name).toBe(true);
      checks.push(name);
      if (
        name ===
        "a frame without a handshake cannot receive inspection requests"
      )
        throw stop;
    },
  };
}

describe("Design frame recovery smoke synchronization", () => {
  it("observes reset readiness before a fast native failure can finish fallback", async () => {
    const fixture = immediateNativeFailure();

    await expect(
      runDesignFrameRecoverySmoke({ page: fixture.page, check: fixture.check }),
    ).rejects.toBe(fixture.stop);

    expect(fixture.checks).toEqual([
      "a changed engine capability resets frame readiness",
      "a frame without a handshake cannot receive inspection requests",
    ]);
    expect(fixture.responseFinished()).toBe(true);
  });

  it("releases an in-flight native response when readiness observation fails", async () => {
    const fixture = immediateNativeFailure(true);

    await expect(
      runDesignFrameRecoverySmoke({ page: fixture.page, check: fixture.check }),
    ).rejects.toBe(fixture.observationFailure);

    expect(fixture.responseFinished()).toBe(true);
  });
});
