import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bridgeConnectionCacheMaxAge,
  onActiveBridgeConnected,
  setActiveBridge,
} from "../active-bridge";
import type { ConnectionStatus, RuntimeClient } from "../ws-client";

class FakeBridge {
  status: ConnectionStatus;
  private listeners = new Set<(status: ConnectionStatus) => void>();

  constructor(status: ConnectionStatus) {
    this.status = status;
  }

  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

function runtimeClient(bridge: FakeBridge): RuntimeClient {
  return bridge as unknown as RuntimeClient;
}

afterEach(() => setActiveBridge(null));

describe("active bridge connection subscriptions", () => {
  it("fires immediately for an already-connected active bridge, marked initial", () => {
    const bridge = new FakeBridge("connected");
    setActiveBridge(runtimeClient(bridge));
    const connected = vi.fn();

    const stop = onActiveBridgeConnected(connected);

    expect(connected).toHaveBeenCalledOnce();
    // The subscribe-time fire is an ordinary component mount in a healthy
    // app — callers must be able to tell it apart from a real (re)connect.
    expect(connected).toHaveBeenCalledWith(runtimeClient(bridge), {
      initial: true,
    });
    stop();
  });

  it("waits for a connecting bridge and fires again after reconnect", () => {
    const bridge = new FakeBridge("connecting");
    setActiveBridge(runtimeClient(bridge));
    const connected = vi.fn();
    const stop = onActiveBridgeConnected(connected);

    expect(connected).not.toHaveBeenCalled();
    bridge.setStatus("connected");
    bridge.setStatus("connected");
    expect(connected).toHaveBeenCalledOnce();
    // An asynchronous connect transition is never the initial mount fire.
    expect(connected).toHaveBeenLastCalledWith(runtimeClient(bridge), {
      initial: false,
    });

    bridge.setStatus("disconnected");
    bridge.setStatus("connected");
    expect(connected).toHaveBeenCalledTimes(2);
    expect(connected).toHaveBeenLastCalledWith(runtimeClient(bridge), {
      initial: false,
    });
    stop();
  });

  it("honors cache freshness only for an ordinary healthy mount", () => {
    const bridge = new FakeBridge("connected");
    setActiveBridge(runtimeClient(bridge));
    const maxAges: number[] = [];
    const stop = onActiveBridgeConnected((_client, { initial }) => {
      maxAges.push(bridgeConnectionCacheMaxAge(initial, 30_000));
    });

    expect(maxAges).toEqual([30_000]);
    bridge.setStatus("disconnected");
    bridge.setStatus("connected");
    expect(maxAges).toEqual([30_000, -1]);
    stop();
  });

  it("moves to a replacement bridge and fully unsubscribes", () => {
    const first = new FakeBridge("connecting");
    const second = new FakeBridge("connecting");
    const connected = vi.fn();
    const stop = onActiveBridgeConnected(connected);

    setActiveBridge(runtimeClient(first));
    setActiveBridge(runtimeClient(second));
    first.setStatus("connected");
    expect(connected).not.toHaveBeenCalled();

    second.setStatus("connected");
    expect(connected).toHaveBeenCalledOnce();
    stop();
    second.setStatus("disconnected");
    second.setStatus("connected");
    expect(connected).toHaveBeenCalledOnce();
  });
});
