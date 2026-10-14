import { describe, expect, it } from "vitest";
import { RuntimeTelemetry } from "../zeros-dev/runtime-telemetry";
import type { RuntimeClientEnvironment } from "../../apps/desktop/src/renderer/platform/bridge/runtime-client";

function fixture() {
  const sockets: EventTarget[] = [];
  const env = { createWebSocket: () => { const socket = new EventTarget(); sockets.push(socket); return socket; } } as unknown as RuntimeClientEnvironment;
  const telemetry = new RuntimeTelemetry(), wrapped = telemetry.wrap(env);
  const connect = (channel = "direct-provider-websocket") => {
    telemetry.target(channel); wrapped.createWebSocket("wss://synthetic.invalid/never-opened", []);
    return sockets.at(-1)!;
  };
  const close = (socket: EventTarget, code = 1006, reason = "") => {
    const event = Object.assign(new Event("close"), { code, reason }); socket.dispatchEvent(event);
  };
  return { telemetry, connect, close, sockets };
}
describe("unthrottled, value-free harness transport counts", () => {
  it("keeps failed direct attempts distinct from a successful relay fallback", () => {
    const f = fixture(), direct = f.connect(); f.close(direct);
    const relay = f.connect("control-plane-websocket"); f.telemetry.status("connected"); f.telemetry.status("connected");
    f.telemetry.expectDisconnect(); f.close(relay, 1000);
    expect(f.telemetry.snapshot()).toMatchObject({ coverage: "complete", directAttempts: 1, directReady: 0, relayAttempts: 1, relayReady: 1, lostConnections: 0 });
  });
  it("counts every ready close beyond the logger limit and never copies a close reason", () => {
    const f = fixture();
    for (let i = 0; i < 12; i++) { const socket = f.connect(); f.telemetry.status("connected"); f.close(socket, 4001, "synthetic-private-close"); }
    const result = f.telemetry.snapshot();
    expect(result).toMatchObject({ directAttempts: 12, directReady: 12, lostConnections: 12, firstClose: "other", coverage: "complete" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-close");
  });
  it("does not explain an authority refusal merely because client detach was requested", () => {
    const f = fixture(), socket = f.connect(); f.telemetry.status("connected"); f.telemetry.expectDisconnect();
    f.close(socket, 4001, "client authority revoked");
    expect(f.telemetry.snapshot()).toMatchObject({ authorityCloses: 1, unexplainedAuthorityCloses: 1, firstClose: "authority_revoked" });
  });
  it("refuses a false zero if socket observation is unavailable", () => {
    const telemetry = new RuntimeTelemetry(); telemetry.target("direct-provider-websocket");
    telemetry.wrap({ createWebSocket: () => ({}) } as never).createWebSocket("wss://synthetic.invalid", []);
    expect(telemetry.snapshot()).toMatchObject({ coverage: "unavailable", directAttempts: 1, directReady: 0 });
  });
});
