import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GithubAuthMethod,
  GithubAuthSnapshot,
  GithubCredentialSummary,
} from "@zeros/core/github-auth";
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

import { Button, GithubIcon, Input } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/primitives/dropdown-menu";
import { toast } from "../ui/primitives/elements";
import { cn } from "@/zeros/ui/cn";
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
} from "../../native/git";
import { githubAppErrorCopy } from "../bridge/github-app-notifications";
import { shellOpenUrl } from "../../native/native";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
} from "../store/read-caches";
import { useCachedRead } from "../store/use-cached-read";
import { InlineLoginTerminal } from "./inline-login-terminal";
import {
  githubAutomaticSetup,
  githubHealthNeedsAttention,
  githubMethodDescription,
  githubMethodLabel,
  githubMethodStatusCopy,
  githubRefreshFailureSnapshot,
  shouldShowGithubTopRefresh,
} from "./github-section-helpers";
import {
  githubConnectErrorKind,
  trackGithubConnectCompleted,
  trackGithubConnectStarted,
  trackGithubHealthRefreshed,
  trackGithubInstallOpened,
  trackGithubMethodSelected,
} from "../analytics/github-events";

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

/** Short, non-colour statement of a row's health, for assistive tech. */
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

/** Open an external link without leaving a floating rejection behind. The UI
 *  smoke run asserts no uncaught page errors, and a bare `void shellOpenUrl(…)`
 *  breaks that the first time main refuses. */
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
      className={cn(
        "inline-flex min-h-6 items-center gap-1.5 rounded-sm px-2.5 py-0.5 text-xs",
        warning ? "bg-yellow-bg text-yellow-fg" : "bg-green-bg text-green-fg",
      )}
    >
      {/* An icon, not only the amber fill: for an UNSELECTED row the detail
          block is not rendered, so colour alone was the entire signal that a
          connection needs attention (WCAG 1.4.1). The design's borderless,
          dotless, username-only badge is otherwise unchanged. */}
      {warning ? <TriangleAlert className="size-3" aria-hidden="true" /> : null}
      {summary.login}
      {warning ? (
        <span className="sr-only">{` — ${GITHUB_HEALTH_LABEL[summary.health]}`}</span>
      ) : null}
    </span>
  );
}

function HealthDetail({ summary }: { summary: GithubCredentialSummary }) {
  if (summary.health === "connected") return null;

  const copy =
    summary.health === "rate-limited"
      ? "GitHub is rate-limiting requests. This connection has not been removed."
      : summary.health === "sso-required"
        ? "Your organization requires SAML authorization for this connection."
        : summary.health === "not-installed"
          ? // Settings has no "current repository" — this row describes the
            // connection. Naming one here read as a per-repo verdict the panel
            // is not in a position to make.
            summary.detail ||
            "The GitHub App isn’t installed on any account yet."
          : summary.health === "suspended"
            ? summary.detail ||
              "This installation was suspended by the account owner."
            : summary.health === "invalid"
              ? "GitHub revoked this connection. Reconnect to continue."
              : summary.detail ||
                "Couldn’t check this connection. You may be offline.";

  return (
    <div className="bg-bg1-highlight text-fg2 flex items-start gap-2.5 rounded-md px-3 py-2.5 text-xs leading-relaxed">
      <TriangleAlert
        className="text-yellow-fg mt-0.5 size-3.5 shrink-0"
        aria-hidden="true"
      />
      <span>{copy}</span>
    </div>
  );
}

