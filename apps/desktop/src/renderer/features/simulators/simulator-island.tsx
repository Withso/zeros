import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Camera,
  House,
  LoaderCircle,
  Moon,
  PenLine,
  RotateCcw,
  Video,
} from "lucide-react";
import type {
  SimulatorAppearance,
  SimulatorDevice,
  SimulatorInput,
} from "@zeros/protocol/simulators";

import { cn } from "../../shared/ui/cn";
import { Button } from "../../shared/ui/primitives/button";
import { toast } from "../../shared/ui/primitives/elements";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { Separator } from "../../shared/ui/primitives/separator";
import { Toolbar } from "../../shared/ui/primitives/toolbar";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import {
  readSimulatorAppearance,
  rotateSimulator,
  setSimulatorAppearance,
} from "./simulator-api";
import { annotateFromTab } from "./simulator-annotation-actions";
import {
  startRecordingFromTab,
  stopRecordingFromTab,
  takeScreenshotFromTab,
} from "./simulator-capture-actions";
import { formatRecordingElapsed } from "./simulator-capture-model";
import { useSimulatorRecordingStartedAt } from "./simulator-capture-store";
import { rotatedOrientation } from "./simulator-geometry";
import { simulatorErrorMessage } from "./simulator-notices";

/** The device's Light/Dark setting, read again whenever its tab shows it,
 * since agents and Simulator can change it too. */
