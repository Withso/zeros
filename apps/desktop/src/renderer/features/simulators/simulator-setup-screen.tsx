import { useMemo, useState } from "react";
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert } from "lucide-react";
import type {
  SimulatorDevice,
  SimulatorHubSnapshot,
  SimulatorPlatform,
} from "@zeros/protocol/simulators";

import { cn } from "../../shared/ui/cn";
import { Button } from "../../shared/ui/primitives/button";
import { ProgressBar } from "../../shared/ui/primitives/progress-bar";
import { SplitButton } from "../../shared/ui/primitives/split-button";
import { checkSimulatorsAgain, runSimulatorSetupAction } from "./simulator-actions";
import { SimulatorDeviceBox } from "./simulator-device-box";
import { SimulatorDeviceMenuContent } from "./simulator-device-menu";
import {
  SETUP_PHONE_SCREEN,
  defaultSimulatorDevice,
  drawnDeviceLayout,
  fitDeviceScale,
  screenSize,
} from "./simulator-geometry";
import { useElementSize } from "./simulator-hooks";
import { simulatorSetup } from "./simulator-hub-store";
import { simulatorSetupRow, type SimulatorSetupRow } from "./simulator-setup-model";

/** Below this screen width the setup reads better without the phone. */
const MIN_FRAMED_SCREEN_WIDTH = 280;

const EMPTY_DEVICES: readonly SimulatorDevice[] = [];

function ToneIcon({ tone, active }: { tone: SimulatorSetupRow["tone"]; active: boolean }) {
  const className = "mt-px size-4 shrink-0";
  switch (tone) {
    case "ready":
      return <CircleCheck aria-hidden className={cn(className, "text-green-primary")} />;
    case "warning":
      return <TriangleAlert aria-hidden className={cn(className, "text-yellow-primary")} />;
    case "error":
      return <CircleAlert aria-hidden className={cn(className, "text-red-primary")} />;
    case "pending":
      return (
        <LoaderCircle
          aria-hidden
          className={cn(className, "text-fg3", active && "motion-safe:animate-spin")}
        />
      );
  }
}

function SetupStatusRow({ row, active }: { row: SimulatorSetupRow; active: boolean }) {
  const [checking, setChecking] = useState(false);
  const { action } = row;
  return (
    <div data-simulator-setup={row.tone} className="bg-bg2 flex flex-col gap-2 rounded-md px-3 py-2.5">
      <div className="flex items-start gap-2">
        <ToneIcon tone={row.tone} active={active} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span aria-live={active ? "polite" : "off"} className="text-fg1 text-xs">
            {row.message}
          </span>
          {row.detail && <span className="text-muted-fg text-2xxs">{row.detail}</span>}
        </div>
      </div>
      {typeof row.progress === "number" && (
        <div className="flex items-center gap-2">
          <ProgressBar value={row.progress} aria-label="Download progress" className="flex-1" />
          <span className="text-muted-fg text-2xxs tabular-nums">{row.progress}%</span>
        </div>
      )}
      {(action || row.checkAgain) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {action && (
            <Button size="compact" onClick={() => void runSimulatorSetupAction(action)}>
              {action.label}
            </Button>
          )}
          {row.checkAgain && (
            <Button
              variant="ghost"
              size="compact"
              disabled={checking}
              aria-busy={checking || undefined}
              onClick={() => {
                setChecking(true);
                void checkSimulatorsAgain().finally(() => setChecking(false));
              }}
            >
              {checking ? "Checking…" : "Check again"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

interface SetupScreenProps {
  platform: SimulatorPlatform;
  snapshot: SimulatorHubSnapshot | null;
  shownElsewhere: ReadonlySet<string>;
  active: boolean;
  newDevice: { label: string; creating: boolean } | null;
  onAttach: (device: SimulatorDevice) => void;
  onCreate: () => void;
}

function SetupContent({
  platform,
  snapshot,
  shownElsewhere,
  active,
  newDevice,
  onAttach,
  onCreate,
}: SetupScreenProps) {
  const devices = snapshot?.devices ?? EMPTY_DEVICES;
  const own = devices.filter((device) => device.platform === platform);
  const row = simulatorSetupRow(simulatorSetup(snapshot, platform), platform, own.length);
  const ready = row.tone === "ready";
  const target = ready ? defaultSimulatorDevice(devices, platform, shownElsewhere) : null;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-fg1 m-0 text-sm font-medium">
          Attach a simulator so your agent can see your app
        </h2>
        <p className="text-fg2 m-0 text-xs">
          Agents can control the simulator and take screenshots of its whole screen.
          Shut-down devices boot automatically.
        </p>
      </div>
      <SetupStatusRow row={row} active={active} />
      <SplitButton
        variant="primary"
        className="w-full"
        disabled={!target}
        menuDisabled={!ready}
        onClick={() => {
          if (target) onAttach(target);
        }}
        menuLabel="Choose a simulator"
        menu={
          <SimulatorDeviceMenuContent
            devices={devices}
            platform={platform}
            newDevice={newDevice}
            onAttach={onAttach}
            onCreate={onCreate}
            align="end"
          />
        }
      >
        Attach simulator
      </SplitButton>
    </div>
  );
}

const TRADEMARKS: Record<SimulatorPlatform, string> = {
  ios: "Xcode is a trademark of Apple Inc., registered in the U.S. and other countries.",
  android: "Android and Android Studio are trademarks of Google LLC.",
};

function TrademarkNote({ platform }: { platform: SimulatorPlatform }) {
  return <p className="text-muted-fg text-xxs m-0">{TRADEMARKS[platform]}</p>;
}

/** What a Simulator tab shows before a device is attached: what's installed,
 * what's missing, and "Attach simulator", on a generic phone when it fits. */
export function SimulatorSetupScreen(props: SetupScreenProps) {
  const { ref, size } = useElementSize(props.active);
  const layout = useMemo(() => drawnDeviceLayout(SETUP_PHONE_SCREEN, "phone"), []);
  const scale = size ? fitDeviceScale(layout, size) : 0;
  const framed = scale * screenSize(SETUP_PHONE_SCREEN).width >= MIN_FRAMED_SCREEN_WIDTH;
  return (
    <div
      ref={ref}
      data-simulator-setup-screen=""
      className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
    >
      {framed ? (
        <SimulatorDeviceBox layout={layout} frame={null} scale={scale} screenClassName="bg-bg1">
          <div className="flex h-full flex-col gap-6 overflow-y-auto px-6 pt-12 pb-8">
            <div className="my-auto">
              <SetupContent {...props} />
            </div>
            <TrademarkNote platform={props.platform} />
          </div>
        </SimulatorDeviceBox>
      ) : (
        <div className="flex max-h-full w-full max-w-xs flex-col gap-6 overflow-y-auto">
          <SetupContent {...props} />
          <TrademarkNote platform={props.platform} />
        </div>
      )}
    </div>
  );
}
