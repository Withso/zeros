import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL, checkpointHintKey } from "../cloud-workspaces/engine-checkpoint-hints.js";
import { UPLINK_CHECKPOINT_REQUEST_CHANNEL, UPLINK_CRED_REVISION_CHANNEL, handleUplinkNotification } from "./uplink-notifications.js";

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

describe("checkpoint request notification parsing", () => {
  const route = (payload: string, channel: string = UPLINK_CHECKPOINT_REQUEST_CHANNEL) => {
    const server = { ownerChanged: vi.fn(), revalidate: vi.fn(), revalidateWorkspace: vi.fn() };
    const cred = { revisionChanged: vi.fn() };
    const checkpoint = { requested: vi.fn() };
    handleUplinkNotification(server, channel, payload, cred, checkpoint);
    expect(server.ownerChanged).not.toHaveBeenCalled();
    expect(server.revalidate).not.toHaveBeenCalled();
    expect(server.revalidateWorkspace).not.toHaveBeenCalled();
    return { requested: checkpoint.requested, revisionChanged: cred.revisionChanged };
  };

  it("listens on the enqueue channel and routes its exact key", () => {
    expect(UPLINK_CHECKPOINT_REQUEST_CHANNEL).toBe(CLOUD_ENGINE_CHECKPOINT_HINT_CHANNEL);
    const workspace = randomUUID();
    const routed = route(checkpointHintKey(workspace, 3));
    expect(routed.requested).toHaveBeenCalledWith(workspace, 3);
    expect(routed.revisionChanged).not.toHaveBeenCalled();
    expect(route(`${workspace}:4294967296`).requested).toHaveBeenCalledWith(workspace, 4_294_967_296);
  });

  it.each([
    ["an uppercase workspace", (workspace: string) => `${workspace.toUpperCase()}:3`],
    ["a zero generation", (workspace: string) => `${workspace}:0`],
    ["a leading zero", (workspace: string) => `${workspace}:03`],
    ["an eleven-digit generation", (workspace: string) => `${workspace}:12345678901`],
    ["an extra segment", (workspace: string) => `${workspace}:3:extra`],
    ["a missing generation", (workspace: string) => `${workspace}:`],
    ["a non-uuid workspace", () => "workspace:3"],
  ])("ignores a checkpoint request payload with %s", (_name, payload) => {
    expect(route(payload(randomUUID())).requested).not.toHaveBeenCalled();
  });

  it("keeps the credential channel's payloads away from the checkpoint push, and runs without one", () => {
    const engine = randomUUID();
    const routed = route(`${engine}:7`, UPLINK_CRED_REVISION_CHANNEL);
    expect(routed.requested).not.toHaveBeenCalled();
    expect(routed.revisionChanged).toHaveBeenCalledWith(engine, 7);
    const server = { ownerChanged: vi.fn(), revalidate: vi.fn(), revalidateWorkspace: vi.fn() };
    expect(() => handleUplinkNotification(server, UPLINK_CHECKPOINT_REQUEST_CHANNEL, checkpointHintKey(randomUUID(), 1))).not.toThrow();
  });
});
