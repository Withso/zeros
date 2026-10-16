import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, LoaderCircle, Smartphone } from "lucide-react";
import { agentControlUnavailableReason } from "@zeros/protocol/agent-control-rollout";
import { agentControlName } from "@zeros/protocol/browser-tools";
import {
  deviceControlDetail,
  deviceUseTitle,
  type DeviceUseHolder,
} from "@zeros/protocol/device-tools";
import {
  isSimulatorPlatform,
  type SimulatorDevice,
  type SimulatorInput,
  type SimulatorPlatform,
} from "@zeros/protocol/simulators";

import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { WorkbenchTabToolbar, useWorkbenchStatusSource } from "../../shell/workbench/tab-status";
import type { WorkbenchTab } from "../../shell/workbench/tab-model";
import type { WorkbenchNotice } from "../../shell/workbench/tab-status-model";
import { selectActiveFolder, useWorkspaceDispatch, useWorkspaceStore } from "../../state/store";
import { selectWorkbench } from "../../state/workspace-store";
import { cn } from "../../shared/ui/cn";
import { usePrefersReducedMotion } from "../../shared/ui/loading/use-prefers-reduced-motion";
import { Button } from "../../shared/ui/primitives/button";
import { DropdownMenu, DropdownMenuTrigger } from "../../shared/ui/primitives/dropdown-menu";
import { toast } from "../../shared/ui/primitives/elements";
import { PanelHeader } from "../../shared/ui/primitives/panel-header";
import { AgentControlBar } from "../agent-control/agent-control-bar";
import { isAgentControlStopKey } from "../agent-control/agent-control-overlay";
import { useAgentControlFeatureActive } from "../settings/agent-control-rollout";
import {
  bootSimulatorFromTab,
  cancelSimulatorBootFromTab,
  createAndroidDeviceFromPicker,
  shutDownSimulatorFromTab,
} from "./simulator-actions";
import { useSimulatorAgentHolder } from "./simulator-agent-store";
import { leaveSimulatorAnnotation } from "./simulator-annotation-actions";
import { simulatorAnnotations, useSimulatorAnnotation } from "./simulator-annotation-store";
import {
  SimulatorAnnotateToolbar,
  SimulatorAnnotator,
  isFrozenAnnotation,
} from "./simulator-annotator";
import { stopSimulatorAgent } from "./simulator-api";
import { SimulatorDeviceBox } from "./simulator-device-box";
import { SimulatorDeviceMenuContent } from "./simulator-device-menu";
import { useSimulatorDeviceShape } from "./simulator-device-shape";
import {
  deviceBoxSize,
  drawnDeviceLayout,
  fitDeviceScale,
  framedDeviceLayout,
  nextTurnAngle,
  orientationTurns,
  screenSize,
  turnedArea,
  type QuarterTurns,
  type Size,
} from "./simulator-geometry";
import { useDocumentVisible, useElementSize } from "./simulator-hooks";
import {
  loadSimulatorHub,
  simulatorSetup,
  useFollowSimulatorHub,
  useSimulatorHub,
} from "./simulator-hub-store";
import { SimulatorIsland } from "./simulator-island";
import { SimulatorLiveScreen, useSimulatorInput } from "./simulator-live-screen";
import { simulatorErrorMessage } from "./simulator-notices";
import { SimulatorSetupScreen } from "./simulator-setup-screen";
import { simulatorDeviceStatusLabel, simulatorNewDeviceItem } from "./simulator-setup-model";
import {
  parseSimulatorsShownElsewhere,
  simulatorTabFollowsHub,
  simulatorTabView,
  simulatorsShownElsewhere,
} from "./simulator-tab-model";

const EMPTY_DEVICES: readonly SimulatorDevice[] = [];

const LOCAL_ONLY: WorkbenchNotice = {
  tone: "neutral",
  message: "Simulators run on this Mac, so they open only in local workspaces.",
};

