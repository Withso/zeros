import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { IconButton } from "@/renderer/shared/ui/primitives/icon-button";
import type {
  GithubAuthMethod,
  GithubAuthSnapshot,
  GithubCredentialSummary,
} from "@zeros/protocol/github-auth";
import {
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  MoreHorizontal,
  Play,
  RefreshCw,
  Terminal,
  Trash2,
  TriangleAlert,
  Unplug,
} from "lucide-react";

import { Button, GithubIcon, Input } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { badgeVariants } from "@/renderer/shared/ui/primitives/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import { toast } from "../../shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import {
  ghAppCancel,
  ghAppConnect,
  ghAuthSnapshot,
  ghMethodDisconnect,
  ghMethodSelect,
  ghPatConnect,
  ghPatRestore,
  githubAppErrorReason,
  isGitErrorShape,
  onGithubAppConnected,
  onGithubAppError,
  onGithubCredentialStoreChanged,
} from "../../platform/git";
import { githubAppErrorCopy } from "../../platform/bridge/github-app-notifications";
import { shellOpenUrl } from "../../platform/app";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../../state/read-caches";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { useNativeRuntime } from "../../platform/runtime";
import { InlineLoginTerminal } from "./inline-login-terminal";
import {
  githubAppConnectOptions,
  githubAutomaticSetup,
  githubHealthDetailCopy,
  githubHealthNeedsAttention,
  githubMethodDescription,
  githubMethodLabel,
  githubMethodStatusCopy,
  githubRefreshFailureSnapshot,
  shouldShowGithubTopRefresh,
} from "./github-connection-model";
import {
  githubConnectErrorKind,
  trackGithubConnectCompleted,
  trackGithubConnectStarted,
  trackGithubHealthRefreshed,
  trackGithubInstallOpened,
  trackGithubMethodSelected,
} from "../../platform/observability/analytics/github-events";
import { RunStream } from "@/renderer/shared/ui/loading/run-stream";
import { githubAuthSnapshotKey } from "./github-auth-prefetch";
import { useSharedGithub, type GithubSettingsOwner } from "./use-shared-github";
import { cloudGithubHealthCopy } from "./cloud-github-health";

const METHODS = ["gh-cli", "github-app", "pat"] as const;

const EMPTY_SNAPSHOT: GithubAuthSnapshot = {
  selectedMethod: "gh-cli",
  methods: {
    "gh-cli": {
      method: "gh-cli",
      health: "not-connected",
      configured: false,
      available: true,
    },
    "github-app": {
      method: "github-app",
      health: "not-connected",
      configured: false,
    },
    pat: {
      method: "pat",
      health: "not-connected",
      configured: false,
    },
  },
};

const GITHUB_HEALTH_LABEL: Record<GithubCredentialSummary["health"], string> = {
  connected: "connected",
  "not-connected": "not connected",
  invalid: "revoked by GitHub",
  "not-installed": "app not installed",
  "rate-limited": "rate limited",
  "sso-required": "SAML authorization required",
  suspended: "installation suspended",
  unavailable: "could not be checked",
};

