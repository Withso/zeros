import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  deviceProofMessage,
  deviceProofPayloadDigest,
} from "../device-proof";

const PAYLOAD = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  deviceSessionId: "33333333-3333-4333-8333-333333333333",
  clientSessionId: "44444444-4444-4444-8444-444444444444",
  routes: ["direct", "relay"],
};

describe("device proof message", () => {
  it("canonicalizes JSON with sorted keys and no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  });

  it("digests the payload's canonical JSON with SHA-256", async () => {
    expect(canonicalJson(PAYLOAD)).toBe(
      '{"clientSessionId":"44444444-4444-4444-8444-444444444444","deviceSessionId":"33333333-3333-4333-8333-333333333333","organizationId":"11111111-1111-4111-8111-111111111111","routes":["direct","relay"],"workspaceId":"22222222-2222-4222-8222-222222222222"}',
    );
    // printf '%s' '<canonical JSON above>' | sha256sum, computed outside the code under test.
    await expect(deviceProofPayloadDigest(PAYLOAD)).resolves.toBe(
      "9a43a434fd85a9dbd9cc9584c48d1e23381598d158ed9cdbcb40d305026c53e1",
    );
  });

  it("builds the eight UTF-8 lines the signature covers, joined with newlines", async () => {
    await expect(
      deviceProofMessage({
        accountUserId: "user-1",
        deviceId: "55555555-5555-4555-8555-555555555555",
        keyVersion: 2,
        action: "runtime.connect",
        timestampMs: 1700000000000,
        nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        payload: PAYLOAD,
      }),
    ).resolves.toBe(
      [
        "zeros-cloud-device-proof-v1",
        "user-1",
        "55555555-5555-4555-8555-555555555555",
        "2",
        "runtime.connect",
        "1700000000000",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "9a43a434fd85a9dbd9cc9584c48d1e23381598d158ed9cdbcb40d305026c53e1",
      ].join("\n"),
    );
  });
});
