import { describe, expect, it } from "vitest";

import {
  parseDeviceStreamFrame,
  type DeviceStreamParseResult,
} from "../device-stream";
import {
  isRuntimeHandshakeFrame,
  parseRuntimeAuthFrame,
} from "../runtime-auth";
import { DEVICE_STREAM_FIXTURES, RUNTIME_AUTH_FIXTURES } from "./fixtures";

describe("parseDeviceStreamFrame", () => {
  it("parses every known frame", () => {
    for (const [type, frame] of Object.entries(DEVICE_STREAM_FIXTURES)) {
      const result = parseDeviceStreamFrame(JSON.stringify(frame));
      expect(result.kind, type).toBe("known");
      if (result.kind === "known") expect(result.frame.t).toBe(type);
    }
  });

  it("ignores unknown event types per the versioning rule", () => {
    const result = parseDeviceStreamFrame(
      JSON.stringify({ t: "catalog.future", c: "c-9", d: { anything: true } }),
    );
    expect(result).toEqual({ kind: "unknown", t: "catalog.future" });
  });

  it("keeps unknown fields on known events untouched", () => {
    const frame = {
      ...(DEVICE_STREAM_FIXTURES["lifecycle.changed"] as object),
      d: {
        ...DEVICE_STREAM_FIXTURES["lifecycle.changed"].d,
        futureField: { nested: [1, 2, 3] },
      },
      futureEnvelope: true,
    };
    const result = parseDeviceStreamFrame(JSON.stringify(frame));
    expect(result.kind).toBe("known");
    if (result.kind === "known" && result.frame.t === "lifecycle.changed") {
      expect(
        (result.frame.d as Record<string, unknown>).futureField,
      ).toEqual({ nested: [1, 2, 3] });
      expect((result.frame as Record<string, unknown>).futureEnvelope).toBe(true);
    }
  });

  it("rejects malformed input without throwing", () => {
    const invalid: DeviceStreamParseResult[] = [
      parseDeviceStreamFrame("not json"),
      parseDeviceStreamFrame(JSON.stringify({ d: {} })),
      parseDeviceStreamFrame(JSON.stringify({ t: 42, d: {} })),
      parseDeviceStreamFrame(JSON.stringify({ t: "ping" })),
      parseDeviceStreamFrame(JSON.stringify(null)),
    ];
    for (const result of invalid) expect(result.kind).toBe("invalid");
  });
});

describe("runtime auth frames", () => {
  it("parses every known handshake frame", () => {
    for (const [type, frame] of Object.entries(RUNTIME_AUTH_FIXTURES)) {
      const result = parseRuntimeAuthFrame(JSON.stringify(frame));
      expect(result.kind, type).toBe("known");
      if (result.kind === "known") expect(result.frame.t).toBe(type);
    }
  });

  it("treats an unknown t-shaped frame as unknown, never as an engine message", () => {
    expect(
      parseRuntimeAuthFrame(JSON.stringify({ t: "auth.future", d: {} })),
    ).toEqual({ kind: "unknown", t: "auth.future" });
  });

  it("tells handshake frames apart from engine messages by t without type", () => {
    expect(isRuntimeHandshakeFrame({ t: "auth.renew", d: {} })).toBe(true);
    expect(isRuntimeHandshakeFrame({ t: "auth.ok", d: {}, type: undefined })).toBe(true);
    // Engine protocol messages carry `type` and never a top-level `t`.
    expect(isRuntimeHandshakeFrame({ type: "request", id: "1" })).toBe(false);
    expect(isRuntimeHandshakeFrame({ t: "auth.ok", d: {}, type: "request" })).toBe(false);
    expect(isRuntimeHandshakeFrame("string")).toBe(false);
    expect(isRuntimeHandshakeFrame(null)).toBe(false);
  });
});
