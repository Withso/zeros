import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { initialAgentControlAvailability } from "@zeros/protocol/agent-control-rollout";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { agentControlAvailability } from "../agent-control/availability";
import { ZerosEngine } from "../index";

interface HostControlInternals {
  handleHostControlLine(line: string): void;
  publishPrivateHostControl(line: string): void;
}

const REQUEST_ID = "6f1c2a52-3b5e-4f1d-9a51-0c8e2f7d4b10";
const OPEN = { zerosBrowser: true, computerUse: true, simulators: true, localOrchestration: true };

describe("the desktop app's agent control rollout", () => {
  let root: string;
  let state: HostControlInternals;
  let frames: unknown[];

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-agent-control-rollout-")),
    );
    state = new ZerosEngine({
      root,
      port: 29_886,
    }) as unknown as HostControlInternals;
    frames = [];
    vi.spyOn(state, "publishPrivateHostControl").mockImplementation((line) => {
      expect(line.endsWith("\n")).toBe(true);
      frames.push(JSON.parse(line));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    state.handleHostControlLine(
      JSON.stringify({
        type: "host.agentControlAvailability",
        availability: initialAgentControlAvailability(),
      }),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("applies a push and confirms it by request ID only", () => {
    state.handleHostControlLine(
      JSON.stringify({
        type: "host.agentControlAvailability",
        requestId: REQUEST_ID,
        availability: OPEN,
      }),
    );

    expect(agentControlAvailability()).toEqual(OPEN);
    expect(frames).toEqual([
      { type: "engine.agentControlAvailabilityApplied", requestId: REQUEST_ID },
    ]);
  });

  it("ignores a malformed push and leaves the last one in force", () => {
    state.handleHostControlLine(
      JSON.stringify({
        type: "host.agentControlAvailability",
        requestId: REQUEST_ID,
        availability: OPEN,
      }),
    );
    frames.length = 0;
    for (const availability of [
      null,
      { zerosBrowser: false, computerUse: false },
      { ...OPEN, simulators: "no" },
      { ...OPEN, localOrchestration: "yes" },
    ]) {
      state.handleHostControlLine(
        JSON.stringify({
          type: "host.agentControlAvailability",
          requestId: REQUEST_ID,
          availability,
        }),
      );
    }

    expect(agentControlAvailability()).toEqual(OPEN);
    expect(frames).toEqual([]);
  });

  it("applies a push from a renderer that predates the Local CLI and keeps it closed", () => {
    const { localOrchestration: _omitted, ...older } = OPEN;
    state.handleHostControlLine(
      JSON.stringify({
        type: "host.agentControlAvailability",
        requestId: REQUEST_ID,
        availability: older,
      }),
    );

    expect(agentControlAvailability()).toEqual({ ...OPEN, localOrchestration: false });
    expect(frames).toEqual([
      { type: "engine.agentControlAvailabilityApplied", requestId: REQUEST_ID },
    ]);
  });

  it("applies a push with an unusable request ID without confirming it", () => {
    state.handleHostControlLine(
      JSON.stringify({
        type: "host.agentControlAvailability",
        requestId: "not-a-request",
        availability: { ...OPEN, computerUse: false },
      }),
    );

    expect(agentControlAvailability()).toEqual({ ...OPEN, computerUse: false });
    expect(frames).toEqual([]);
  });
});
