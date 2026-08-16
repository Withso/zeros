import { describe, expect, it } from "vitest";

import {
  boundaryPortLabel,
  boundaryPortProblemCopy,
} from "../boundary-ports";

describe("boundary port UI copy", () => {
  it("keeps transparent explicit-port parity", () => {
    expect(
      boundaryPortLabel({
        id: "opaque",
        protocol: "tcp",
        port: 5173,
        purpose: "dev-server",
        source: "discovered",
      }),
    ).toBe("localhost:5173");
  });

  it("maps stable health categories to path-neutral remediation", () => {
    expect(boundaryPortProblemCopy("listener-inspection-failed")).toEqual({
      title: "Preview detection is unavailable",
      description:
        "The sandbox could not inspect this session's listeners. Restart the session to retry.",
    });
    expect(
      JSON.stringify(boundaryPortProblemCopy("policy-update-failed")),
    ).not.toMatch(/[/\\]|socket|token|policy path/i);
  });
});
