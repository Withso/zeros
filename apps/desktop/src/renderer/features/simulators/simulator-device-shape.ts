import { useCallback, useEffect, useState } from "react";
import type { SimulatorDeviceShape } from "@zeros/protocol/simulators";

import { loadSimulatorDeviceShape } from "./simulator-api";
import { simulatorErrorMessage } from "./simulator-notices";

// A device's shape only changes with Xcode, so each is read once per session
// and shared by every tab showing that device.

const MAX_SHAPES = 12;
const reads = new Map<string, Promise<SimulatorDeviceShape | null>>();
const shapes = new Map<string, SimulatorDeviceShape | null>();

function remember(deviceId: string, shape: SimulatorDeviceShape | null): void {
  shapes.delete(deviceId);
  shapes.set(deviceId, shape);
  for (const id of shapes.keys()) {
    if (shapes.size <= MAX_SHAPES) break;
    shapes.delete(id);
  }
}

function readShape(deviceId: string): Promise<SimulatorDeviceShape | null> {
  const pending = reads.get(deviceId);
  if (pending) return pending;
  const read = loadSimulatorDeviceShape(deviceId)
    .then((shape) => {
      remember(deviceId, shape);
      return shape;
    })
    .finally(() => {
      if (reads.get(deviceId) === read) reads.delete(deviceId);
    });
  reads.set(deviceId, read);
  return read;
}

export interface SimulatorDeviceShapeState {
  /** Undefined until read; null when Zeros can't show the device. */
  shape: SimulatorDeviceShape | null | undefined;
  error: string | null;
  retry: () => Promise<void>;
}

export function useSimulatorDeviceShape(deviceId: string): SimulatorDeviceShapeState {
  const [state, setState] = useState<{
    deviceId: string;
    shape: SimulatorDeviceShape | null | undefined;
    error: string | null;
  }>(() => ({ deviceId, shape: shapes.get(deviceId), error: null }));
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (shapes.has(deviceId)) {
      setState({ deviceId, shape: shapes.get(deviceId), error: null });
      return;
    }
    let cancelled = false;
    readShape(deviceId).then(
      (shape) => {
        if (!cancelled) setState({ deviceId, shape, error: null });
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({
            deviceId,
            shape: undefined,
            error: simulatorErrorMessage(error, "Zeros couldn't read the simulator."),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deviceId, attempt]);

  const retry = useCallback(async () => {
    setAttempt((value) => value + 1);
    await readShape(deviceId).catch(() => undefined);
  }, [deviceId]);

  const current =
    state.deviceId === deviceId
      ? state
      : { deviceId, shape: shapes.get(deviceId), error: null };
  return { shape: current.shape, error: current.error, retry };
}

export function resetSimulatorDeviceShapesForTests(): void {
  reads.clear();
  shapes.clear();
}
