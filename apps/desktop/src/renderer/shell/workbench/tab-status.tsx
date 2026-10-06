import React, {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { CircleAlert, Info, LoaderCircle } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import { cn } from "../../shared/ui/cn";
import {
  reconnectWorkbenchWorkspace,
  registerWorkbenchFrameVisibility,
  useWorkbenchAvailability,
} from "../../state/workbench-availability";
import { openWorkbenchTerminal } from "./open-terminal";
import { SETUP_SUBTAB } from "../terminal/use-setup-control";
import {
  describeWorkbenchFailure,
  describeWorkbenchEmptyState,
  WORKBENCH_STATUS_ADAPTERS,
  workbenchSourcesFor,
  workbenchStatusKey,
  type WorkbenchStatusSources,
  type WorkbenchSource,
  type WorkbenchStatus,
  type WorkbenchNotice,
} from "./tab-status-model";
import type { WorkbenchTab, WorkbenchTabType } from "./tab-model";

interface TabStatusContext {
  sources: WorkbenchStatusSources;
  toolbar: HTMLDivElement | null;
  active: boolean;
  type: WorkbenchTabType;
}
const StatusContext = createContext<TabStatusContext | null>(null);
export function useWorkbenchStatusManaged(): boolean {
  return useContext(StatusContext) !== null;
}

function WorkbenchEmptyStateContent({
  type,
  message,
}: {
  type: WorkbenchTabType;
  message?: string;
}) {
  const adapter = WORKBENCH_STATUS_ADAPTERS[type];
  const Icon = adapter.icon;
  return (
    <div
      data-workbench-empty=""
      className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <Icon className="text-muted-fg size-10" strokeWidth={1} aria-hidden />
      <p className="text-fg2 m-0 text-xs">
        {message ?? adapter.empty.retryable}
      </p>
    </div>
  );
}

export function WorkbenchEmptyState(props: {
  type: WorkbenchTabType;
  message?: string;
}) {
  // A managed frame owns the only fallback, including portal-owned Setup.
  // Raw child failures must not insert an icon during the silent retry or
  // displace retained content; the frame centres persistent fallbacks itself.
  return useWorkbenchStatusManaged() ? null : <WorkbenchEmptyStateContent {...props} />;
}

export function WorkbenchTabBanner({
  status,
  active,
  busy,
  retry,
  type,
  singleFile = false,
  noticeAction,
}: {
  status: WorkbenchStatus | null;
  active: boolean;
  busy: boolean;
  retry: () => void;
  type: WorkbenchTabType;
  singleFile?: boolean;
  noticeAction?: WorkbenchNotice["action"];
}) {
  // Keep this element (and its live region) mounted through recovery, retry,
  // and tone changes. Only message text mutations trigger announcements.
  const Icon =
    status?.tone === "pending"
      ? LoaderCircle
      : status?.tone === "neutral"
        ? Info
        : CircleAlert;
  return (
    <div
      data-workbench-banner=""
      data-tone={status?.tone}
      hidden={!status}
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 px-3 py-1.5 text-xs",
        !status && "hidden",
        status?.tone === "error"
          ? "bg-red-bg text-red-fg"
          : status?.tone === "pending"
            ? "bg-yellow-bg text-yellow-fg"
            : "bg-bg2 text-fg2",
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          active && status?.tone === "pending" && "motion-safe:animate-spin",
        )}
      />
      <span
        role="status"
        aria-live={active ? "polite" : "off"}
        aria-atomic="true"
        className="min-w-0 flex-1"
      >
        <span
          className="line-clamp-2 break-words"
          title={
            status
              ? `${status.message}${status.diagnostic ? `\n${status.diagnostic}` : ""}`
              : undefined
          }
        >
          {status?.message}
        </span>
      </span>
      {(status?.action || noticeAction) && (
        <Button
          variant="ghost"
          size="compact"
          className="shrink-0 text-inherit hover:text-inherit"
          disabled={busy || !active}
          aria-busy={busy || undefined}
          aria-label={
            noticeAction?.label ?? (status?.action === "Retry"
              ? `Retry loading ${type === "files" && singleFile ? "this file" : WORKBENCH_STATUS_ADAPTERS[type].noun}`
              : "Open workspace Setup")
          }
          onClick={noticeAction ? () => { void noticeAction.run(); } : retry}
        >
          {busy ? noticeAction?.busyLabel ?? "Retrying…" : noticeAction?.label ?? status?.action}
        </Button>
      )}
    </div>
  );
}

/** Every tab body, including retained Design/terminal decks, enters this
 * frame. Toolbars portal into its first row; persistent status owns row two. */
