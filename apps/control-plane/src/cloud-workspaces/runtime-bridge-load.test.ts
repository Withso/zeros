import { describe, expect, it } from "vitest";
import {
  boundedScenario,
  parseArguments,
  type LoadScenario,
} from "./runtime-bridge-load.js";

const scenario: LoadScenario = {
  name: "local-only",
  traffic: "realistic",
  pairs: 2,
  adversarial: 0,
  workspaces: 1,
  durationMs: 100,
  messageBytes: 64 * 1024 * 1024,
  relay: {},
};

describe("relay load harness safety", () => {
  it("validates relay bounds before opening any sockets or child process", () => {
    expect(() =>
      boundedScenario({ ...scenario, relay: { maxConnections: 0 } }),
    ).toThrow("invalid relay bound");
  });

  it("rejects misspelled flags instead of measuring the wrong envelope", () => {
    expect(() => parseArguments(["--inboud-mib", "64"])).toThrow(
      "unknown option",
    );
  });

  it("bounds workload dimensions", () => {
    for (const invalid of [
      { pairs: 513 },
      { pairs: 0 },
      { adversarial: 3 },
      { workspaces: 3 },
      { durationMs: 60_001 },
      { messageBytes: 64 * 1024 * 1024 + 1 },
    ])
      expect(() => boundedScenario({ ...scenario, ...invalid })).toThrow(
        "must be an integer",
      );
    expect(boundedScenario(scenario)).toMatchObject(scenario);
  });
});