// A tab restored after the simulators rollout closed for this copy of Zeros.
const NOT_AVAILABLE: WorkbenchNotice = {
  tone: "neutral",
  message: agentControlUnavailableReason("simulators"),
};

function SimulatorUnavailable({ notice }: { notice: WorkbenchNotice }) {
  useWorkbenchStatusSource(
    { pending: false, primary: true, hasContent: true, notice },
    "simulator-unavailable",
  );
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Smartphone aria-hidden strokeWidth={1} className="text-muted-fg size-10" />
    </div>
  );
}

function ScreenMessage({
  message,
  busy = false,
  active,
  children,
}: {
  message: string;
  busy?: boolean;
  active: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-3 p-4 text-center">
      {busy && (
        <LoaderCircle
          aria-hidden
          className={cn("text-fg3 size-5", active && "motion-safe:animate-spin")}
        />
      )}
      <p aria-live={active ? "polite" : "off"} className="text-fg2 m-0 text-xs">
        {message}
      </p>
      {children}
    </div>
  );
}

/** What the device's screen shows in each state. Only a running device has
 * a live view. */
function DeviceScreen({
  device,
  screen,
  turns,
  active,
  live,
  agentInControl,
  push,
}: {
  device: SimulatorDevice;
  screen: Size;
  turns: QuarterTurns;
  active: boolean;
  live: boolean;
  agentInControl: boolean;
  push: (input: SimulatorInput) => void;
}) {
  switch (device.state) {
    case "booted":
      return (
        <SimulatorLiveScreen
          device={device}
          screen={screen}
          turns={turns}
          live={live}
          agentInControl={agentInControl}
          push={push}
        />
      );
    case "booting":
      return (
        <ScreenMessage busy active={active} message={`Starting ${device.name}…`}>
          <Button size="compact" onClick={() => cancelSimulatorBootFromTab(device)}>
            Cancel
          </Button>
        </ScreenMessage>
      );
    case "shutting-down":
      return <ScreenMessage busy active={active} message={`Shutting down ${device.name}…`} />;
    case "shutdown":
      return (
        <ScreenMessage active={active} message={`${device.name} is shut down.`}>
          <Button
            variant="default"
            size="compact"
            onClick={() => void bootSimulatorFromTab(device)}
          >
            Start
          </Button>
        </ScreenMessage>
      );
  }
}

type NewSimulatorDevice = ReturnType<typeof simulatorNewDeviceItem>;

function SimulatorPicker({
  device,
  devices,
  platform,
  newDevice,
  onAttach,
  onCreate,
  onDetach,
}: {
  device: SimulatorDevice;
  devices: readonly SimulatorDevice[];
  platform: SimulatorPlatform;
  newDevice: NewSimulatorDevice;
  onAttach: (device: SimulatorDevice) => void;
  onCreate: () => void;
  onDetach: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="data-[state=open]:bg-bg2-highlight min-w-0 justify-start"
        >
          <span className="text-fg1 min-w-0 truncate">{device.name}</span>
          <span className="text-muted-fg shrink-0 font-normal">
            {simulatorDeviceStatusLabel(device)}
          </span>
          <ChevronDown aria-hidden className="text-fg3" />
        </Button>
      </DropdownMenuTrigger>
      <SimulatorDeviceMenuContent
        devices={devices}
        platform={platform}
        attached={device}
        newDevice={newDevice}
        onAttach={onAttach}
        onCreate={onCreate}
        onDetach={onDetach}
        onShutDown={(target) => void shutDownSimulatorFromTab(target)}
      />
    </DropdownMenu>
  );
}

const TURN_MS = 200;

/** The device turned `turns` quarter turns, so a device on its side reads
 * upright. Each turn animates from how the last one left the device, size
 * included, or happens at once with reduce motion on. */
