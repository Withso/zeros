import { describe, expect, it } from "vitest";
import * as service from "./bridge-close-diagnostic.js";
import * as protocol from "../../../../packages/protocol/src/cloud-bridge-diagnostics.js";

describe("bridge close diagnostics", () => {
  it("mirrors the protocol's allow-listed close reasons", () => {
    expect(service.CLOUD_BRIDGE_CLOSE_REASONS).toEqual(protocol.CLOUD_BRIDGE_CLOSE_REASONS);
  });

  it("classifies closes exactly like the desktop client", () => {
    const cases: Array<[unknown, unknown]> = [
      ...Object.keys(protocol.CLOUD_BRIDGE_CLOSE_REASONS).map((reason): [unknown, unknown] => [1008, reason]),
      [1006, ""], [1000, ""], [1011, "unlisted engine text"], [999, "CONNECTED required"], [5000, ""],
      [1008.5, ""], ["1008", "CONNECTED required"], [null, undefined], [undefined, Buffer.from("x")],
    ];
    for (const [code, reason] of cases)
      expect(service.cloudBridgeCloseDiagnostic(code, reason)).toEqual(protocol.cloudBridgeCloseDiagnostic(code, reason));
  });

  it("never echoes close reason text", () => {
    expect(service.cloudBridgeCloseDiagnostic(1008, "token=secret")).toEqual({ code: 1008, class: "other" });
  });
});
