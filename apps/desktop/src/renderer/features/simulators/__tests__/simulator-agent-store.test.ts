import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceUseStateSnapshot } from "@zeros/protocol/device-tools";

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
  listen: vi.fn<(event: string, handler: (payload: unknown) => void) => Promise<() => void>>(),
  handlers: new Map<string, (payload: unknown) => void>(),
}));

vi.mock("../../../platform/runtime", () => ({
  nativeInvoke: native.invoke,
  nativeListen: native.listen,
}));

import {
  clearSimulatorAgentState,
  followSimulatorAgents,
  listenToSimulatorAgentTouches,
  publishSimulatorAgentState,
  publishSimulatorAgentTouch,
  simulatorAgentHolder,
  simulatorAgentState,
} from "../simulator-agent-store";

const PHONE = "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108";
const TABLET = "3C744E00-19C9-4872-8106-A474ADDDFA96";

function holders(deviceIds: string[]): DeviceUseStateSnapshot {
  return {
    version: 1,
    holders: deviceIds.map((deviceId) => ({
      workspaceId: "workspace-a",
      conversationId: "conversation-a",
      agent: "codex",
      deviceId,
      deviceName: deviceId === PHONE ? "iPhone 17" : "iPad Air",
      platform: "ios",
    })),
  } as DeviceUseStateSnapshot;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  clearSimulatorAgentState();
  native.invoke.mockReset();
  native.listen.mockReset();
  native.handlers.clear();
  native.listen.mockImplementation(async (event, handler) => {
    native.handlers.set(event, handler);
    return () => native.handlers.delete(event);
  });
});

describe("simulator agents in the renderer", () => {
  it("keeps the latest valid holders and finds each device's", () => {
    expect(publishSimulatorAgentState(holders([PHONE]))).toBe(true);
    const holder = simulatorAgentHolder(PHONE);
    expect(holder).toMatchObject({ agent: "codex", deviceName: "iPhone 17" });
    // The same holder object until main publishes again, for stable selectors.
    expect(simulatorAgentHolder(PHONE)).toBe(holder);
    expect(simulatorAgentHolder(TABLET)).toBeNull();
    expect(publishSimulatorAgentState({ version: 1, holders: "all" })).toBe(false);
    expect(simulatorAgentHolder(PHONE)).toBe(holder);
    clearSimulatorAgentState();
    expect(simulatorAgentState()).toBeNull();
  });

  it("hands each touch only to the screens showing its device", () => {
    const phone = vi.fn();
    const tablet = vi.fn();
    const stopPhone = listenToSimulatorAgentTouches(PHONE, phone);
    listenToSimulatorAgentTouches(TABLET, tablet);
    expect(publishSimulatorAgentTouch({ deviceId: PHONE, kind: "tap", at: { x: 10, y: 20 } })).toBe(
      true,
    );
    expect(publishSimulatorAgentTouch({ deviceId: PHONE, kind: "poke", at: { x: 1, y: 1 } })).toBe(
      false,
    );
    expect(phone).toHaveBeenCalledExactlyOnceWith({
      deviceId: PHONE,
      kind: "tap",
      at: { x: 10, y: 20 },
    });
    expect(tablet).not.toHaveBeenCalled();
    stopPhone();
    publishSimulatorAgentTouch({ deviceId: PHONE, kind: "tap", at: { x: 10, y: 20 } });
    expect(phone).toHaveBeenCalledTimes(1);
  });

  it("follows main's events, and a live event beats the recovery read", async () => {
    const read = deferred<unknown>();
    native.invoke.mockReturnValueOnce(read.promise);
    const stop = followSimulatorAgents();
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("simulator_agent_state"));
    native.handlers.get("simulator-agent-state")?.(holders([TABLET]));
    read.resolve(holders([PHONE]));
    await Promise.resolve();
    await Promise.resolve();
    expect(simulatorAgentHolder(TABLET)).not.toBeNull();
    expect(simulatorAgentHolder(PHONE)).toBeNull();

    const touch = vi.fn();
    listenToSimulatorAgentTouches(TABLET, touch);
    native.handlers.get("simulator-agent-touch")?.({
      deviceId: TABLET,
      kind: "long-press",
      at: { x: 5, y: 6 },
    });
    expect(touch).toHaveBeenCalledTimes(1);

    stop();
    expect(simulatorAgentState()).toBeNull();
    expect(native.handlers.size).toBe(0);
  });

  it("takes the recovery read when no event came first", async () => {
    native.invoke.mockResolvedValueOnce(holders([PHONE]));
    const stop = followSimulatorAgents();
    await vi.waitFor(() => expect(simulatorAgentHolder(PHONE)).not.toBeNull());
    stop();
  });
});
