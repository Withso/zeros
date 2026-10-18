import { lazy, Suspense, useEffect, useRef, type ComponentProps } from "react";
import { Smartphone } from "lucide-react";
import { agentControlUnavailableReason } from "@zeros/protocol/agent-control-rollout";
import { isSimulatorPlatform, type SimulatorPlatform } from "@zeros/protocol/simulators";

import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { useWorkbenchStatusSource } from "../../shell/workbench/tab-status";
import type { WorkbenchTab } from "../../shell/workbench/tab-model";
import type { WorkbenchNotice } from "../../shell/workbench/tab-status-model";
import { selectActiveFolder, useWorkspaceStore } from "../../state/store";
import { isAgentControlFeatureActive, useAgentControlFeatureActive } from "../settings/agent-control-rollout";
import { warmSimulatorHub } from "./simulator-hub-store";

type LocalModule = typeof import("./local-simulator-tab");
let loaded: LocalModule | undefined;
let loading: Promise<LocalModule> | undefined;
function loadLocalSimulator(): Promise<LocalModule> {
  return loading ??= import("./local-simulator-tab").then(module => {
    loaded = module;
    return module;
  }, error => {
    loading = undefined;
    throw error;
  });
}
const LazyLocalSimulator = lazy(() => loadLocalSimulator().then(module => ({ default: module.LocalSimulatorTab })));

/** Module and native snapshot start together on pointer/keyboard intent. A
 * warmed component is available synchronously to the urgent selection render. */
export function warmSimulatorTab(scope: string | null | undefined): Promise<void> {
  if (!scope || isCloudWorkspace(scope) || !isAgentControlFeatureActive("simulators")) return Promise.resolve();
  warmSimulatorHub();
  return loadLocalSimulator().then(() => {});
}

function LocalSimulatorBody(props: ComponentProps<LocalModule["LocalSimulatorTab"]>) {
  // Keep this component type for the mount's lifetime. A cold lazy resolution
  // must not remount the device when a later parent render sees the warm cache.
  const Body = useRef(loaded?.LocalSimulatorTab ?? LazyLocalSimulator).current;
  return <Body {...props} />;
}

const LOCAL_ONLY: WorkbenchNotice = {
  tone: "neutral",
  message: "Simulators run on this Mac, so they open only in local workspaces.",
};
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

/** Devices run on this Mac. Cloud and closed-rollout surfaces retain their
 * synchronous unavailable presentation without loading the Local runtime. */
export function SimulatorTab({ tab, active, scope }: { tab: WorkbenchTab; active: boolean; scope?: string }) {
  const activeFolder = useWorkspaceStore(selectActiveFolder);
  const simulatorsActive = useAgentControlFeatureActive("simulators");
  const platform: SimulatorPlatform = isSimulatorPlatform(tab.simulatorPlatform) ? tab.simulatorPlatform : "ios";
  const local = !isCloudWorkspace(scope ?? activeFolder);
  // Outside Suspense: native data must start even while the Local chunk is
  // still loading. Intent normally has both ready before this selection.
  useEffect(() => { if (active && simulatorsActive && local) warmSimulatorHub(); }, [active, simulatorsActive, local]);
  if (!simulatorsActive) return <SimulatorUnavailable notice={NOT_AVAILABLE} />;
  if (!local) return <SimulatorUnavailable notice={LOCAL_ONLY} />;
  if (!active && !loaded) return null;
  return (
    <Suspense fallback={null}>
      <LocalSimulatorBody tabId={tab.id} deviceId={tab.simulatorDeviceId} platform={platform} active={active} />
    </Suspense>
  );
}
