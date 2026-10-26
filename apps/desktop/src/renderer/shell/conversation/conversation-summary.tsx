import React, {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { Folder } from "lucide-react";
import { useActiveWorkspace } from "../../state/use-active-workspace";
import { useWorkspaceStore } from "../../state/workspace-store";
import { usePaneLayout } from "../../state/chat-panes-store";
import { workspaceLabel } from "../workspace-tabs";
import { cn } from "../../shared/ui/cn";
import { MENU_SURFACE_RADIUS } from "../../shared/ui/menu-surface";
import { resolvePopoverBoundary } from "../../shared/ui/popover-boundary";
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "../../shared/ui/primitives";
import { prefetchSettingsForRepo } from "../../features/settings/use-settings";
import { SummaryContents } from "./summary-contents";
import { summaryHasSplitColumns } from "./summary-model";
import { supportsSummaryGitStatus } from "./summary-git-status-model";
import { loadSummaryGit, loadSummaryPr } from "./summary-git-status-data";
import { getGitRefreshKey } from "../use-git-refresh-key";
import { isNativeRuntime } from "../../platform/runtime";
import "./conversation-summary.css";

type SummaryState = {
  folder: string;
  name: string;
  docked: boolean;
  open: boolean;
  islandId: string;
  boundary: Element | null;
  setAnchor: (node: HTMLSpanElement | null) => void;
  setOpen: (open: boolean) => void;
  navigate: () => void;
  warm: () => void;
};
const SummaryContext = createContext<SummaryState | null>(null);

/** Only the small summary consumers subscribe to presentation changes. The
 * pane tree and its portaled transcript keep their identity on every toggle. */
export function ConversationSummaryProvider({
  enabled = true,
  workbenchCollapsed,
  onRevealWorkbench,
  children,
}: {
  enabled?: boolean;
  workbenchCollapsed: boolean;
  onRevealWorkbench: () => void;
  children: React.ReactNode;
}) {
  const { workspace, folder, project } = useActiveWorkspace();
  const layout = usePaneLayout(folder);
  const active =
    useWorkspaceStore((state) => state.activePage === "workspace") && enabled;
  const cwd = active ? (folder ?? "") : "";
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  const [hiddenOwner, setHiddenOwner] = useState<string | null>(null);
  const islandId = useId();
  const boundary =
    anchor?.closest("[data-pane-root]") ?? resolvePopoverBoundary(anchor);
  // Each split gets its own available width. Never squeeze the owning chat
  // below its readable width just because the whole column happens to fit.
  useLayoutEffect(() => {
    const pane = anchor?.closest("[data-pane-root]") ?? boundary;
    if (!active || !pane) return;
    const measure = () => setPaneWidth(pane.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [active, anchor, boundary]);
  const docked =
    workbenchCollapsed &&
    !summaryHasSplitColumns(layout.root) &&
    paneWidth >= 760;
  // A popover is ephemeral: switching owner or presentation must close it,
  // including A → B → A. The render gate suppresses the old owner's first paint.
  useLayoutEffect(() => setOpenOwner(null), [cwd, docked, workbenchCollapsed]);

  const state = useMemo<SummaryState>(
    () => ({
      folder: cwd,
      name: workspace
        ? workspaceLabel(workspace)
        : cwd.split(/[\\/]/).pop() || "Workspace",
      docked,
      open: !!cwd && (docked ? hiddenOwner !== cwd : openOwner === cwd),
      islandId,
      boundary,
      setAnchor,
      setOpen: (open) => {
        if (docked) setHiddenOwner(open ? null : cwd);
        else setOpenOwner(open ? cwd : null);
      },
      navigate: () => {
        setOpenOwner(null);
        onRevealWorkbench();
      },
      warm: () => {
        if (!cwd) return;
        prefetchSettingsForRepo(workspace?.path || cwd);
        if (isNativeRuntime() && project?.isGitRepository !== false && supportsSummaryGitStatus(workspace)) {
          void loadSummaryGit(workspace, getGitRefreshKey(workspace.path, workspace.id)).catch(() => {});
          void loadSummaryPr(workspace).catch(() => {});
        }
      },
    }),
    [
      cwd,
      workspace,
      project?.isGitRepository,
      docked,
      openOwner,
      hiddenOwner,
      islandId,
      boundary,
      onRevealWorkbench,
    ],
  );

  return (
    <SummaryContext.Provider value={state}>{children}</SummaryContext.Provider>
  );
}

/** The supplied Summary silhouette, drawn with true one-pixel strokes. */
function SummaryIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1.5"
        y="1.5"
        width="13"
        height="13"
        rx="3.5"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="m4.5 10 2.25-3.125 2.2 2.2L11.5 6"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ConversationSummaryTrigger() {
  const state = useContext(SummaryContext);
  if (!state) return null;
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-fg2 shrink-0 [&_svg]:size-4"
      aria-label="Summary"
      aria-expanded={state.open}
      aria-controls={state.docked ? state.islandId : undefined}
      onClick={state.docked ? () => state.setOpen(!state.open) : undefined}
      onPointerEnter={!state.open ? state.warm : undefined}
      onFocus={!state.open ? state.warm : undefined}
    >
      <SummaryIcon />
    </Button>
  );
  return (
    <span ref={state.setAnchor} className="contents">
      {state.folder && state.docked && (
        <Tooltip label={state.open ? "Hide summary" : "Show summary"}>
          {button}
        </Tooltip>
      )}
      {state.folder && !state.docked && (
        <Popover
          key={state.folder}
          open={state.open}
          onOpenChange={state.setOpen}
        >
          <Tooltip label="Summary" delayDuration={1500} disabled={state.open}>
            <PopoverTrigger asChild>
              {button}
            </PopoverTrigger>
          </Tooltip>
          <PopoverContent
            aria-label="Workspace summary"
            align="end"
            side="bottom"
            sideOffset={12}
            collisionBoundary={state.boundary}
            collisionPadding={{ top: 8, right: 16, bottom: 8, left: 8 }}
            padding="none"
            className="conversation-summary-popover bg-bg1-bright w-72 border-0 p-3 motion-reduce:animate-none"
            {...(!state.open ? { inert: "", "aria-hidden": true } : {})}
          >
            <SummaryCard state={state} />
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}

export function ConversationSummaryIsland() {
  const state = useContext(SummaryContext);
  if (!state?.folder || !state.docked || !state.open) return null;
  return (
    <aside
      id={state.islandId}
      aria-label="Workspace summary"
      data-summary-island=""
      className={cn(
        "conversation-summary-island bg-bg1-bright my-3 mr-4 max-h-[calc(100%-24px)] w-72 shrink-0 self-start overflow-y-auto overscroll-contain p-3",
        MENU_SURFACE_RADIUS,
      )}
    >
      <SummaryCard state={state} />
    </aside>
  );
}

function SummaryCard({ state }: { state: SummaryState }) {
  return (
    <>
      <div className="flex h-7 min-w-0 items-center gap-2 px-1.5">
        <Folder className="text-fg2 size-4 shrink-0" aria-hidden="true" />
        <Tooltip label={state.name} side="left">
          <span className="text-fg1 min-w-0 flex-1 truncate text-xs font-medium">
            {state.name}
          </span>
        </Tooltip>
      </div>
      <SummaryContents
        key={state.folder}
        folder={state.folder}
        active={state.open}
        onNavigate={state.navigate}
      />
    </>
  );
}
