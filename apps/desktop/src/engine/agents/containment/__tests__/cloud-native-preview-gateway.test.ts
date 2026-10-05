import { describe, expect, it } from "vitest";
import { CloudNativePreviewGatewayFactory } from "../cloud-native-preview-gateway";

describe("native cloud preview navigation", () => {
  it("publishes only opaque identity and display metadata, and retires it", async () => {
    const identity = {
      executionId: "execution-native",
      portId: "A".repeat(32),
    };
    const gateway = await new CloudNativePreviewGatewayFactory().open(
      { targetHost: "127.0.0.1", targetPort: 43001, displayPort: 5173 },
      identity,
    );
    const navigation = await gateway.navigation();
    expect(navigation).toMatchObject({
      url: "http://localhost:5173/",
      admissionUrl: "http://localhost:5173/",
      nativeTarget: identity,
    });
    expect(JSON.stringify(navigation)).not.toContain("43001");
    expect(JSON.stringify(navigation)).not.toContain("127.0.0.1");
    await gateway.close();
    await expect(gateway.navigation()).rejects.toThrow("retired");
  });
  it("refuses to open without an opaque listener identity", async () => {
    await expect(
      new CloudNativePreviewGatewayFactory().open({
        targetHost: "127.0.0.1",
        targetPort: 43001,
        displayPort: 5173,
      }),
    ).rejects.toThrow("unavailable");
  });
});