export function GitHubSection() {
  const [setupMethod, setSetupMethod] = useState<GithubAuthMethod | null>(null);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [pat, setPat] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [busyMethod, setBusyMethod] = useState<GithubAuthMethod | null>(null);
  const [refreshingMethod, setRefreshingMethod] =
    useState<GithubAuthMethod | null>(null);
  const [appWaiting, setAppWaiting] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  // Bumped by Cancel. begin() resolves silently when a cancel lands during its
  // control-plane round trip, so without this the resolving call re-latched
  // `appWaiting` and left a "Finish on GitHub" card for a browser that never
  // opened — a state only Cancel could escape.
  const appAttemptRef = useRef(0);
  // The automatic gh-cli setup card is a cold-mount convenience. Once the user
  // has acted on that row — including choosing "Stop using in Zeros", which
  // leaves gh-cli selected and unconfigured and so re-satisfies the heuristic —
  // it stays closed rather than re-opening under the user.
  const [autoSetupDismissed, setAutoSetupDismissed] = useState(false);
  const [disconnectAppOpen, setDisconnectAppOpen] = useState(false);
  const disconnectCancelRef = useRef<HTMLButtonElement>(null);

  // The fetcher ignores the key it is handed: this read's key is the constant
  // "auth", so the probe's options never vary with it. Passing `ghAuthSnapshot`
  // bare would hand the key straight to its `options` parameter.
  const connection = useCachedRead(
    ghAuthStatusCache,
    "auth",
    () => ghAuthSnapshot(),
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const hasConfirmedSnapshot = connection.data !== undefined;
  const snapshot = connection.data ?? EMPTY_SNAPSHOT;

  const refreshSnapshot = useCallback(
    async (method?: GithubAuthMethod): Promise<GithubAuthSnapshot | null> => {
      if (method) setRefreshingMethod(method);
      try {
        // Deliberately NOT ghAuthStatusCache.load(): that dedupes against an
        // in-flight background read and returns ITS promise, so a user's
        // Refresh on the App row could be answered by a probe that ran with
        // refreshApp:false — the installation inventory never re-checked, the
        // spinner stopping on the wrong result. Probe directly, then publish
        // authoritatively so every subscriber still updates.
        const next = await ghAuthSnapshot({
          refreshApp: method === "github-app",
        });
        ghAuthStatusCache.setData("auth", next);
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
          const prior = ghAuthStatusCache.peekSnapshot("auth").data;
          if (prior) {
            ghAuthStatusCache.setData(
              "auth",
              githubRefreshFailureSnapshot(prior, method),
            );
          }
        }
        return null;
      } finally {
        if (method) setRefreshingMethod(null);
      }
    },
    [],
  );

  const selectMethod = useCallback(
    async (method: GithubAuthMethod) => {
      const status = snapshot.methods[method];
      if (status.configured && snapshot.selectedMethod === method) return;
      if (!status.configured) {
        setSetupMethod(method);
        setTerminalOpen(false);
        return;
      }
      setBusyMethod(method);
      try {
        const next = await ghMethodSelect(method);
        ghAuthStatusCache.setData("auth", next);
        setSetupMethod(null);
        trackGithubMethodSelected({
          method,
          previousMethod: snapshot.selectedMethod,
          hadOtherCredential: hasOtherCredential(snapshot, method),
        });
      } catch (error) {
        toast.error(`Couldn’t use ${githubMethodLabel(method)}`, {
          description: errorMessage(error),
        });
      } finally {
        setBusyMethod(null);
      }
    },
    [snapshot],
  );

  const finishCliTerminal = useCallback(async () => {
    setTerminalOpen(false);
    try {
      const next = await ghMethodSelect("gh-cli");
      ghAuthStatusCache.setData("auth", next);
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
      // Closing/cancelling the CLI is not an error event. Re-probe quietly so
      // the row reflects whatever the command actually changed.
      await refreshSnapshot();
    }
  }, [refreshSnapshot, snapshot]);

  const cliConnected = snapshot.methods["gh-cli"].health === "connected";
  // Whether the terminal was opened while gh was ALREADY signed in (the
  // "Reconnect / replace" path), which must not auto-close instantly.
  const openedCliConnectedRef = useRef(false);

  const beginCliLogin = useCallback(() => {
    openedCliConnectedRef.current = cliConnected;
    trackGithubConnectStarted({
      method: "gh-cli",
      entryPoint: "settings",
    });
    setTerminalOpen(true);
  }, [cliConnected]);

  // `gh auth login` runs inside a live login shell, so the shell does not exit
  // when it finishes and `onExit` never fires. Poll the auth probe while the
  // terminal is open — the same 3 s cadence the Claude/Codex login uses — so a
  // completed sign-in is actually noticed.
  //
  // Bounded, unlike theirs: this probe also validates a configured PAT/App
  // against the GitHub API, so an abandoned terminal left open all day would
  // spend real rate limit. Five minutes covers any realistic browser handshake;
  // after that the window-focus refresh and the row's Refresh still work.
  useEffect(() => {
    if (!terminalOpen || cliConnected) return;
    let remaining = 100;
    const id = window.setInterval(() => {
      if (remaining-- <= 0) {
        window.clearInterval(id);
        return;
      }
      void refreshSnapshot();
    }, 3_000);
    return () => window.clearInterval(id);
  }, [terminalOpen, cliConnected, refreshSnapshot]);

  // Auto-close on a real signed-out→signed-in transition, matching the
  // Claude/Codex terminal. finishCliTerminal closes it, selects gh CLI, and
  // raises the one success toast.
  useEffect(() => {
    if (!terminalOpen || !cliConnected || openedCliConnectedRef.current) return;
    void finishCliTerminal();
  }, [terminalOpen, cliConnected, finishCliTerminal]);

  const connectPat = useCallback(async () => {
    const token = pat.trim();
    // The Enter key reaches this directly, so it repeats the button's own
    // guards: a second Enter used to fire a concurrent gh_pat_connect (two
    // success toasts), and Enter on a 5-character token submitted a value the
    // disabled button was refusing.
    if (token.length < 12 || busyMethod !== null) return;
    trackGithubConnectStarted({
      method: "pat",
      entryPoint: "settings",
    });
    setBusyMethod("pat");
    try {
      const result = await ghPatConnect(token);
      setPat("");
      setShowPat(false);
      setSetupMethod(null);
      // main returns the authoritative post-write snapshot, so the row cannot
      // sit on "not connected" under a "Connected as @…" toast just because a
      // follow-up probe failed (refreshSnapshot() swallows its own errors).
      ghAuthStatusCache.setData("auth", result.snapshot);
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
      toast.error("Couldn’t save this Personal Access Token", {
        description: errorMessage(error),
      });
    } finally {
      setBusyMethod(null);
    }
  }, [busyMethod, pat, snapshot]);

  const connectApp = useCallback(async () => {
    const attempt = appAttemptRef.current;
    setBusyMethod("github-app");
    setAppError(null);
    const app = snapshot.methods["github-app"];
    const installFlow = !app.configured || app.installationCount === 0;
    trackGithubConnectStarted({
      method: "github-app",
      entryPoint: "settings",
    });
    try {
      await ghAppConnect({ installFlow });
      // Cancelled while the control plane was answering: main already discarded
      // the handoff, so there is nothing to finish on GitHub.
      if (attempt !== appAttemptRef.current) return;
      if (installFlow) {
        trackGithubInstallOpened({
          variantKey: "github.com",
          kind: "new",
        });
      }
      setAppWaiting(true);
    } catch (error) {
      // Cancel already closed this attempt's funnel entry, so a late failure
      // must not report a second outcome for the same attempt.
      if (attempt !== appAttemptRef.current) return;
      trackGithubConnectCompleted({
        method: "github-app",
        outcome: "error",
        errorKind: githubConnectErrorKind(error),
      });
      // Inline, not a toast: the user is looking at this card, the message is
      // often durable ("not available on this control plane"), and the approved
      // design routes a failure to *open* GitHub inline. The browser-callback
      // half still toasts, because Settings may be closed by then.
      // main tags the rejection with the same reason that callback emits, so
      // both halves of the flow use one vocabulary.
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
  }, [snapshot.methods]);

  const cancelApp = useCallback(() => {
    appAttemptRef.current += 1;
    void ghAppCancel().catch(() => {
      // Cancel is local-first: main clears its own pending handoff, and a failed
      // IPC must not leave the card stuck in a waiting state.
    });
    trackGithubConnectCompleted({
      method: "github-app",
      outcome: "cancelled",
    });
    setAppWaiting(false);
    setAppError(null);
    setSetupMethod(null);
    // Cancel closes the card, so nothing is left on screen to explain why every
    // radio is still dead. connectApp's own `finally` only lands when the
    // control-plane round trip settles — up to the 15 s request timeout, longer
    // if the Auth0 token refresh stalls — and its `attempt` guard already makes
    // that late result a no-op. Releasing the chooser here is what makes Cancel
    // mean cancel rather than "wait, silently, for something you dismissed".
    setBusyMethod(null);
  }, []);

  useEffect(() => {
    let closed = false;
    const disposers: Array<() => void> = [];
    void Promise.all([
      onGithubAppConnected(() => {
        setAppWaiting(false);
        setAppError(null);
        setSetupMethod(null);
        void refreshSnapshot();
      }),
      onGithubAppError(() => {
        // GithubAppNotifications owns the copy for this one (it stays mounted
        // when Settings is closed); here we only leave the waiting state.
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
  }, [refreshSnapshot]);

  const restorePat = useCallback(async (undoId: string) => {
    try {
      const next = await ghPatRestore(undoId);
      ghAuthStatusCache.setData("auth", next);
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
  }, []);

  const removeMethod = useCallback(
    async (method: GithubAuthMethod) => {
      setBusyMethod(method);
      try {
        const result = await ghMethodDisconnect(method);
        ghAuthStatusCache.setData("auth", result.snapshot);
        setSetupMethod(null);
        setTerminalOpen(false);
        setAppWaiting(false);
        // Disconnecting gh-cli leaves it selected and unconfigured, which is
        // exactly the shape the automatic setup card opens on. Suppress it so
        // the row doesn't immediately ask the user to sign back in.
        if (method === "gh-cli") setAutoSetupDismissed(true);
        if (method === "github-app") {
          toast.info("GitHub App disconnected", {
            description: "gh CLI auth is now selected.",
          });
        } else if (method === "pat") {
          toast.info("Personal Access Token removed", {
            description: "This token is no longer available to Zeros.",
            // Keep the Undo button on screen for as long as main will actually
            // honor the handle; the default toast duration is shorter than the
            // undo window, so the affordance would vanish while it still works.
            ...(result.undoExpiresAtMs
              ? {
                  duration: Math.max(0, result.undoExpiresAtMs - Date.now()),
                }
              : {}),
            ...(result.undoId
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
    [restorePat],
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
          <h2 className="text-fg1 m-0 text-[14px] font-medium">GitHub</h2>
          <p className="text-fg2 mt-0.5 text-xs">
            Choose how Zeros authenticates GitHub operations on this Mac.
          </p>
        </div>

        {/* `role="group"`, not `radiogroup`: each row also carries Refresh, a
            menu, and a "Create token" button, and ARIA allows only radios (plus
            grouping elements) inside a radiogroup — screen readers commonly drop
            those buttons from group traversal. The native `name=` on the inputs
            below is what actually provides arrow-key radio semantics. */}
        <div
          role="group"
          aria-label="GitHub authentication method"
          aria-busy={connection.loading || undefined}
          className="flex flex-col gap-2"
        >
          {METHODS.map((method) => {
            const summary = snapshot.methods[method];
            const selected = snapshot.selectedMethod === method;
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
                  "relative grid min-h-[66px] grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2.5 rounded-md border px-3.5 py-3.5 transition-colors",
                  selected
                    ? "border-border4 bg-bg1-highlight"
                    : "border-border2 bg-bg1 hover:border-border3",
                  githubHealthNeedsAttention(summary) &&
                    "border-yellow-primary/30",
                )}
              >
                <input
                  className="border-border4 checked:border-fg1 checked:bg-fg1 mt-0.5 size-4 appearance-none rounded-full border-[1.5px] checked:shadow-[inset_0_0_0_3px_var(--bg1-highlight)]"
                  type="radio"
                  name="github-auth-method"
                  value={method}
                  checked={selected}
                  aria-label={githubMethodLabel(method)}
                  onChange={() => void selectMethod(method)}
                  disabled={busyMethod !== null || !hasConfirmedSnapshot}
                />

                <button
                  type="button"
                  // Not a tab stop: the radio beside it is the accessible
                  // control for the same action, so keeping both focusable made
                  // every row cost two tab stops and announce its name twice.
                  // It stays readable to assistive tech, because the status
                  // badge and description live inside it.
                  tabIndex={-1}
                  className="min-w-0 cursor-pointer text-left"
                  onClick={() => void selectMethod(method)}
                  disabled={busyMethod !== null || !hasConfirmedSnapshot}
                >
                  <span className="text-fg1 flex items-center gap-2 text-[14px] font-medium">
                    <MethodIcon method={method} />
                    {githubMethodLabel(method)}
                  </span>
                  {summary.configured && summary.login ? (
                    <span className="mt-2 flex flex-wrap items-center gap-2">
                      <IdentityBadge summary={summary} />
                    </span>
                  ) : (
                    <span className="text-fg3 mt-0.5 block text-xs">
                      {!hasConfirmedSnapshot
                        ? githubMethodDescription(method)
                        : method === "gh-cli" && summary.available
                          ? "GitHub CLI is installed · sign-in required"
                          : githubMethodDescription(method)}
                    </span>
                  )}
                </button>

                <div className="flex items-center gap-1">
                  {showTopRefresh ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={refreshing}
                      onClick={() => void refreshSnapshot(method)}
                    >
                      <RefreshCw
                        className={cn("size-3.5", refreshing && "animate-spin")}
                        aria-hidden="true"
                      />
                      {refreshing ? "Refreshing…" : "Refresh"}
                    </Button>
                  ) : null}

                  {summary.configured ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`More actions for ${githubMethodLabel(method)}`}
                        >
                          <MoreHorizontal
                            className="size-4"
                            aria-hidden="true"
                          />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {method === "github-app" ? (
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
                          className="text-red-fg focus:text-red-fg"
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
                      size="sm"
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
                          args={["auth", "login"]}
                          onClose={() => void finishCliTerminal()}
                        />
                      ) : (
                        <div className="border-border1 bg-sidebar flex flex-col gap-2.5 rounded-md border p-3">
                          <h3 className="text-fg1 m-0 text-xs font-medium">
                            Sign in with GitHub CLI
                          </h3>
                          <p className="text-fg2 m-0 text-xs">
                            Run the GitHub CLI login inside Zeros using the same
                            inline terminal experience as Claude and Codex.
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              type="button"
                              size="sm"
                              onClick={beginCliLogin}
                            >
                              <Play className="size-3.5" aria-hidden="true" />
                              Run gh auth login
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => openUrl("https://cli.github.com/")}
                            >
                              Install GitHub CLI
                              <ExternalLink
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </Button>
                            {/* Without a Cancel this card was a trap: it
                                re-opens from the same signed-out state it
                                describes, so dismissing another row's card
                                brought it straight back. */}
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
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
                      <div className="border-border1 bg-sidebar flex flex-col gap-2.5 rounded-md border p-3">
                        <h3 className="text-fg1 m-0 text-xs font-medium">
                          {appWaiting
                            ? "Finish on GitHub"
                            : "Connect GitHub App"}
                        </h3>
                        <p className="text-fg2 m-0 text-xs">
                          {appWaiting
                            ? "Authorize your account and choose repository access in the browser, then return to Zeros."
                            : "GitHub opens in your browser so you can choose an account and select repository access."}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          {appWaiting ? (
                            <Button
                              type="button"
                              size="sm"
                              disabled={refreshing}
                              onClick={() => void refreshSnapshot("github-app")}
                            >
                              <RefreshCw
                                className={cn(
                                  "size-3.5",
                                  refreshing && "animate-spin",
                                )}
                                aria-hidden="true"
                              />
                              Refresh
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
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
                            size="sm"
                            onClick={cancelApp}
                          >
                            Cancel
                          </Button>
                        </div>
                        {appError ? (
                          <p
                            role="alert"
                            className="text-yellow-fg m-0 flex items-start gap-1.5 text-xs"
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
                      <div className="border-border1 bg-sidebar flex flex-col gap-2.5 rounded-md border p-3">
                        <div className="flex items-center justify-between gap-3">
                          <h3 className="text-fg1 m-0 text-xs font-medium">
                            Connect with a Personal Access Token
                          </h3>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
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
                          Create a fine-grained token for the repositories you
                          use. Local operations also accept a classic token.
                        </p>
                        <div className="flex items-center gap-2">
                          <div className="relative min-w-0 flex-1">
                            <Input
                              type={showPat ? "text" : "password"}
                              value={pat}
                              autoComplete="off"
                              placeholder="github_pat_…"
                              aria-label="Personal access token"
                              className="pr-9 font-mono text-xs"
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
                            size="sm"
                            onClick={() => {
                              setPat("");
                              // Reset the reveal too — it used to persist, so
                              // reopening the card rendered the next pasted
                              // token in cleartext.
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
                  // `configured` alone hid the explanation for the one state
                  // that most needs it: a probe that errored reports
                  // health:"unavailable" with configured:false, and the setup
                  // card is also suppressed for it — so the row showed a lone
                  // Refresh button and no reason at all.
                  (summary.configured || summary.health !== "not-connected") ? (
                  <div className="border-border1 col-[2/4] mt-2.5 flex min-w-0 flex-col gap-2.5 border-t pt-3">
                    {summary.health === "connected" ? (
                      <div className="text-fg2 flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2">
                          <CheckCircle2
                            className="text-green-fg size-3.5"
                            aria-hidden="true"
                          />
                          {githubMethodStatusCopy(summary)}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={refreshing}
                          onClick={() => void refreshSnapshot(method)}
                        >
                          <RefreshCw
                            className={cn(
                              "size-3.5",
                              refreshing && "animate-spin",
                            )}
                            aria-hidden="true"
                          />
                          {refreshing ? "Refreshing…" : "Refresh"}
                        </Button>
                      </div>
                    ) : (
                      <HealthDetail summary={summary} />
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <p className="text-fg3 m-0 text-xs">
          Inactive credentials remain saved. Switching methods never deletes
          another method’s connection.
        </p>

        {connection.error && !connection.data ? (
          <div className="bg-bg1-highlight text-fg2 flex items-start gap-2.5 rounded-md px-3 py-2.5 text-xs">
            <TriangleAlert
              className="text-yellow-fg mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
            Couldn’t load GitHub authentication settings.
            {/* Without a snapshot every control above is disabled and the cached
                read deliberately does not retry on error, so this is the only
                way back — Settings stays mounted, so leaving and returning does
                not re-probe either. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
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
        >
          <DialogHeader>
            <DialogTitle>Disconnect GitHub App?</DialogTitle>
            <DialogDescription>
              This changes how Zeros connects to GitHub.
            </DialogDescription>
          </DialogHeader>
          <ul className="text-fg2 m-0 list-disc space-y-2 pl-5 text-sm">
            <li>
              Zeros will stop using this connection for pull requests, pushes,
              and other GitHub actions.
            </li>
            <li>gh CLI auth becomes the selected authentication method.</li>
            <li>
              The GitHub App installation and its repository access stay on
              GitHub until you change them in GitHub settings.
            </li>
          </ul>
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
