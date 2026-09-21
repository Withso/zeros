import { describe, expect, it } from "vitest";
import {
  assertProviderPreviewEndpoint,
  type CloudProviderPreviewEndpoint,
} from "./provider.js";

const endpoint: CloudProviderPreviewEndpoint = {
  url: "https://provider-preview.example.test/",
  headerName: "x-zeros-runtime-preview",
  headerValue: "opaque-preview-credential",
};
describe("provider-neutral private preview transport", () => {
  it("accepts a provider-specific private header without changing the client capability", () => {
    expect(() => assertProviderPreviewEndpoint(endpoint)).not.toThrow();
    expect(() =>
      assertProviderPreviewEndpoint({
        ...endpoint,
        headerName: "x-daytona-preview-token",
      }),
    ).not.toThrow();
  });

  it.each([
    { url: "https://provider-preview.example.test/?token=secret" },
    { url: "https://user:secret@provider-preview.example.test/" },
    { url: "http://provider-preview.example.test/" },
    { url: "https://provider-preview.example.test/non-proxy-root" },
    { headerName: "x-forwarded-host" },
    { headerName: "x-zeros-preview-capability" },
    { headerName: "x-secret\r\nhost: attacker.test" },
    { headerValue: "secret\r\nother-header: injected" },
    { headerValue: "x".repeat(4097) },
  ])("rejects unsafe private endpoint material (%j)", (override) => {
    expect(() =>
      assertProviderPreviewEndpoint({
        ...endpoint,
        ...override,
      } as CloudProviderPreviewEndpoint),
    ).toThrow("invalid preview endpoint");
  });
});
