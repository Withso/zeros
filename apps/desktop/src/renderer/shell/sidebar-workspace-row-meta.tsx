// The redesigned sidebar row's second line (and Compact's trailing marks):
// where the workspace runs, then the agent's status word or, with none, when it
// was last updated, then its pull requests. The status word never truncates at
// rest; PR marks step from one mark per state, to one combined group, to one
// blue icon as the row narrows, and Archive never covers this line, so hover
// moves nothing.
import { Button } from "../shared/ui/primitives/button";
import { useLayoutEffect, useRef, useState } from "react";
import { Cloud, CloudOff, GitPullRequest, Laptop } from "lucide-react";
import type { Workspace } from "../platform/git";
import { formatCompactAge } from "../features/agent/format-age";
import { cn } from "../shared/ui/cn";
import { ZerosSpinner } from "../shared/ui/loading/zeros-spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../shared/ui/primitives/dropdown-menu";
import { cloudMarkState } from "./sidebar-cloud-mark";
import {
  prMarkGroups,
  prMarkLayout,
  prMarkWidth,
  type PrMarkGroup,
  type PrMarkTone,
  type SidebarPullRequest,
} from "./sidebar-view-model";

const PR_TONE_CLS: Record<PrMarkTone, string> = {
  draft: "text-fg3",
  open: "text-green-text",
  conflicts: "text-yellow-text",
  merged: "text-violet-text",
  closed: "text-red-text",
};
const PR_TONE_LABEL: Record<PrMarkTone, string> = {
  draft: "Draft",
  open: "Open",
  conflicts: "Needs attention",
  merged: "Merged",
  closed: "Closed",
};

export type SidebarRowStatusTone = "attention" | "done" | "failed" | "muted";
export interface SidebarRowStatus { label: string; tone: SidebarRowStatusTone }

// Status text sits on the sidebar surface, so it is each family's -text role
// (the -on-bg roles are for text on a tinted -bg container). Done is violet,
// the lifecycle's Done everywhere (StatusIcon, the workspace menu).
const STATUS_TONE_CLS: Record<SidebarRowStatusTone, string> = {
  attention: "text-yellow-text",
  done: "text-violet-text",
  failed: "text-red-text",
  muted: "text-fg3",
};
/** Compact rows' dots take the same colours as the words they stand for. */
export const STATUS_DOT_CLS: Record<Exclude<SidebarRowStatusTone, "muted">, string> = {
  attention: "bg-yellow-text",
  done: "bg-violet-text",
  failed: "bg-red-text",
};

export type SidebarRowLead = "archiving" | "working" | "child" | "folder" | "design" | "logo";

/** What the row's 16px leading slot shows: the project logo at rest, the logo
 * loader while archiving, the agent loader while working, and a dot for a
 * child in its parent's project. Folders and legacy Design workspaces keep
 * their own mark. */
export function sidebarRowLead(args: {
  archiving: boolean;
  working: boolean;
  sameProjectChild: boolean;
  folder: boolean;
  design: boolean;
}): SidebarRowLead {
  if (args.archiving) return "archiving";
  if (args.working) return "working";
  if (args.sameProjectChild) return "child";
  if (args.folder) return "folder";
  if (args.design) return "design";
  return "logo";
}

const CLOUD_ERROR = new Set(["error", "failed", "setup_failed", "unhealthy"]);

/** The status word a row shows; null leaves line 2 to the time alone. */
export function sidebarRowStatus(args: {
  archiving: boolean;
  setupFailed: boolean;
  cloudStatus: string | null;
  awaiting: "plan" | "input" | null;
  working: boolean;
  unread: boolean;
}): SidebarRowStatus | null {
  if (args.archiving) return { label: "Archiving…", tone: "muted" };
  if (args.setupFailed) return { label: "Failed", tone: "failed" };
  if (args.cloudStatus && CLOUD_ERROR.has(args.cloudStatus)) return { label: "Cloud error", tone: "failed" };
  if (args.awaiting === "input") return { label: "Needs input", tone: "attention" };
  if (args.awaiting === "plan") return { label: "Plan ready", tone: "attention" };
  if (args.working) return { label: "Working", tone: "muted" };
  const cloud = args.cloudStatus ? cloudMarkState(args.cloudStatus) : null;
  if (cloud === "starting") return { label: "Waking…", tone: "muted" };
  if (args.unread) return { label: "Done", tone: "done" };
  if (cloud === "stopped") return { label: "Asleep", tone: "muted" };
  return null;
}

function openPull(pull: SidebarPullRequest) {
  if (pull.url) window.open(pull.url, "_blank", "noopener,noreferrer");
}

/** One PR mark (or group) as a menu of its pull requests; a lone PR with a URL
 * opens directly. The row underneath never sees the click. */
