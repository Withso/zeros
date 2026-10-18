import { describe, expect, it } from "vitest";
import { parseCloudSdkCapabilityProof } from "../cloud-sdk-socket";

const fields = ["zeros-cap-pop-v1", "zeros:engine", "11111111-1111-4111-8111-111111111111", "a".repeat(22), "1800000000000", "b".repeat(22), "direct"];
describe("SDK proof handoff to native", () => {
  it("maps the exact canonical message to closed native fields", () => {
    expect(parseCloudSdkCapabilityProof(fields.join("\n"))).toEqual({ aud: fields[1], wsp: fields[2], jti: fields[3], timestampMs: 1800000000000,
      nonce: fields[5], route: "direct" });
  });
  it.each([
    fields.join("\n") + "\nextra",
    fields.join("\n") + "\n",
    fields.map((value, index) => index === 0 ? "arbitrary-signing-domain" : value).join("\n"),
    fields.map((value, index) => index === 4 ? "1.8e12" : value).join("\n"),
    fields.map((value, index) => index === 4 ? "01800000000000" : value).join("\n"),
    fields.map((value, index) => index === 1 ? "zeros:realtime" : value).join("\n"),
    fields.map((value, index) => index === 6 ? "shell" : value).join("\n"),
  ])("refuses arbitrary or noncanonical signing input", message => {
    expect(() => parseCloudSdkCapabilityProof(message)).toThrow();
  });
});
