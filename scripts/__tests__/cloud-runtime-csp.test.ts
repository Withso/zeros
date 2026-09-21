import { describe, expect, it } from "vitest";
import { buildElectronRendererCsp } from "../../vite.config";
describe("configured cloud actor relay CSP", () => {
  it("allows the exact WSS origin corresponding to a configured HTTPS control plane", () => {
    const csp = buildElectronRendererCsp(
      "https://isolated-api.example.test:8443",
    );
    const connect = csp
      .split(";")
      .find((value) => value.trim().startsWith("connect-src "))!;
    expect(connect.split(/\s+/)).toContain(
      "wss://isolated-api.example.test:8443",
    );
    expect(connect.split(/\s+/)).not.toContain("wss:");
  });
});