function errorMessage(error: unknown): string {
  if (isGitErrorShape(error)) {
    return error.remediation
      ? `${error.message} ${error.remediation}`
      : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function openUrl(url: string): void {
  void shellOpenUrl(url).catch(() => {
    toast.error("Couldn’t open that link", {
      description: "Open it in your browser instead.",
    });
  });
}

function hasOtherCredential(
  snapshot: GithubAuthSnapshot,
  method: GithubAuthMethod,
): boolean {
  return METHODS.some(
    (candidate) =>
      candidate !== method && snapshot.methods[candidate].configured,
  );
}

function MethodIcon({ method }: { method: GithubAuthMethod }) {
  const Icon =
    method === "gh-cli"
      ? Terminal
      : method === "github-app"
        ? GithubIcon
        : KeyRound;
  return <Icon className="size-4" aria-hidden="true" />;
}

function IdentityBadge({ summary }: { summary: GithubCredentialSummary }) {
  if (!summary.login) return null;
  const warning = summary.health !== "connected";
  return (
    <span
      className={badgeVariants({ variant: warning ? "warning" : "success" })}
    >
      {/* Keep a non-color warning when the unselected row hides its detail. */}
      {warning ? <TriangleAlert aria-hidden="true" /> : null}
      {summary.login}
      {warning ? (
        <span className="sr-only">{` — ${GITHUB_HEALTH_LABEL[summary.health]}`}</span>
      ) : null}
    </span>
  );
}

function HealthDetail({ summary }: { summary: GithubCredentialSummary }) {
  const copy = githubHealthDetailCopy(summary);
  if (copy === null) return null;

  return (
    <div className="text-fg2 flex min-h-8 items-center gap-2 text-xs leading-4.5">
      <TriangleAlert
        className="text-yellow-text size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{copy}</span>
    </div>
  );
}

export function GitHubSection({
  surfaceActive = true,
  title = "GitHub",
  owner,
  accountId = owner?.userId,
}: {
  surfaceActive?: boolean;
  title?: React.ReactNode;
  owner?: GithubSettingsOwner;
  accountId?: string;
}) {
  const shared = useSharedGithub(owner, surfaceActive);
  const invalidateCloud = shared.invalidate;
  const authKey = githubAuthSnapshotKey(accountId);
  const [setupMethod, setSetupMethod] = useState<GithubAuthMethod | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [pat, setPat] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [busyMethod, setBusyMethod] = useState<GithubAuthMethod | null>(null);
  const [refreshingMethod, setRefreshingMethod] =
    useState<GithubAuthMethod | null>(null);
  const [appWaiting, setAppWaiting] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  // Cancellation invalidates the pending browser handoff before its request resolves.
  const appAttemptRef = useRef(0);
  // Disconnect and Cancel can leave gh-cli selected but unconfigured; do not reopen automatic setup.
  const [autoSetupDismissed, setAutoSetupDismissed] = useState(false);
  const [disconnectAppOpen, setDisconnectAppOpen] = useState(false);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);
  const disconnectAppTriggerRef = useRef<HTMLButtonElement>(null);

  const connected = useNativeRuntime().ready;
  const connection = useRecoveringRead(
    ghAuthStatusCache,
    surfaceActive ? authKey : null,
    () => ghAuthSnapshot(accountId ? { userId: accountId } : undefined),
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS, connected },
  );
  const hasConfirmedSnapshot = connection.data !== undefined;
  const snapshot = connection.data ?? EMPTY_SNAPSHOT;

  const refreshSnapshot = useCallback(
    async (method?: GithubAuthMethod): Promise<GithubAuthSnapshot | null> => {
      if (method) setRefreshingMethod(method);
      try {
        // Bypass deduplication so an explicit App refresh cannot join a probe that skipped inventory.
        const next = await ghAuthSnapshot({
          ...(accountId ? { userId: accountId } : {}),
          refreshApp: method === "github-app",
        });
        ghAuthStatusCache.setData(authKey, next);
        if (method) {
          const summary = next.methods[method];
          trackGithubHealthRefreshed({
            method,
            state: summary.health,
            installationCount: summary.installationCount,
            repositoryCountKnown: summary.repositoryCount !== undefined,
          });
        }
        return next;
      } catch {
        if (method) {
          const prior = ghAuthStatusCache.peekSnapshot(authKey).data;
          if (prior) {
            ghAuthStatusCache.setData(
              authKey,
              githubRefreshFailureSnapshot(prior, method),
            );
          }
        }
        return null;
      } finally {
        if (method) setRefreshingMethod(null);
      }
    },
    [accountId, authKey],
  );

  const selectMethod = useCallback(
    async (method: GithubAuthMethod) => {
      const status = snapshot.methods[method];
      const cloudMethod = owner && method !== "gh-cli" ? shared.read.data?.methods[method] : undefined;
      if (!status.configured || (owner && method !== "gh-cli" && (!cloudMethod?.configured || cloudMethod.login !== status.login))) {
        setSetupMethod(method);
        setTerminalOpen(false);
        return;
      }
      setBusyMethod(method);
      setTerminalOpen(false);
      setSetupMethod(null);
      let changedOnMac = false;
      try {
        const changeCloud = owner && method !== "gh-cli" && shared.read.data?.selectedMethod !== method;
        if (snapshot.selectedMethod !== method) {
          const next = await ghMethodSelect(method, accountId);
          ghAuthStatusCache.setData(authKey, next);
          changedOnMac = true;
        }
        if (changeCloud)
          await shared.change({ action: "select", method });
        if (!changedOnMac) return;
        trackGithubMethodSelected({
          method,
          previousMethod: snapshot.selectedMethod,
          hadOtherCredential: hasOtherCredential(snapshot, method),
        });
      } catch (error) {
        toast.error(changedOnMac ? "Selected on this Mac. Cloud selection failed." : `Couldn’t use ${githubMethodLabel(method)}`, {
          description: errorMessage(error),
        });
      } finally {
        setBusyMethod(null);
      }
    },
    [snapshot, owner, shared, authKey, accountId],
  );

  const finishCliTerminal = useCallback(async () => {
    setTerminalOpen(false);
    try {
      const next = await ghMethodSelect("gh-cli", accountId);
      ghAuthStatusCache.setData(authKey, next);
      setSetupMethod(null);
      trackGithubConnectCompleted({
        method: "gh-cli",
        outcome: "ok",
      });
      if (snapshot.selectedMethod !== "gh-cli") {
        trackGithubMethodSelected({
          method: "gh-cli",
          previousMethod: snapshot.selectedMethod,
          hadOtherCredential: hasOtherCredential(snapshot, "gh-cli"),
        });
      }
      toast.success("GitHub CLI connected", {
        description: next.methods["gh-cli"].login
          ? `Connected as @${next.methods["gh-cli"].login}.`
          : undefined,
      });
    } catch (error) {
      trackGithubConnectCompleted({
        method: "gh-cli",
        outcome: "cancelled",
        errorKind: githubConnectErrorKind(error),
      });
      // The login command may have changed auth before closing; re-probe even when cancelled.
      await refreshSnapshot();
    }
  }, [refreshSnapshot, snapshot, authKey, accountId]);

  const beginCliLogin = useCallback(() => {
    trackGithubConnectStarted({
      method: "gh-cli",
      entryPoint: "settings",
    });
    setTerminalOpen(true);
  }, []);

  const connectPat = useCallback(async () => {
    const token = pat.trim();
    // Enter bypasses the button's disabled state, so guard submissions here too.
    if (token.length < 12 || busyMethod !== null) return;
    trackGithubConnectStarted({
      method: "pat",
      entryPoint: "settings",
    });
    setBusyMethod("pat");
    let savedInCloud = false;
    try {
      if (owner) {
        await shared.change({ action: "pat", token });
        savedInCloud = true;
      }
      const result = await ghPatConnect(token, accountId);
      setPat("");
      setShowPat(false);
      setSetupMethod(null);
      // Use the post-write snapshot so a failed follow-up probe cannot hide a successful connection.
      ghAuthStatusCache.setData(authKey, result.snapshot);
      trackGithubConnectCompleted({ method: "pat", outcome: "ok" });
      if (snapshot.selectedMethod !== "pat") {
        trackGithubMethodSelected({
          method: "pat",
          previousMethod: snapshot.selectedMethod,
          hadOtherCredential: hasOtherCredential(snapshot, "pat"),
        });
      }
      toast.success("Personal Access Token saved", {
        description: `Connected as @${result.login}.`,
      });
    } catch (error) {
      trackGithubConnectCompleted({
        method: "pat",
        outcome: "error",
        errorKind: githubConnectErrorKind(error),
      });
      toast.error(savedInCloud ? "Token saved in Cloud. Retry to connect this Mac." : "Couldn’t save this Personal Access Token", {
        description: errorMessage(error),
      });
    } finally {
      setBusyMethod(null);
    }
  }, [busyMethod, pat, snapshot, owner, shared, accountId, authKey]);

  const connectApp = useCallback(async (options?: {
    forceInstall?: boolean;
  }) => {
    const attempt = appAttemptRef.current;
    // Open setup before the install request so start failures stay visible inline.
    if (options?.forceInstall) setSetupMethod("github-app");
    setBusyMethod("github-app");
    setAppError(null);
    const app = snapshot.methods["github-app"];
    const connectOptions = githubAppConnectOptions(
      app,
      options?.forceInstall === true,
    );
    trackGithubConnectStarted({
      method: "github-app",
      entryPoint: "settings",
    });
    try {
      const started = await ghAppConnect({ ...connectOptions, ...(owner ? { shared: shared.target() } : {}) });
      if (attempt !== appAttemptRef.current || !started) return;
      if (started.flowKind === "install") {
        trackGithubInstallOpened({
          variantKey: "github.com",
          kind: "new",
        });
      }
      setAppWaiting(true);
    } catch (error) {
      // Cancel already recorded the attempt's outcome; ignore a late failure.
      if (attempt !== appAttemptRef.current) return;
      trackGithubConnectCompleted({
        method: "github-app",
        outcome: "error",
        errorKind: githubConnectErrorKind(error),
      });
      // Show start failures inline; callbacks may fail after Settings closes and use the same reason codes.
      const reason = githubAppErrorReason(error);
      const copy = reason ? githubAppErrorCopy(reason) : null;
      if (reason !== "access_denied") {
        setAppError(
          copy ? `${copy.title}. ${copy.description}` : errorMessage(error),
        );
      }
    } finally {
      setBusyMethod(null);
    }
  }, [snapshot.methods, owner, shared]);

  const cancelApp = useCallback(async () => {
    const attempt = appAttemptRef.current;
    try {
      if (!(await ghAppCancel()) || attempt !== appAttemptRef.current) return;
    } catch (error) {
      toast.error("Couldn’t cancel GitHub setup", { description: errorMessage(error) });
      return;
    }
    appAttemptRef.current += 1;
    trackGithubConnectCompleted({
      method: "github-app",
      outcome: "cancelled",
    });
    setAppWaiting(false);
    setAppError(null);
    setSetupMethod(null);
    // Release the chooser immediately; the cancelled request may still be pending.
    setBusyMethod(null);
  }, []);

  // Make retained Settings inert; the app-wide listener still handles the OAuth callback.
  useEffect(() => {
    if (surfaceActive) return;
    appAttemptRef.current += 1;
    setTerminalOpen(false);
    setAppWaiting(false);
    setAppError(null);
    setSetupMethod(null);
    // Reset visibility with the draft so the next pasted token starts masked.
    setPat("");
    setShowPat(false);
    setBusyMethod(null);
    setRefreshingMethod(null);
    setDisconnectAppOpen(false);
  }, [surfaceActive]);

  useEffect(() => {
    if (!surfaceActive) return;
    let closed = false;
    const disposers: Array<() => void> = [];
    void Promise.all([
      onGithubAppConnected(() => {
        invalidateCloud();
        setAppWaiting(false);
        setAppError(null);
        setSetupMethod(null);
        void refreshSnapshot();
      }),
      onGithubAppError(() => {
        invalidateCloud();
        // GithubAppNotifications owns the error toast even when Settings is closed.
        setAppWaiting(false);
        void refreshSnapshot();
      }),
      onGithubCredentialStoreChanged(() => {
        void refreshSnapshot();
      }),
    ]).then((next) => {
      if (closed) {
        for (const dispose of next) dispose();
      } else {
        disposers.push(...next);
      }
    });
    return () => {
      closed = true;
      for (const dispose of disposers) dispose();
    };
  }, [refreshSnapshot, surfaceActive, invalidateCloud]);

  const restorePat = useCallback(async (undoId: string) => {
    try {
      const next = await ghPatRestore(undoId);
      ghAuthStatusCache.setData(authKey, next);
      toast.success("Personal Access Token restored", {
        description: next.methods.pat.login
          ? `Connected as @${next.methods.pat.login}.`
          : "The token is available to Zeros again.",
      });
    } catch (error) {
      toast.error("Couldn’t restore the Personal Access Token", {
        description: errorMessage(error),
      });
    }
  }, [authKey]);

  const removeMethod = useCallback(
    async (method: GithubAuthMethod) => {
      setBusyMethod(method);
      try {
        // Even an empty App row may have a shared exchange in flight against this generation.
        if (owner && method === "github-app")
          await shared.change({ action: "disconnect", method });
        const result = await ghMethodDisconnect(method, accountId);
        ghAuthStatusCache.setData(authKey, result.snapshot);
        setSetupMethod(current => current === method ? null : current);
        if (method === "gh-cli") setTerminalOpen(false);
        if (method === "github-app") setAppWaiting(false);
        if (method === "gh-cli") setAutoSetupDismissed(true);
        if (method === "github-app") {
          toast.info("GitHub App disconnected", {
            description: "gh CLI auth is now selected.",
          });
        } else if (method === "pat") {
          if (owner) {
            try {
              await shared.change({ action: "disconnect", method });
            } catch (error) {
              toast.error("Token removed from this Mac. Cloud removal is unconfirmed.", {
                description: errorMessage(error),
              });
              return;
            }
          }
          toast.info("Personal Access Token removed", {
            description: "This token is no longer available to Zeros.",
            // Match the toast lifetime to the native undo deadline.
            ...(result.undoExpiresAtMs
              ? {
                  duration: Math.max(0, result.undoExpiresAtMs - Date.now()),
                }
              : {}),
            ...(!owner && result.undoId
              ? {
                  action: {
                    label: "Undo",
                    onClick: () => void restorePat(result.undoId!),
                  },
                }
              : {}),
          });
        } else {
          toast.info("GitHub CLI disconnected", {
            description: "Your GitHub CLI login was left unchanged.",
          });
        }
      } catch (error) {
        toast.error(`Couldn’t remove ${githubMethodLabel(method)}`, {
          description: errorMessage(error),
        });
      } finally {
        setBusyMethod(null);
        setDisconnectAppOpen(false);
      }
    },
    [restorePat, owner, shared, authKey, accountId],
  );

  const automaticSetup = useMemo(() => {
    return githubAutomaticSetup(snapshot, hasConfirmedSnapshot);
  }, [hasConfirmedSnapshot, snapshot]);
  const visibleSetup =
    setupMethod ?? (autoSetupDismissed ? null : automaticSetup);

  return (
    <>
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-fg1 m-0 text-xs leading-4.5 font-medium">{title}</h2>
          <p className="text-fg2 mt-0.5 text-xs">
            {owner ? `Connect GitHub for this Mac and cloud workspaces in ${owner.name}.` : "How Zeros signs in to GitHub on this Mac."}
          </p>
        </div>

        {/* Use a group so screen readers expose row buttons; named native radios keep arrow-key navigation. */}
        <div
          role="group"
          aria-label="GitHub authentication method"
          aria-busy={connection.loading || undefined}
          className="flex flex-col gap-2"
        >
          {METHODS.map((method) => {
            const summary = snapshot.methods[method];
            const selected = snapshot.selectedMethod === method;
            const cloudMethod = method !== "gh-cli" && owner ? shared.read.data?.methods[method] : undefined;
            const settingUp = visibleSetup === method;
            const refreshing = refreshingMethod === method;
            const showTopRefresh = shouldShowGithubTopRefresh(
              summary,
              selected,
            );
            return (
              <div
                key={method}
                className={cn(
                  "border-border2 relative grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-xl border p-3.5 transition-colors duration-fast ease-out",
                  selected
                    ? "bg-bg1-hover"
                    : "bg-bg1 hover:border-border3 hover:bg-bg1-hover",
                  githubHealthNeedsAttention(summary) &&
                    "border-yellow-text/30",
                )}
              >
                <input
                  className="border-border4 hover:border-fg3 checked:border-inverted-bg checked:bg-inverted-fg focus-visible:border-accent mt-px size-4 appearance-none rounded-full border transition-[background-color,border-color,box-shadow] duration-fast ease-out checked:shadow-[inset_0_0_0_4px_var(--inverted-bg)] focus-visible:outline-none"
                  type="radio"
                  name="github-auth-method"
                  value={method}
                  checked={selected}
                  aria-label={githubMethodLabel(method)}
                  onChange={() => void selectMethod(method)}
                  disabled={busyMethod !== null || !hasConfirmedSnapshot || (!!owner && method !== "gh-cli" && !shared.read.data)}
                />

                <button
                  type="button"
                  // Only the radio is a tab stop; keep the badge and description exposed to assistive tech.
                  tabIndex={-1}
                  className="min-w-0 cursor-pointer text-left"
                  onClick={() => void selectMethod(method)}
                  disabled={busyMethod !== null || !hasConfirmedSnapshot || (!!owner && method !== "gh-cli" && !shared.read.data)}
                >
                  <span className="text-fg1 flex items-center gap-2 text-xs leading-4.5 font-medium">
                    <MethodIcon method={method} />
                    {githubMethodLabel(method)}
                    {method === "gh-cli" && " · Local only"}
                  </span>
                  {summary.configured && summary.login ? (
                    <span className="mt-2 flex flex-wrap items-center gap-2">
                      <IdentityBadge summary={summary} />
                    </span>
                  ) : (
                    <span className="text-fg3 mt-0.5 block text-3xxs leading-4">
                      {!hasConfirmedSnapshot
                        ? githubMethodDescription(method)
                        : method === "gh-cli" && summary.available
                          ? "GitHub CLI is installed · sign-in required"
                          : githubMethodDescription(method)}
                    </span>
                  )}
                </button>

                {cloudMethod && (
                  <span className="text-fg2 col-start-2 row-start-2 text-xs">
                    {cloudMethod.configured ? `Cloud · ${cloudMethod.login ?? "Connected"}${shared.read.data?.selectedMethod === method ? " · Selected" : ""}` : "Cloud · Disconnected"}
                    {cloudMethod.configured && cloudMethod.health !== "connected" && ` · ${cloudGithubHealthCopy[cloudMethod.health]}`}
                  </span>
                )}

                <div className="flex items-center gap-1">
                  {showTopRefresh ? (
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={refreshing}
                      onClick={() => void refreshSnapshot(method)}
                    >
                      {refreshing ? <RunStream size={16} /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
                      {refreshing ? "Refreshing…" : "Refresh"}
                    </Button>
                  ) : null}

                  {summary.configured || cloudMethod?.configured ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton
                          ref={method === "github-app" ? disconnectAppTriggerRef : undefined}
                          type="button"
                          size="standard"
                          label={`More actions for ${githubMethodLabel(method)}`}
                        >
                          <MoreHorizontal
                            className="size-4"
                            aria-hidden="true"
                          />
                        </IconButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {method === "github-app" &&
                        summary.installationCount === 0 ? (
                          <DropdownMenuItem
                            onSelect={() =>
                              void connectApp({ forceInstall: true })
                            }
                          >
                            <GithubIcon /> Install GitHub App
                          </DropdownMenuItem>
                        ) : method === "github-app" ? (
                          <DropdownMenuItem
                            onSelect={() => {
                              trackGithubInstallOpened({
                                variantKey: "github.com",
                                kind: "reconfigure",
                              });
                              openUrl(
                                "https://github.com/settings/installations",
                              );
                            }}
                          >
                            <GithubIcon /> Configure repositories
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem
                          onSelect={() => {
                            setSetupMethod(method);
                            setTerminalOpen(method === "gh-cli");
                          }}
                        >
                          <RefreshCw /> Reconnect / replace
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-text focus:text-red-text"
                          onSelect={() => {
                            if (method === "github-app") {
                              setDisconnectAppOpen(true);
                            } else {
                              void removeMethod(method);
                            }
                          }}
                        >
                          {method === "gh-cli" ? <Unplug /> : <Trash2 />}
                          {method === "gh-cli"
                            ? "Stop using in Zeros"
                            : method === "pat"
                              ? "Remove token"
                              : "Disconnect"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : hasConfirmedSnapshot && method === "pat" && !settingUp ? (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        openUrl(
                          "https://github.com/settings/personal-access-tokens/new",
                        )
                      }
                    >
                      Create token
                      <ExternalLink className="size-3.5" aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>

                {settingUp ? (
                  <div className="border-border1 col-[2/4] mt-2.5 flex min-w-0 flex-col gap-2.5 border-t pt-3">
                    {method === "gh-cli" ? (
                      terminalOpen ? (
                        <InlineLoginTerminal
                          ownerId="github"
                          binary="gh"
                          args={["auth", "login", "--hostname", "github.com"]}
                          unsetEnv={["GH_TOKEN", "GITHUB_TOKEN"]}
                          onClose={() => void finishCliTerminal()}
                        />
                      ) : (
                        <div className="border-border1 flex flex-col gap-2.5 rounded-md border p-3">
                          <h3 className="text-fg1 m-0 text-xs font-medium">
                            Sign in with GitHub CLI
                          </h3>
                          <p className="text-fg2 m-0 text-xs">
                            Run gh auth login here.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              onClick={beginCliLogin}
                            >
                              <Play className="size-3.5" aria-hidden="true" />
                              Run gh auth login
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => openUrl("https://cli.github.com/")}
                            >
                              Install GitHub CLI
                              <ExternalLink
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => {
                                setSetupMethod(null);
                                setAutoSetupDismissed(true);
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      )
                    ) : method === "github-app" ? (
                      <div className="border-border1 flex flex-col gap-2.5 rounded-md border p-3">
                        <h3 className="text-fg1 m-0 text-xs font-medium">
                          {appWaiting
                            ? "Finish on GitHub"
                            : "Connect GitHub App"}
                        </h3>
                        <p className="text-fg2 m-0 text-xs">
                          {appWaiting
                            ? "Finish on GitHub, then choose Open Zeros."
                            : "Authorize Zeros in your browser."}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          {appWaiting ? (
                            <Button
                              type="button"
                              disabled={refreshing}
                              onClick={() => void refreshSnapshot("github-app")}
                            >
                              {refreshing ? <RunStream size={16} /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
                              Refresh
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              loading={busyMethod === "github-app"}
                              onClick={() => void connectApp()}
                            >
                              Open GitHub
                              <ExternalLink
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={cancelApp}
                          >
                            Cancel
                          </Button>
                        </div>
                        {appError ? (
                          <p
                            role="alert"
                            className="text-yellow-text m-0 flex items-start gap-1.5 text-xs"
                          >
                            <TriangleAlert
                              className="mt-0.5 size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            {appError}
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <div className="border-border1 flex flex-col gap-2.5 rounded-md border p-3">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-fg1 m-0 text-xs font-medium">
                            Connect with a Personal Access Token
                          </h3>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() =>
                              openUrl(
                                "https://github.com/settings/personal-access-tokens/new",
                              )
                            }
                          >
                            Create token
                            <ExternalLink
                              className="size-3.5"
                              aria-hidden="true"
                            />
                          </Button>
                        </div>
                        <p className="text-fg2 m-0 text-xs">
                          Use a fine-grained token for your repositories.
                        </p>
                        <div className="flex items-center gap-2">
                          <div className="relative min-w-0 flex-1">
                            <Input
                              type={showPat ? "text" : "password"}
                              value={pat}
                              autoComplete="off"
                              placeholder="github_pat_…"
                              aria-label="Personal access token"
                              className="pr-10 font-mono text-xs"
                              onChange={(event) => setPat(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void connectPat();
                              }}
                            />
                            <Tooltip
                              label={showPat ? "Hide token" : "Show token"}
                            >
                              <button
                                type="button"
                                className="text-fg2 hover:text-fg1 absolute inset-y-0 right-2 flex items-center"
                                aria-label={
                                  showPat ? "Hide token" : "Show token"
                                }
                                onClick={() => setShowPat((value) => !value)}
                              >
                                {showPat ? (
                                  <EyeOff
                                    className="size-4"
                                    aria-hidden="true"
                                  />
                                ) : (
                                  <Eye className="size-4" aria-hidden="true" />
                                )}
                              </button>
                            </Tooltip>
                          </div>
                          <Button
                            type="button"
                            loading={busyMethod === "pat"}
                            disabled={pat.trim().length < 12}
                            onClick={() => void connectPat()}
                          >
                            Validate & save
                          </Button>
                        </div>
                        <div>
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => {
                              setPat("");
                              // Keep the next pasted token masked.
                              setShowPat(false);
                              setSetupMethod(null);
                            }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : selected &&
                  // An unavailable probe can be unconfigured but still needs a diagnosis.
                  (summary.configured || summary.health !== "not-connected") ? (
                  <div className="border-border1 col-[2/4] mt-2.5 flex min-w-0 flex-col gap-2.5 border-t pt-3">
                    {summary.health === "connected" ? (
                      <div className="text-fg2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2">
                          <CheckCircle2
                            className="text-green-text size-3.5"
                            aria-hidden="true"
                          />
                          {githubMethodStatusCopy(summary)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          disabled={refreshing}
                          onClick={() => void refreshSnapshot(method)}
                        >
                          {refreshing ? <RunStream size={16} /> : <RefreshCw className="size-3.5" aria-hidden="true" />}
                          {refreshing ? "Refreshing…" : "Refresh"}
                        </Button>
                      </div>
                    ) : (
                      <>
                        <HealthDetail summary={summary} />
                        {method === "github-app" &&
                        summary.health === "not-installed" ? (
                          <div>
                            <Button
                              type="button"
                              loading={busyMethod === "github-app"}
                              onClick={() =>
                                void connectApp({ forceInstall: true })
                              }
                            >
                              Install GitHub App
                              <ExternalLink
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </Button>
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="text-fg3 m-0 text-3xxs leading-4">
          Switching keeps your other credentials.
        </p>

        {shared.read.error && owner && (
          <div className="text-fg2 text-xs" role="alert">
            {shared.read.error.message} <Button variant="ghost" onClick={shared.read.refresh}>Refresh</Button>
          </div>
        )}
        {connection.error && !connection.data ? (
          <div className="bg-bg1-raised text-fg2 flex items-start gap-2.5 rounded-md px-3 py-2.5 text-xs">
            <TriangleAlert
              className="text-yellow-text mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            Couldn’t load GitHub authentication settings.
            <Button
              type="button"
              variant="ghost"
              className="ml-auto shrink-0"
              disabled={connection.loading}
              onClick={() => connection.refresh()}
            >
              Try again
            </Button>
          </div>
        ) : null}
      </section>

      <Dialog open={disconnectAppOpen} onOpenChange={setDisconnectAppOpen}>
        <DialogContent
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            disconnectCancelRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // The dialog's menu item is gone; return focus to its trigger only while Settings is active.
            if (surfaceActive) disconnectAppTriggerRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Disconnect GitHub App?</DialogTitle>
            <DialogDescription>
              {owner ? `Disconnect the GitHub App on this Mac and in ${owner.name}. ` : "Zeros will use gh CLI instead. "}The app stays installed on GitHub.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              ref={disconnectCancelRef}
              type="button"
              variant="ghost"
              onClick={() => setDisconnectAppOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={busyMethod === "github-app"}
              onClick={() => void removeMethod("github-app")}
            >
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
