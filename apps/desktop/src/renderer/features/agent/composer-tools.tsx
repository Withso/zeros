import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Blocks, LoaderCircle, RefreshCw } from "lucide-react";
import { ComposerToolGroups } from "./composer-tool-groups";
import {
  sessionToolQuerySchema,
  type SessionToolQuery,
} from "@zeros/protocol/agent-extensions";
import { normalizeExternalHttpUrl } from "@zeros/protocol/external-url";
import { Button } from "../../shared/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
} from "../../shared/ui/primitives";
import { useBridge } from "../../platform/bridge/use-bridge";
import { workspaceOp } from "../../platform/bridge/workspace-bridge";
import { shellOpenUrl } from "../../platform/app";
import {
  providerAuthRevision,
  subscribeProviderAuth,
} from "../../platform/provider-auth-state";
import { useCachedRead } from "../../state/use-cached-read";
import {
  createSessionToolsResource,
  sessionToolsResource,
} from "./session-tools-cache";

const offline = {
  ...createSessionToolsResource(() =>
    Promise.reject(new Error("Connect to the workspace to view tools.")),
  ),
  identity: () => "offline",
  subscribe: () => () => {},
};

interface ComposerToolsProps {
  ownerId?: string;
  agentId: string | null;
  sessionId: string | null;
  workspaceId: string | null;
  concealed: boolean;
  onPrepare?: () => void;
  preparing?: boolean;
  preparationError?: string;
}

/** A locally stateful composer island; opening never re-renders the transcript. */
export const ComposerTools = memo(function ComposerTools(
  props: ComposerToolsProps,
) {
  // Remount ephemeral focus/auth state when the semantic chat owner changes.
  return (
    <ToolsPopover
      key={JSON.stringify([
        props.ownerId ?? props.sessionId,
        props.agentId,
        props.workspaceId,
      ])}
      {...props}
    />
  );
});

function ToolsPopover({
  agentId,
  sessionId,
  workspaceId,
  concealed,
  onPrepare,
  preparing = false,
  preparationError,
}: ComposerToolsProps) {
  const bridge = useBridge();
  const resource = bridge ? sessionToolsResource(bridge) : offline;
  useSyncExternalStore(
    resource.subscribe,
    resource.identity,
    resource.identity,
  );
  useSyncExternalStore(
    subscribeProviderAuth,
    providerAuthRevision,
    providerAuthRevision,
  );
  const parsed = useMemo(
    () => sessionToolQuerySchema.safeParse({ agentId, sessionId, workspaceId }),
    [agentId, sessionId, workspaceId],
  );
  const query: SessionToolQuery | null = parsed.success ? parsed.data : null;
  const key = query ? resource.key(query) : null;
  const [open, setOpen] = useState(false);
  const [authState, setAuthState] = useState<{
    key: string;
    toolId?: string;
    error?: string;
  } | null>(null);
  const authBusy = authState?.key === key ? (authState.toolId ?? null) : null;
  const authError = authState?.key === key ? (authState.error ?? null) : null;
  const authFlight = useRef<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const escaped = useRef(false);
  const current = useRef<string | null>(null);
  current.current = concealed ? null : key;
  const visible = open && !concealed;
  const enabled = !concealed && bridge?.status === "connected";
  const read = useCachedRead(resource.cache, key, resource.fetch, {
    enabled: enabled && visible && !preparing,
    maxAgeMs: 5_000,
  });
  const titleId = useId();
  const refreshTools = read.refresh;
  useEffect(() => {
    if (concealed) setOpen(false);
  }, [concealed]);
  useEffect(() => {
    current.current = concealed ? null : key;
    return () => {
      current.current = null;
    };
  }, [concealed, key]);
  // Only the open, visible popover polls. The cache shares reads with intent
  // warming and retains the last confirmed same-session rows during refresh.
  useEffect(() => {
    if (
      !visible ||
      !enabled ||
      preparing ||
      !key ||
      read.data?.state === "unsupported"
    )
      return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") refreshTools();
    };
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [visible, enabled, preparing, key, refreshTools, read.data?.state]);
  const warm = () => {
    if (enabled && !preparing && key)
      void resource.cache
        .load(key, () => resource.fetch(key), { maxAgeMs: 5_000 })
        .catch(() => {});
  };
  const authenticate = useCallback(
    async (toolId: string) => {
      if (!bridge || !query || !key || !enabled || authFlight.current === key)
        return;
      authFlight.current = key;
      setAuthState({ key, toolId });
      try {
        const result = (await workspaceOp(
          bridge,
          "tools.session.authenticate",
          { ...query, toolId },
          20_000,
        )) as { authorizationUrl?: unknown };
        if (current.current !== key || !resource.isCurrent(key)) return;
        const url = normalizeExternalHttpUrl(result.authorizationUrl);
        if (!url) throw new Error("Invalid authentication link");
        await shellOpenUrl(url);
        if (current.current === key) refreshTools();
      } catch {
        if (current.current === key)
          setAuthState({
            key,
            error: "Could not open authentication. Refresh and try again.",
          });
      } finally {
        if (authFlight.current === key) authFlight.current = null;
        if (current.current === key)
          setAuthState((state) => (state?.error ? state : null));
      }
    },
    [bridge, query, key, enabled, resource, refreshTools],
  );
  return (
    <Popover
      open={visible}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen && enabled) onPrepare?.();
      }}
    >
      <Tooltip label="Tools">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label="Tools"
            ref={trigger}
            onPointerEnter={warm}
            onFocus={warm}
          >
            <Blocks className="size-4" />
          </Button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-3"
        aria-labelledby={titleId}
        data-composer-tools=""
        onEscapeKeyDown={() => {
          escaped.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (
            concealed ||
            !trigger.current?.isConnected ||
            trigger.current.closest("[hidden], [inert]")
          ) {
            event.preventDefault();
          } else if (escaped.current) {
            // A rapid pointer-close/reopen can retain Radix's outside-interaction
            // flag until its exit animation ends. Escape still returns focus.
            event.preventDefault();
            trigger.current.focus();
          }
          escaped.current = false;
        }}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 id={titleId} className="text-fg1 text-sm font-medium">
            Tools
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh tools"
            className="text-fg2 hover:text-fg2"
            disabled={
              !enabled ||
              preparing ||
              (!key && !onPrepare) ||
              read.loading ||
              read.refreshing
            }
            onClick={() => {
              onPrepare?.();
              if (key) read.refresh();
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {!enabled ? (
          <p className="text-fg2 text-xs">
            Connect to the workspace to view tools.
          </p>
        ) : preparationError ? (
          <p role="alert" className="text-red-primary text-xs">
            {preparationError}
          </p>
        ) : preparing ? (
          <p role="status" className="text-fg2 text-xs">
            Starting agent and loading tools…
          </p>
        ) : !key ? (
          <p className="text-fg2 text-xs">
            {onPrepare
              ? "Preparing this chat’s tools…"
              : "Select an agent to load tools."}
          </p>
        ) : !read.data && !read.error ? (
          <p
            role="status"
            className="text-fg2 flex items-center gap-2 py-2 text-xs"
          >
            <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />
            Loading tools…
          </p>
        ) : null}
        {enabled && read.data && (
          <ComposerToolGroups
            snapshot={read.data}
            authBusy={authBusy}
            onAuthenticate={authenticate}
          />
        )}
        {(read.error || authError) && (
          <p role="alert" className="text-red-primary mt-2 text-xs">
            {authError ??
              (read.data
                ? "Could not refresh. Showing the last confirmed tool status."
                : "Could not load tools. Refresh to retry.")}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
