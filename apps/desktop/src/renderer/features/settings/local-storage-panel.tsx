import { useEffect, useState } from "react";
import {
  AppWindow,
  Check,
  CloudUpload,
  Database,
  Download,
  FileText,
  Folder,
  Info,
  KeyRound,
  LayoutGrid,
  RefreshCw,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { LocalStorageCategory, LocalStorageCategoryId } from "../../../../shared/local-storage";
import { useNativeRuntime } from "../../platform/runtime";
import { cn } from "../../shared/ui/cn";
import { Button } from "../../shared/ui/primitives/button";
import { toast } from "../../shared/ui/primitives/elements";
import { SkeletonLine } from "../../shared/ui/primitives/skeleton";
import { Tooltip } from "../../shared/ui/primitives/tooltip";
import { formatBytes, sizeDisplay, summarize, totalDisplay, updatedLabel, type SummaryGroup } from "./local-storage-format";
import {
  clearLocalStorageCache,
  ensureLocalStorageMeasured,
  retainLocalStorageView,
  revealLocalStorage,
  useLocalStorageView,
  type LocalStorageView,
} from "./local-storage-store";
import { SettingsGroup, SettingsRow } from "./settings-ui";

const HINT_CLS = "text-fg3 m-0 px-0.5 text-3xxs leading-4";
const AT_LEAST_CLS = "text-fg3 block text-3xxs leading-3.5";

// Neutral steps from the token ramp; the legend and rows carry the meaning.
const SEGMENT_CLS: Record<SummaryGroup, string> = {
  work: "bg-fg1",
  providers: "bg-fg2",
  app: "bg-fg3",
  updates: "bg-border4",
  temporary: "bg-border3",
};

interface RowSpec {
  id: LocalStorageCategoryId;
  label: string;
  icon: LucideIcon;
  description?: string;
  /** Rows under Your work show where they are instead of a description. */
  showsLocation?: boolean;
  action: "reveal" | "clear" | "managed";
}

const YOUR_WORK: RowSpec[] = [
  { id: "workspaces", label: "Workspaces", icon: Folder, showsLocation: true, action: "reveal" },
  { id: "cloud-sync", label: "Cloud sync", icon: CloudUpload, showsLocation: true, action: "reveal" },
];
const APP_DATA: RowSpec[] = [
  { id: "chats", label: "Chats and history", icon: Database, description: "Conversations, workspace records and checkpoints.", action: "reveal" },
  { id: "provider-accounts", label: "Provider accounts", icon: KeyRound, description: "Claude, Codex and Cursor sign-ins, with their own session files.", action: "reveal" },
  { id: "window-state", label: "Window and editor state", icon: AppWindow, description: "Drafts, theme, layout and Design previews.", action: "reveal" },
  { id: "other-app-data", label: "Other app data", icon: LayoutGrid, description: "Design storage, attachments and settings.", action: "reveal" },
];
const TEMPORARY: RowSpec[] = [
  { id: "cache", label: "Cache", icon: Zap, description: "Rebuilt automatically. The next launch may be slower.", action: "clear" },
  { id: "logs", label: "Logs", icon: FileText, description: "Kept small automatically. Included when you send feedback.", action: "reveal" },
  { id: "updates", label: "Updates", icon: Download, description: "Downloaded updates. Removed after they install.", action: "managed" },
];

export function LocalStoragePanel({ surfaceActive = false }: { surfaceActive?: boolean }) {
  const active = useNativeRuntime().ready && surfaceActive;
  const view = useLocalStorageView();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => (active ? retainLocalStorageView() : undefined), [active]);
  // Only the visible page keeps its "Updated …" label current.
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [active, view.report?.measuredAt]);

  const byId = new Map(view.report?.categories.map((category) => [category.id, category]));
  const rows = (specs: RowSpec[]) =>
    specs.map((spec) => <StorageRow key={spec.id} spec={spec} category={byId.get(spec.id)} view={view} active={active} />);

  return (
    <div className="flex flex-col gap-8" aria-busy={view.report?.measuring || undefined}>
      <Summary view={view} now={now} active={active} />
      <div className="flex flex-col gap-2">
        <SettingsGroup title="Your work">{rows(YOUR_WORK)}</SettingsGroup>
        <p className={HINT_CLS}>Local copies of your repositories. Remove a workspace by archiving it, not from here.</p>
      </div>
      <SettingsGroup title="App data">{rows(APP_DATA)}</SettingsGroup>
      <SettingsGroup title="Temporary">{rows(TEMPORARY)}</SettingsGroup>
      <p className="text-fg3 m-0 flex items-start gap-2 text-3xxs leading-4">
        <Info className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>Files in cloud workspaces live on their Cloud Computer and are not counted here.</span>
      </p>
    </div>
  );
}

