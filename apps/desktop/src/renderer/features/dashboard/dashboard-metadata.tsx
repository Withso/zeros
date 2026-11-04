import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Cloud } from "lucide-react";
import type { Workspace } from "../../platform/git";
import type { Project } from "../../state/projects-store";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import {
  isCloudWorkspace,
  parseCloudWorkspaceKey,
} from "../../platform/bridge/cloud-workspace-key";
import {
  confirmedChangeLinesForBase,
  subscribeConfirmedChangeLines,
} from "../../shell/workspace-change-line-cache";
import {
  cloudWorkspaceDocument,
  subscribeCloudWorkspaces,
} from "../../state/cloud-workspace-catalog";
import {
  changesSnapshotKey,
  readChangesSections,
  subscribeChangesSections,
} from "../../shell/workbench/tabs/changes-snapshot-cache";
import {
  projectInitial,
  RepositoryIcon,
} from "../repositories/repository-icon";
import { cn } from "../../shared/ui/cn";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { dashboardLineChanges } from "./dashboard-model";

export function DashboardRepositoryIcon({
  project,
  name,
  pill = false,
  round = false,
}: {
  project: Project | null;
  name: string;
  /** Inside a 28px filter pill the chip rounds to 6px and sets the pill's
   *  4px leading inset. */
  pill?: boolean;
  /** Inside a list row's 24px repository tag: an 18px circle. */
  round?: boolean;
}) {
  return (
    <span
      className={cn(
        "bg-bg2-hover text-fg2 text-xxs inline-flex shrink-0 items-center justify-center overflow-hidden leading-none font-medium",
        round ? "size-4.5 rounded-full" : "size-5",
        !round && (pill ? "rounded-md" : "rounded-sm"),
      )}
      data-repository-pill={pill || undefined}
      aria-hidden="true"
    >
      {project ? (
        <RepositoryIcon project={project} className="size-full" />
      ) : (
        projectInitial(name)
      )}
    </span>
  );
}

const inert = () => () => {};
const countFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Observe the existing exact All Changes snapshot. Home never launches Git
 * processes or cloud connections just to fill optional metadata. */
export function DashboardLineChanges({
  workspace,
  active,
}: {
  workspace: Workspace;
  active: boolean;
}) {
  const target = isLocalMainWorkspace(workspace)
    ? workspace.path
    : workspace.id;
  const key = changesSnapshotKey(target, { kind: "all" }, workspace.baseBranch);
  const subscribe = useCallback(
    (listener: () => void) => subscribeChangesSections(key, listener),
    [key],
  );
  const snapshot = useCallback(() => readChangesSections(key), [key]);
  const sections = useSyncExternalStore(
    active ? subscribe : inert,
    snapshot,
    snapshot,
  );
  const subscribeCounts = useCallback(
    (listener: () => void) => subscribeConfirmedChangeLines(target, listener),
    [target],
  );
  const readCounts = useCallback(
    () => confirmedChangeLinesForBase(target, workspace.baseBranch),
    [target, workspace.baseBranch],
  );
  const counts = useSyncExternalStore(
    active ? subscribeCounts : inert,
    readCounts,
    readCounts,
  );
  const totals = useMemo(
    () => counts ?? dashboardLineChanges(sections),
    [counts, sections],
  );
  if (!totals)
    return (
      <span className="text-muted-fg" aria-label="Line changes unavailable">
        —
      </span>
    );
  return (
    <Tooltip
      label={`${totals.additions.toLocaleString()} additions, ${totals.deletions.toLocaleString()} deletions · Last known branch changes`}
    >
      <span
        className="text-3xxs inline-flex items-center gap-1 tabular-nums"
        aria-label={`${totals.additions} additions, ${totals.deletions} deletions`}
      >
        {/* Only the side that changed, in sans with one 4px gap — the same
            pair the sidebar and the hover card show. */}
        {(totals.additions > 0 || totals.deletions === 0) && (
          <span className="text-green-primary">
            +{countFormat.format(totals.additions)}
          </span>
        )}
        {totals.deletions > 0 && (
          <span className="text-red-primary">
            −{countFormat.format(totals.deletions)}
          </span>
        )}
      </span>
    </Tooltip>
  );
}

export function DashboardCost() {
  // Per-turn usage and file-changing turn lists cannot establish a workspace
  // total. Missing billing data must never be presented as zero or a partial sum.
  return (
    <Tooltip label="Workspace cost unavailable">
      <span className="text-muted-fg" aria-label="Cost unavailable">
        —
      </span>
    </Tooltip>
  );
}

export function DashboardPlacement({
  workspace,
  active,
}: {
  workspace: Workspace;
  active: boolean;
}) {
  const cloud = isCloudWorkspace(workspace.path);
  const snapshot = useCallback(() => {
    const target = parseCloudWorkspaceKey(workspace.path);
    return target ? cloudWorkspaceDocument(target) : undefined;
  }, [workspace.path]);
  const document = useSyncExternalStore(
    active && cloud ? subscribeCloudWorkspaces : inert,
    snapshot,
    snapshot,
  );
  if (!cloud) return null;
  const label = `Cloud${document ? ` · ${document.status.replaceAll("_", " ")}` : " workspace"}`;
  return (
    <Tooltip label={label}>
      <Cloud
        className="text-fg3 size-3.5 shrink-0"
        role="img"
        aria-label={label}
      />
    </Tooltip>
  );
}