function PrMark({ pulls, label, className, children }: { pulls: readonly SidebarPullRequest[]; label: string; className?: string; children: React.ReactNode }) {
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const cls = cn(
    "pointer-events-auto h-4 shrink-0 gap-0.5 rounded-sm px-0.5 py-0 text-3xxs font-normal tabular-nums",
    className,
  );
  if (pulls.length === 1 && pulls[0]!.url) {
    return (
      <Button type="button" variant="ghost" size="compact" className={cls} aria-label={label} data-pr-mark
        onClick={(event) => { stop(event); openPull(pulls[0]!); }} onKeyDown={stop} onPointerDown={stop}>
        {children}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="compact" className={cls} aria-label={label} data-pr-mark onClick={stop} onKeyDown={stop} onPointerDown={stop}>
          {children}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56" onClick={stop}>
        <DropdownMenuLabel className="text-fg3 text-3xxs font-medium">Pull requests</DropdownMenuLabel>
        {pulls.map((pull) => (
          <DropdownMenuItem key={`${pull.repository ?? ""}#${pull.number}`} disabled={!pull.url} onSelect={() => openPull(pull)}>
            <GitPullRequest strokeWidth={1.5} className={cn("size-3.5", PR_TONE_CLS[pull.tone])} />
            <span className="min-w-0 flex-1 truncate">{pull.repository ? `${pull.repository} #${pull.number}` : `#${pull.number}`}</span>
            <span className="text-fg3 text-3xxs">{PR_TONE_LABEL[pull.tone]}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SidebarPrMarks({ groups, layout }: { groups: readonly PrMarkGroup[]; layout: ReturnType<typeof prMarkLayout> }) {
  const all = groups.flatMap((group) => group.pulls);
  if (all.length === 0) return null;
  const total = all.length;
  if (layout === "single") {
    return (
      <PrMark pulls={all} label={`${total} pull requests`} className="text-accent-text">
        <GitPullRequest strokeWidth={1.5} className="size-3" />
        <span>{total}</span>
      </PrMark>
    );
  }
  if (layout === "combined") {
    return (
      <PrMark pulls={all} label={`${total} pull requests`} className="gap-1">
        <span className="inline-flex items-center gap-1">
          {groups.map((group) => (
            <GitPullRequest key={group.tone} strokeWidth={1.5} className={cn("size-3", PR_TONE_CLS[group.tone])} />
          ))}
        </span>
        <span className="text-fg2">{total}</span>
      </PrMark>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {groups.map((group) => (
        <PrMark key={group.tone} pulls={group.pulls} className={PR_TONE_CLS[group.tone]}
          label={`${group.pulls.length} ${PR_TONE_LABEL[group.tone].toLowerCase()} pull request${group.pulls.length === 1 ? "" : "s"}`}>
          <GitPullRequest strokeWidth={1.5} className="size-3" />
          <span>{group.pulls.length}</span>
        </PrMark>
      ))}
    </span>
  );
}

/** Measures a line's width so PR marks pick the step that fits. */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    // A hidden row reports 0; keep the last width so it does not re-render.
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function SidebarPlacementIcon({ cloud, cloudStatus }: { cloud: boolean; cloudStatus: string | null }) {
  if (!cloud) return <Laptop strokeWidth={1.5} className="size-3 shrink-0" aria-label="This Mac" role="img" />;
  const state = cloudMarkState(cloudStatus);
  if (state === "starting") return <ZerosSpinner size={12} label="Cloud workspace, starting" />;
  if (cloudStatus && CLOUD_ERROR.has(cloudStatus)) {
    return <CloudOff strokeWidth={1.5} className="text-red-text size-3 shrink-0" aria-label="Cloud workspace, error" role="img" data-cloud-mark="error" />;
  }
  return state === "stopped"
    ? <CloudOff strokeWidth={1.5} className="size-3 shrink-0" aria-label="Cloud workspace, stopped" role="img" data-cloud-mark={state} />
    : <Cloud strokeWidth={1.5} className="size-3 shrink-0" aria-label="Cloud workspace" role="img" data-cloud-mark={state} />;
}

const STATUS_CHAR_PX = 6.5;

/** Line 2: placement, the status word or (with none) the time, then PR marks. */
export function SidebarWorkspaceRowMeta({
  workspace,
  pulls,
  status,
  cloud,
  cloudStatus,
  updatedAt,
}: {
  workspace: Pick<Workspace, "id">;
  pulls: readonly SidebarPullRequest[];
  status: SidebarRowStatus | null;
  cloud: boolean;
  cloudStatus: string | null;
  updatedAt: number;
}) {
  const [ref, width] = useWidth<HTMLSpanElement>();
  const groups = prMarkGroups(pulls);
  const time = formatCompactAge(updatedAt);
  const statusPx = status ? status.label.length * STATUS_CHAR_PX + 8 : time.length * STATUS_CHAR_PX + 8;
  const available = Math.max(0, width - 20 - statusPx);
  const layout = width === 0 ? "separate" : prMarkLayout(groups, available);
  const fits = width === 0 || prMarkWidth(groups, layout) <= available || layout === "single";
  return (
    <span ref={ref} className="text-fg3 flex h-4 min-w-0 items-center gap-1.5 text-3xxs leading-4" data-sidebar-row-meta={workspace.id}>
      <span className="inline-flex size-3 shrink-0 items-center justify-center">
        <SidebarPlacementIcon cloud={cloud} cloudStatus={cloudStatus} />
      </span>
      {status
        ? <span className={cn("shrink-0 whitespace-nowrap", STATUS_TONE_CLS[status.tone])} data-sidebar-status-word>{status.label}</span>
        : <span className="shrink-0 tabular-nums" data-sidebar-row-time>{time}</span>}
      {groups.length > 0 && fits && (
        <>
          <span aria-hidden="true">·</span>
          <SidebarPrMarks groups={groups} layout={layout} />
        </>
      )}
    </span>
  );
}