function Summary({ view, now, active }: { view: LocalStorageView; now: number; active: boolean }) {
  const summary = summarize(view.report);
  const total = totalDisplay(view.report, view.error !== null);
  const measuring = view.report?.measuring ?? false;
  const busy = measuring || view.clearing || !active;
  const status = view.error && !measuring ? "Could not measure" : updatedLabel(view.report, now);
  return (
    <SettingsGroup>
      <div role="group" aria-label="Total storage" className="text-fg2 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <p className="m-0 flex min-w-0 items-baseline gap-1.5">
          {total.kind === "known" ? (
            <>
              {!total.exact && <span className="text-fg3 text-3xxs">At least</span>}
              <span className="text-fg1 text-lg leading-6 font-medium tabular-nums">{formatBytes(total.bytes)}</span>
            </>
          ) : total.kind === "pending" ? (
            <span className="flex h-6 items-center" role="img" aria-label="Measuring total">
              <SkeletonLine surface="card" className="w-16" />
            </span>
          ) : (
            <span className="text-fg3 text-xs leading-6">Not measured</span>
          )}
          <span className="text-fg3 text-xs">on this Mac</span>
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <span role="status" className="text-fg3 text-3xxs whitespace-nowrap">
            {status}
          </span>
          <Button
            variant="ghost"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) ensureLocalStorageMeasured({ force: true });
            }}
          >
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        </div>
      </div>
      <div
        role="img"
        aria-label="Share of storage by category"
        className="bg-bg2 flex h-2 gap-0.5 overflow-hidden rounded-sm"
      >
        {summary.total > 0 &&
          summary.groups.map((group) =>
            group.bytes > 0 ? (
              <span
                key={group.id}
                data-group={group.id}
                className={cn(SEGMENT_CLS[group.id], "block h-full min-w-0.75 transition-[flex-grow] duration-slow ease-out motion-reduce:transition-none")}
                style={{ flexGrow: group.bytes, flexBasis: 0 }}
              />
            ) : null,
          )}
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0">
        {summary.groups.map((group) => (
          <li key={group.id} className="text-fg3 inline-flex items-center gap-1.5 text-3xxs leading-4">
            <span aria-hidden className={cn(SEGMENT_CLS[group.id], "size-2 rounded-[calc(var(--radius-sm)*0.5)]")} />
            {group.label}
          </li>
        ))}
      </ul>
      </div>
    </SettingsGroup>
  );
}

function StorageRow({
  spec,
  category,
  view,
  active,
}: {
  spec: RowSpec;
  category: LocalStorageCategory | undefined;
  view: LocalStorageView;
  active: boolean;
}) {
  const Icon = spec.icon;
  const hint = spec.showsLocation ? (
    <span className="text-fg3 block truncate font-mono text-3xxs">{category?.location ?? " "}</span>
  ) : (
    spec.description
  );
  return (
    <SettingsRow leading={<Icon className="text-fg3 size-3.5 shrink-0" aria-hidden />} label={spec.label} hint={hint}>
      <div className="flex items-center gap-3">
        <Size category={category} failed={view.error !== null} />
        <div className="flex min-w-29 justify-end">
          <RowAction spec={spec} category={category} view={view} active={active} />
        </div>
      </div>
    </SettingsRow>
  );
}

function Size({ category, failed }: { category: LocalStorageCategory | undefined; failed: boolean }) {
  const size = sizeDisplay(category, failed);
  return (
    <div className="text-fg2 min-w-19 text-right text-xs leading-4.5 tabular-nums">
      {size.kind === "exact" ? (
        formatBytes(size.bytes)
      ) : size.kind === "at-least" ? (
        <>
          <span className={AT_LEAST_CLS}>at least</span>
          {formatBytes(size.bytes)}
        </>
      ) : size.kind === "pending" ? (
        <span className="flex h-4.5 items-center justify-end" role="img" aria-label="Measuring">
          <SkeletonLine surface="card" className="w-13" />
        </span>
      ) : (
        <span className="text-fg3 text-3xxs">Not measured</span>
      )}
    </div>
  );
}

function RowAction({
  spec,
  category,
  view,
  active,
}: {
  spec: RowSpec;
  category: LocalStorageCategory | undefined;
  view: LocalStorageView;
  active: boolean;
}) {
  if (spec.action === "managed")
    return <span className="text-fg3 flex h-7 items-center text-3xxs">Managed by Zeros</span>;
  if (spec.action === "clear") {
    if (view.freedBytes !== undefined && !view.clearing)
      return (
        <span role="status" className="text-green-text flex h-7 items-center gap-1.5 text-3xxs">
          <Check className="size-3.5" aria-hidden />
          {view.freedBytes === null ? "Cache cleared" : `Freed ${formatBytes(view.freedBytes)}`}
        </span>
      );
    return (
      <Button
        loading={view.clearing}
        disabled={!active}
        onClick={() => {
          clearLocalStorageCache().catch(() => toast.error("Could not clear the cache."));
        }}
      >
        Clear cache
      </Button>
    );
  }
  const available = active && (category?.revealable ?? false);
  return (
    <Tooltip label={available || !category ? "" : "Nothing here yet"}>
      <Button
        aria-label={`Reveal ${spec.label.toLowerCase()} in Finder`}
        aria-disabled={!available || undefined}
        onClick={() => {
          if (!available) return;
          revealLocalStorage(spec.id).catch(() => toast.error("Could not open this folder in Finder."));
        }}
      >
        Reveal
      </Button>
    </Tooltip>
  );
}