function TurnedDevice({
  turns,
  box,
  scale,
  children,
}: {
  turns: QuarterTurns;
  /** The upright device's size on the page. */
  box: Size;
  scale: number;
  children: ReactNode;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const element = useRef<HTMLDivElement>(null);
  const shown = useRef<{ angle: number; scale: number } | null>(null);
  const angle = nextTurnAngle(shown.current?.angle ?? turns * 90, turns);
  useLayoutEffect(() => {
    const previous = shown.current;
    shown.current = { angle, scale };
    const node = element.current;
    if (!node || !previous || previous.angle === angle || reducedMotion || scale <= 0) return;
    const animation = node.animate(
      [
        { transform: `rotate(${previous.angle}deg) scale(${previous.scale / scale})` },
        { transform: `rotate(${angle}deg)` },
      ],
      { duration: TURN_MS, easing: "ease-in-out" },
    );
    return () => animation.cancel();
  }, [angle, scale, reducedMotion]);
  const area = turnedArea(box, turns);
  return (
    <div className="relative shrink-0" style={{ width: area.width, height: area.height }}>
      <div
        ref={element}
        data-simulator-turns={turns}
        className="absolute"
        style={{
          left: Math.round((area.width - box.width) / 2),
          top: Math.round((area.height - box.height) / 2),
          width: box.width,
          height: box.height,
          transform: angle % 360 === 0 ? undefined : `rotate(${angle}deg)`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** The control bar's Stop, and Esc: they end the agent's use of the device,
 * not its turn. */
function useStopSimulatorAgent(holder: DeviceUseHolder | null) {
  const [stopping, setStopping] = useState<string | null>(null);
  const deviceId = holder?.deviceId ?? null;
  const agent = holder ? agentControlName(holder.agent) : null;
  const stop = useCallback(() => {
    if (!deviceId || !agent || stopping === deviceId) return;
    setStopping(deviceId);
    stopSimulatorAgent(deviceId)
      .catch((error: unknown) => {
        toast.error(simulatorErrorMessage(error, `Couldn't stop ${agent}.`), {
          id: `simulator-agent-stop:${deviceId}`,
        });
      })
      .finally(() => setStopping((current) => (current === deviceId ? null : current)));
  }, [agent, deviceId, stopping]);
  return { stopping: stopping !== null && stopping === deviceId, stop };
}

/** An attached device: the picker in the tab's toolbar, the device in its
 * frame, and the island under it, with the control bar beside it while an
 * agent uses the device. Annotate freezes the screen to draw on, with its
 * tools in place of the island. */
function SimulatorStage({
  tabId,
  device,
  devices,
  platform,
  active,
  newDevice,
  onAttach,
  onCreate,
  onDetach,
}: {
  tabId: string;
  device: SimulatorDevice;
  devices: readonly SimulatorDevice[];
  platform: SimulatorPlatform;
  active: boolean;
  newDevice: NewSimulatorDevice;
  onAttach: (device: SimulatorDevice) => void;
  onCreate: () => void;
  onDetach: () => void;
}) {
  const { shape, error, retry } = useSimulatorDeviceShape(device.id);
  const unavailable = useMemo<WorkbenchNotice>(
    () => ({
      tone: "neutral",
      message: `Zeros can't show ${device.name}. Choose another simulator.`,
    }),
    [device.name],
  );
  useWorkbenchStatusSource(
    {
      error,
      pending: shape === undefined && !error,
      hasContent: !!shape,
      retry,
      notice: shape === null ? unavailable : undefined,
    },
    `simulator-shape:${device.id}`,
  );
  const push = useSimulatorInput(device);
  const visible = useDocumentVisible();
  const { ref, size } = useElementSize(active);
  const holder = useSimulatorAgentHolder(device.id);
  const { stopping, stop } = useStopSimulatorAgent(holder);
  const annotation = useSimulatorAnnotation(tabId);
  const frozen = isFrozenAnnotation(annotation) ? annotation : null;
  const controls = useRef<HTMLDivElement>(null);
  const wasFrozen = useRef(false);
  // Focus that left with the annotation goes back to Annotate.
  useEffect(() => {
    const was = wasFrozen.current;
    wasFrozen.current = frozen !== null;
    if (!was || frozen || !active) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    controls.current
      ?.querySelector<HTMLElement>("[data-simulator-annotate-start]")
      ?.focus({ preventScroll: true });
  }, [frozen, active]);
  // A frozen screen keeps the orientation it was captured in.
  const turns = frozen
    ? orientationTurns(frozen.snapshot.orientation)
    : device.state === "booted"
      ? orientationTurns(device.orientation)
      : 0;
  const layout = useMemo(() => {
    if (!shape) return null;
    return shape.frame
      ? framedDeviceLayout(shape.frame, shape.screen)
      : drawnDeviceLayout(shape.screen, device.formFactor);
  }, [shape, device.formFactor]);
  const scale = layout && size ? fitDeviceScale(layout, turnedArea(size, turns)) : 0;
  const agent = holder ? agentControlName(holder.agent) : null;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A menu that closed on this Esc has already used it.
    if (!holder || event.nativeEvent.defaultPrevented) return;
    if (!isAgentControlStopKey(event.nativeEvent)) return;
    event.preventDefault();
    event.stopPropagation();
    stop();
  };
  return (
    <div
      data-simulator-tab={device.state}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onKeyDown}
    >
      <WorkbenchTabToolbar>
        <PanelHeader size="window">
          <SimulatorPicker
            device={device}
            devices={devices}
            platform={platform}
            newDevice={newDevice}
            onAttach={onAttach}
            onCreate={onCreate}
            onDetach={onDetach}
          />
        </PanelHeader>
      </WorkbenchTabToolbar>
      <div
        ref={ref}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
      >
        {shape && layout && scale > 0 && (
          <TurnedDevice turns={turns} box={deviceBoxSize(layout, scale)} scale={scale}>
            <SimulatorDeviceBox
              layout={layout}
              frame={shape.frame}
              scale={scale}
              screenClassName="bg-bg1"
            >
              {/* Stays mounted under a frozen screen, so its last frame
                  shows the moment the screen goes live again. */}
              <div className="size-full" {...(frozen ? { inert: "" } : {})}>
                <DeviceScreen
                  device={device}
                  screen={screenSize(shape.screen)}
                  turns={turns}
                  active={active}
                  live={active && visible && !frozen}
                  agentInControl={holder !== null}
                  push={push}
                />
              </div>
              {frozen && <SimulatorAnnotator annotation={frozen} turns={turns} active={active} />}
            </SimulatorDeviceBox>
          </TurnedDevice>
        )}
      </div>
      <div
        ref={controls}
        className="flex shrink-0 flex-wrap items-center justify-center gap-2 px-3 pb-4"
      >
        {frozen ? (
          <SimulatorAnnotateToolbar annotation={frozen} />
        ) : (
          <SimulatorIsland
            tabId={tabId}
            device={device}
            active={active}
            agentInControl={holder !== null}
            freezing={annotation !== null}
            push={push}
          />
        )}
        {holder && agent && (
          <AgentControlBar
            variant="pill"
            title={agent}
            detail={deviceControlDetail(holder.deviceName)}
            stopLabel={`Stop ${agent}`}
            stopping={stopping}
            onStop={stop}
            escapeHint
            data-testid="simulator-agent-control"
          />
        )}
        <span className="sr-only" aria-live={active ? "polite" : "off"}>
          {holder ? deviceUseTitle(holder) : ""}
        </span>
      </div>
    </div>
  );
}

function LocalSimulatorTab({
  tabId,
  deviceId,
  platform,
  active,
}: {
  tabId: string;
  deviceId: string | undefined;
  platform: SimulatorPlatform;
  active: boolean;
}) {
  const hub = useSimulatorHub();
  const { snapshot } = hub;
  // The hub is local IPC: once it has answered, a failed re-read keeps the
  // devices on screen and only the action that asked for it reports.
  useWorkbenchStatusSource(
    {
      error: snapshot ? null : hub.error,
      pending: !snapshot && (hub.loading || !hub.error),
      primary: true,
      hasContent: snapshot !== null,
      retry: loadSimulatorHub,
    },
    "simulator-hub",
  );
  const dispatch = useWorkspaceDispatch();
  const shownKey = useWorkspaceStore((state) =>
    simulatorsShownElsewhere(selectWorkbench(state).tabs, tabId),
  );
  const shownElsewhere = useMemo(() => parseSimulatorsShownElsewhere(shownKey), [shownKey]);

  // Another device in the tab, or none, would leave the annotation's marks.
  const attach = useCallback(
    (device: SimulatorDevice) => {
      leaveSimulatorAnnotation(tabId, () => {
        dispatch({
          type: "UPDATE_WORKBENCH_TAB",
          id: tabId,
          updates: { simulatorDeviceId: device.id },
        });
        if (device.state === "shutdown") void bootSimulatorFromTab(device);
      });
    },
    [dispatch, tabId],
  );
  const detach = useCallback(() => {
    leaveSimulatorAnnotation(tabId, () => {
      dispatch({
        type: "UPDATE_WORKBENCH_TAB",
        id: tabId,
        updates: { simulatorDeviceId: undefined },
      });
    });
  }, [dispatch, tabId]);
  const newDevice = simulatorNewDeviceItem(simulatorSetup(snapshot, platform), platform);
  // A device made from the picker is the one chosen, as any other would be.
  const create = useCallback(() => {
    void createAndroidDeviceFromPicker().then((device) => {
      if (device) attach(device);
    });
  }, [attach]);

  const view = simulatorTabView(snapshot, deviceId, platform);
  const visible = useDocumentVisible();
  useFollowSimulatorHub(active && visible && simulatorTabFollowsHub(view));
  const shownDeviceId = view.kind === "device" ? view.device.id : null;
  const annotatedDeviceId = useSimulatorAnnotation(tabId)?.deviceId ?? null;
  const settled = view.kind !== "waiting";
  // The annotated device went away.
  useEffect(() => {
    if (settled && annotatedDeviceId !== null && annotatedDeviceId !== shownDeviceId) {
      simulatorAnnotations.end(tabId);
    }
  }, [annotatedDeviceId, settled, shownDeviceId, tabId]);

  switch (view.kind) {
    case "waiting":
      return null;
    case "setup":
      return (
        <SimulatorSetupScreen
          platform={platform}
          snapshot={snapshot}
          shownElsewhere={shownElsewhere}
          active={active}
          newDevice={newDevice}
          onAttach={attach}
          onCreate={create}
        />
      );
    case "device":
      return (
        <SimulatorStage
          key={view.device.id}
          tabId={tabId}
          device={view.device}
          devices={snapshot?.devices ?? EMPTY_DEVICES}
          platform={platform}
          active={active}
          newDevice={newDevice}
          onAttach={attach}
          onCreate={create}
          onDetach={detach}
        />
      );
  }
}

/** A Simulator tab. Devices run on this Mac, so only local workspaces show
 * them. */
export function SimulatorTab({
  tab,
  active,
  scope,
}: {
  tab: WorkbenchTab;
  active: boolean;
  scope?: string;
}) {
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const simulatorsActive = useAgentControlFeatureActive("simulators");
  const platform: SimulatorPlatform = isSimulatorPlatform(tab.simulatorPlatform)
    ? tab.simulatorPlatform
    : "ios";
  if (!simulatorsActive) return <SimulatorUnavailable notice={NOT_AVAILABLE} />;
  return isCloudWorkspace(scope ?? activeFolder) ? (
    <SimulatorUnavailable notice={LOCAL_ONLY} />
  ) : (
    <LocalSimulatorTab
      tabId={tab.id}
      deviceId={tab.simulatorDeviceId}
      platform={platform}
      active={active}
    />
  );
}