function useSimulatorAppearance(device: Pick<SimulatorDevice, "id" | "name">, readable: boolean) {
  const deviceId = device.id;
  const [state, setState] = useState<{
    deviceId: string;
    appearance: SimulatorAppearance | null;
  }>(() => ({ deviceId, appearance: null }));
  // A read that started before the user's change would undo it on arrival.
  const changes = useRef(0);

  useEffect(() => {
    if (!readable) return;
    let cancelled = false;
    const started = changes.current;
    readSimulatorAppearance(deviceId).then(
      (appearance) => {
        if (!cancelled && changes.current === started) setState({ deviceId, appearance });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [deviceId, readable]);

  const appearance = state.deviceId === deviceId ? state.appearance : null;
  const change = (next: SimulatorAppearance) => {
    const previous = appearance;
    const name = device.name;
    changes.current += 1;
    const serial = changes.current;
    setState({ deviceId, appearance: next });
    setSimulatorAppearance(deviceId, next).catch((error: unknown) => {
      if (changes.current === serial) setState({ deviceId, appearance: previous });
      toast.error(simulatorErrorMessage(error, `Couldn't change ${name}'s appearance.`), {
        id: `simulator-appearance:${deviceId}`,
      });
    });
  };
  return { appearance, change };
}

/** Rotate: DeviceHub publishes the new orientation as the device starts to
 * turn, and back again if it can't, and the tab turns its frame to match. */
function useSimulatorRotation(device: Pick<SimulatorDevice, "id" | "name" | "orientation">) {
  const [turning, setTurning] = useState(false);
  const deviceId = device.id;
  const turn = () => {
    const name = device.name;
    setTurning(true);
    rotateSimulator(deviceId, rotatedOrientation(device.orientation))
      .catch((error: unknown) => {
        toast.error(simulatorErrorMessage(error, `Couldn't rotate ${name}.`), {
          id: `simulator-rotate:${deviceId}`,
        });
      })
      .finally(() => setTurning(false));
  };
  return { turning, turn };
}

function useScreenshot(device: Pick<SimulatorDevice, "id" | "name">) {
  const [shooting, setShooting] = useState(false);
  const shoot = () => {
    setShooting(true);
    void takeScreenshotFromTab(device).finally(() => setShooting(false));
  };
  return { shooting, shoot };
}

/** Now, every second while `ticking`. */
function useTickingNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

/** Record and Stop. Main says which devices are recording, so a recording
 * outlives the tab; its time ticks only while the tab shows. */
function useRecording(device: Pick<SimulatorDevice, "id" | "name">, active: boolean) {
  const startedAt = useSimulatorRecordingStartedAt(device.id);
  const [busy, setBusy] = useState<"starting" | "saving" | null>(null);
  const recording = startedAt !== null;
  const now = useTickingNow(active && recording);
  const toggle = () => {
    if (busy) return;
    setBusy(recording ? "saving" : "starting");
    void (recording ? stopRecordingFromTab(device) : startRecordingFromTab(device)).finally(() =>
      setBusy(null),
    );
  };
  return {
    recording,
    elapsed: startedAt === null ? 0 : Math.max(0, now - startedAt),
    busy,
    toggle,
  };
}

/** The controls under the device: hardware buttons (with Back on Android),
 * captures and device settings. Inputs wait while an agent uses the device;
 * captures don't, so the user can record what the agent does. */
export function SimulatorIsland({
  tabId,
  device,
  active,
  agentInControl,
  freezing,
  push,
}: {
  tabId: string;
  device: SimulatorDevice;
  active: boolean;
  agentInControl: boolean;
  /** Annotate is capturing the screen to draw on. */
  freezing: boolean;
  push: (input: SimulatorInput) => void;
}) {
  const booted = device.state === "booted";
  const usable = booted && !agentInControl;
  const { appearance, change } = useSimulatorAppearance(device, booted && active);
  const { turning, turn } = useSimulatorRotation(device);
  const { shooting, shoot } = useScreenshot(device);
  const record = useRecording(device, active);
  const dark = appearance === "dark";
  return (
    <Toolbar aria-label={`${device.name} controls`} data-simulator-island="">
      {device.platform === "android" && (
        <Tooltip label="Back">
          <IconButton
            size="compact"
            label="Back"
            disabled={!usable}
            onClick={() => push({ kind: "button", button: "back" })}
          >
            <ArrowLeft aria-hidden />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip label="Home">
        <IconButton
          size="compact"
          label="Home"
          disabled={!usable}
          onClick={() => push({ kind: "button", button: "home" })}
        >
          <House aria-hidden />
        </IconButton>
      </Tooltip>
      <Tooltip label="Rotate">
        <IconButton
          size="compact"
          label="Rotate"
          aria-busy={turning || undefined}
          disabled={!usable || turning}
          onClick={turn}
        >
          {turning ? (
            <LoaderCircle aria-hidden className={cn(active && "motion-safe:animate-spin")} />
          ) : (
            <RotateCcw aria-hidden />
          )}
        </IconButton>
      </Tooltip>
      <Separator orientation="vertical" className="mx-0.5 h-4" />
      <Tooltip label="Screenshot">
        <IconButton
          size="compact"
          label="Screenshot"
          aria-busy={shooting || undefined}
          disabled={!booted || shooting}
          onClick={shoot}
        >
          <Camera aria-hidden />
        </IconButton>
      </Tooltip>
      {record.recording ? (
        <Tooltip label="Stop recording">
          <Button
            size="compact"
            variant="ghost"
            aria-label={`Stop recording ${formatRecordingElapsed(record.elapsed)}`}
            data-simulator-recording=""
            disabled={record.busy !== null}
            onClick={record.toggle}
          >
            <span aria-hidden className="bg-red-primary size-2 rounded-full" />
            <span className="tabular-nums">{formatRecordingElapsed(record.elapsed)}</span>
          </Button>
        </Tooltip>
      ) : (
        <Tooltip label={record.busy === "saving" ? "Saving recording" : "Record"}>
          <IconButton
            size="compact"
            label={record.busy === "saving" ? "Saving recording" : "Record"}
            aria-busy={record.busy !== null || undefined}
            disabled={!booted || record.busy !== null}
            onClick={record.toggle}
          >
            {record.busy ? (
              <LoaderCircle aria-hidden className={cn(active && "motion-safe:animate-spin")} />
            ) : (
              <Video aria-hidden />
            )}
          </IconButton>
        </Tooltip>
      )}
      <Tooltip label="Annotate">
        <IconButton
          size="compact"
          label="Annotate"
          data-simulator-annotate-start=""
          aria-busy={freezing || undefined}
          disabled={!booted || freezing}
          onClick={() => void annotateFromTab(tabId, device)}
        >
          {freezing ? (
            <LoaderCircle aria-hidden className={cn(active && "motion-safe:animate-spin")} />
          ) : (
            <PenLine aria-hidden />
          )}
        </IconButton>
      </Tooltip>
      <Separator orientation="vertical" className="mx-0.5 h-4" />
      <Tooltip label="Dark appearance">
        <IconButton
          size="compact"
          label="Dark appearance"
          aria-pressed={dark}
          disabled={!usable}
          className={cn(dark && "bg-bg2-hover text-fg1")}
          onClick={() => change(dark ? "light" : "dark")}
        >
          <Moon aria-hidden />
        </IconButton>
      </Tooltip>
    </Toolbar>
  );
}
