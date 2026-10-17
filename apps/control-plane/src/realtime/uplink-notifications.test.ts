import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { UPLINK_CRED_REVISION_CHANNEL, handleUplinkNotification } from "./uplink-notifications.js";

describe("uplink notification parsing", () => {
  const route = (payload: string) => {
    const server = { ownerChanged: vi.fn(), revalidate: vi.fn(), revalidateWorkspace: vi.fn() };
    const cred = { revisionChanged: vi.fn() };
    handleUplinkNotification(server, UPLINK_CRED_REVISION_CHANNEL, payload, cred);
    return cred.revisionChanged;
  };

  it("routes a well-formed credential revision payload", () => {
    const engine = randomUUID();
    expect(route(`${engine}:7`)).toHaveBeenCalledWith(engine, 7);
  });

  it.each([
    ["an extra segment", (engine: string) => `${engine}:7:extra`],
    ["an empty trailing segment", (engine: string) => `${engine}:7:`],
    ["a non-decimal revision", (engine: string) => `${engine}:0x7`],
    ["an exponent revision", (engine: string) => `${engine}:7e0`],
    ["a zero revision", (engine: string) => `${engine}:0`],
    ["a missing revision", (engine: string) => `${engine}:`],
    ["a non-uuid engine", () => "engine:7"],
  ])("ignores a credential revision payload with %s", (_name, payload) => {
    expect(route(payload(randomUUID()))).not.toHaveBeenCalled();
  });
});
