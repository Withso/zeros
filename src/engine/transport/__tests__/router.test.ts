import { describe, it, expect } from "vitest";
import { MessageRouter } from "../router";
import type { TransportClient } from "../types";
import type { EngineMessage } from "../../types";

type Spy = TransportClient & { sent: EngineMessage[] };
function mockClient(id: string, kind: "local" | "cloud" = "cloud"): Spy {
  const sent: EngineMessage[] = [];
  return { id, kind, send: (m) => sent.push(m), close: () => {}, sent };
}
const msg = (type: string) =>
  ({
    type,
    source: "engine",
    id: type,
    timestamp: 0,
  }) as unknown as EngineMessage;

describe("MessageRouter", () => {
  it("broadcasts a session-scoped message to ALL clients (multiplayer)", () => {
    const r = new MessageRouter();
    const mac = mockClient("mac", "local");
    const web = mockClient("web", "cloud");
    r.register(mac);
    r.register(web);
    r.setOwner("s1", "mac"); // ownership is tracked but no longer gates delivery

    // remote == local: your Mac AND your web watch the same agent stream live.
    r.routeToSession("s1", msg("A"));
    expect(mac.sent.map((m) => m.type)).toEqual(["A"]);
    expect(web.sent.map((m) => m.type)).toEqual(["A"]);
  });

  it("broadcasts even an unowned session to every client (multiplayer)", () => {
    const r = new MessageRouter();
    const localHost = mockClient("desktop", "local");
    const phone = mockClient("phone", "cloud");
    r.register(localHost);
    r.register(phone);
    r.routeToSession("unknown", msg("X"));
    expect(localHost.sent.map((m) => m.type)).toEqual(["X"]);
    expect(phone.sent.map((m) => m.type)).toEqual(["X"]); // remote == local
  });

  it("broadcasts to cloud clients too — your own trusted devices (multiplayer)", () => {
    const r = new MessageRouter();
    const phoneA = mockClient("a", "cloud");
    const phoneB = mockClient("b", "cloud");
    r.register(phoneA);
    r.register(phoneB);
    r.routeToSession("orphan", msg("M"));
    expect(phoneA.sent.map((m) => m.type)).toEqual(["M"]);
    expect(phoneB.sent.map((m) => m.type)).toEqual(["M"]);
  });

  it("broadcast reaches every client", () => {
    const r = new MessageRouter();
    const c1 = mockClient("c1");
    const c2 = mockClient("c2");
    r.register(c1);
    r.register(c2);
    r.broadcast(msg("G"));
    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(1);
    expect(r.clientCount).toBe(2);
  });

  it("unregister drops the client and the sessions it owned", () => {
    const r = new MessageRouter();
    const c1 = mockClient("c1", "cloud");
    const localHost = mockClient("desktop", "local");
    r.register(c1);
    r.register(localHost);
    r.setOwner("s1", "c1");
    r.unregister("c1");
    expect(r.clientCount).toBe(1);

    // s1 is unowned now → falls back to the remaining LOCAL host.
    r.routeToSession("s1", msg("Z"));
    expect(c1.sent).toHaveLength(0);
    expect(localHost.sent.map((m) => m.type)).toEqual(["Z"]);
  });

  it("routeToSession broadcasts regardless of ownership (multiplayer)", () => {
    const r = new MessageRouter();
    const localHost = mockClient("desktop", "local");
    const phone = mockClient("phone", "cloud");
    r.register(localHost);
    r.register(phone);
    r.setOwner("s1", "phone");
    r.clearOwner("s1"); // owner cleared — delivery is unaffected (broadcast)
    r.routeToSession("s1", msg("Q"));
    expect(localHost.sent.map((m) => m.type)).toEqual(["Q"]);
    expect(phone.sent.map((m) => m.type)).toEqual(["Q"]);
  });

  it("broadcastExcept fans out to every client but the originator (DB_CHANGED)", () => {
    const r = new MessageRouter();
    const desktop = mockClient("desktop", "local");
    const web = mockClient("web", "cloud");
    const phone = mockClient("phone", "cloud");
    r.register(desktop);
    r.register(web);
    r.register(phone);
    // The desktop made the write; it already has the change → must NOT echo back.
    r.broadcastExcept("desktop", msg("DB_CHANGED"));
    expect(desktop.sent).toEqual([]);
    expect(web.sent.map((m) => m.type)).toEqual(["DB_CHANGED"]);
    expect(phone.sent.map((m) => m.type)).toEqual(["DB_CHANGED"]);
  });

  it("ownerOf / sessionsOwnedBy reflect current ownership", () => {
    const r = new MessageRouter();
    r.setOwner("s1", "c1");
    r.setOwner("s2", "c1");
    r.setOwner("s3", "c2");
    expect(r.ownerOf("s1")).toBe("c1");
    expect(r.ownerOf("missing")).toBeUndefined();
    expect(r.sessionsOwnedBy("c1").sort()).toEqual(["s1", "s2"]);
    expect(r.sessionsOwnedBy("c2")).toEqual(["s3"]);
    expect(r.sessionsOwnedBy("nobody")).toEqual([]);
    r.clearOwner("s1");
    expect(r.sessionsOwnedBy("c1")).toEqual(["s2"]);
  });
});