export function WorkbenchTabFrame({
  tab,
  folder,
  active,
  statusTarget,
  terminalWorkbench,
  children,
}: {
  tab: WorkbenchTab;
  folder: string;
  active: boolean;
  statusTarget?: string;
  terminalWorkbench?: boolean;
  children: React.ReactNode;
}) {
  const key = workbenchStatusKey(folder, tab, statusTarget);
  const sources = useMemo(() => workbenchSourcesFor(key), [key]);
  const snapshot = useSyncExternalStore(
    sources.subscribe,
    sources.snapshot,
    sources.snapshot,
  );
  const {
    status: availabilityStatus,
    availability,
    visible,
  } = useWorkbenchAvailability(folder, active);
  useLayoutEffect(() => {
    if (visible) return registerWorkbenchFrameVisibility(folder);
  }, [folder, visible]);
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const context = useMemo(
    () => ({ sources, toolbar, active: visible, type: tab.type }),
    [sources, toolbar, visible, tab.type],
  );
  const nextStatus =
    availabilityStatus ??
    (availability.connection === "connected" && snapshot.failure
      ? describeWorkbenchFailure(tab.type, snapshot.failure, !!tab.filePath)
      : null);
  const lastStatus = useRef<{ key: string; status: WorkbenchStatus | null }>({
    key,
    status: null,
  });
  let status =
    nextStatus ??
    ((snapshot.busy ||
      (snapshot.pending && lastStatus.current.status?.tone === "error")) &&
    lastStatus.current.key === key
      ? lastStatus.current.status
      : null);
  if (status?.action === "Open Setup" && tab.terminalId === SETUP_SUBTAB)
    status = { ...status, action: undefined };
  lastStatus.current = { key, status };
  const notice = !status && availability.connection === "connected" ? snapshot.notice : null;
  const blocked = status !== null && !snapshot.hasContent;
  const retry = useCallback(() => {
    if (!visible) return;
    if (status?.action === "Open Setup") {
      openWorkbenchTerminal(folder, {
        terminalId: SETUP_SUBTAB,
        title: "Setup",
        placement: "tab",
      });
      return;
    }
    void sources.retry(
      availability.connection !== "connected" ||
        availabilityStatus?.action === "Retry"
        ? () => reconnectWorkbenchWorkspace(folder)
        : undefined,
    );
  }, [
    visible,
    availability.connection,
    availabilityStatus?.action,
    folder,
    sources,
    status?.action,
  ]);
  return (
    <StatusContext.Provider value={context}>
      <div
        data-workbench-frame={tab.type}
        data-terminal-workbench={terminalWorkbench ? "" : undefined}
        data-workbench-key={key}
        className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <div ref={setToolbar} data-workbench-toolbar="" className="shrink-0" />
        <WorkbenchTabBanner
          status={status ?? (notice ? { tone: notice.tone, message: notice.message } : null)}
          active={visible}
          busy={snapshot.busy || notice?.action?.busy === true}
          noticeAction={notice?.action}
          retry={retry}
          type={tab.type}
          singleFile={!!tab.filePath}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-1 flex-col",
              blocked && "invisible",
            )}
            {...(blocked ? { inert: "", "aria-hidden": true } : {})}
          >
            {children}
          </div>
          {blocked && (
            <div className="absolute inset-0 flex min-h-0 flex-col">
              <WorkbenchEmptyStateContent
                type={tab.type}
                message={describeWorkbenchEmptyState(
                  tab.type,
                  status,
                  !!tab.filePath,
                )}
              />
            </div>
          )}
        </div>
      </div>
    </StatusContext.Provider>
  );
}

export function WorkbenchTabToolbar({
  children,
}: {
  children: React.ReactNode;
}) {
  const context = useContext(StatusContext);
  return context ? (
    context.toolbar && context.active ? (
      createPortal(children, context.toolbar)
    ) : null
  ) : (
    <>{children}</>
  );
}

/** A retained child view shares its tab's store and toolbar slot, but cannot
 * publish an old target's errors or toolbar while hidden. */
export function WorkbenchTabStatusScope({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const context = useContext(StatusContext);
  const value = useMemo(
    () => (context ? { ...context, active: context.active && active } : null),
    [context, active],
  );
  return value ? (
    <StatusContext.Provider value={value}>{children}</StatusContext.Provider>
  ) : (
    <>{children}</>
  );
}

/** Portal children inherit their React owner, not the destination's context.
 * Give retained terminal/setup sources the same store as either placement's
 * frame without moving xterm nodes or mounting a second banner. */
export function WorkbenchTabStatusProvider({
  tab,
  folder,
  active,
  children,
}: {
  tab: WorkbenchTab;
  folder: string;
  active: boolean;
  children: React.ReactNode;
}) {
  const key = workbenchStatusKey(folder, tab);
  const sources = useMemo(() => workbenchSourcesFor(key), [key]);
  const { visible } = useWorkbenchAvailability(folder, active);
  const value = useMemo(
    () => ({ sources, toolbar: null, active: visible, type: tab.type }),
    [sources, visible, tab.type],
  );
  return (
    <StatusContext.Provider value={value}>{children}</StatusContext.Provider>
  );
}

/** Publish persistent read failures or optional neutral notices. Action errors
 * keep their existing toasts. Provide an awaitable retry when possible. */
export function useWorkbenchStatusSource(
  source: WorkbenchSource,
  owner?: string,
): boolean {
  const context = useContext(StatusContext);
  const id = useId() + (owner ?? "");
  const retry = useMemo(
    () => ({
      owner: context?.sources,
      id,
      current: undefined as WorkbenchSource["retry"],
    }),
    [context?.sources, id],
  );
  retry.current = source.retry;
  const retrySource = useCallback(() => retry.current?.(), [retry]);
  const { error, pending, primary, hasContent, active, notice } = source;
  const canRetry = !!source.retry;
  useLayoutEffect(() => {
    if (!context) return;
    context.sources.update(id, {
      error,
      pending,
      active: context.active && active !== false,
      primary,
      hasContent,
      retry: canRetry ? retrySource : undefined,
      retryKey: owner ?? id,
      notice,
    });
  }, [context, id, owner, error, pending, primary, hasContent, retrySource, active, canRetry, notice]);
  useLayoutEffect(
    () => () => context?.sources.remove(id),
    [context?.sources, id],
  );
  return context !== null;
}
