// ──────────────────────────────────────────────────────────
// Settings → General → GitHub
// ──────────────────────────────────────────────────────────
//
// One connection surface, three auth paths (in preference order):
//   1. GitHub CLI — auto-detected on mount (`gh auth token`); zero
//      friction if the user already ran `gh auth login`. (Primary.)
//   2. Personal access token — paste-a-PAT fallback.
//   3. Device-flow OAuth — "Connect with GitHub" using the baked client
//      ID; shows the user code + verification URL inline.
//
// Once connected, every Zeros GitHub action (PR create/merge/review,
// checks, comments) reuses the persisted token via the engine's Octokit.

import React, { useCallback, useState } from "react";
import {
  CircleCheck,
  ExternalLink,
  Eye,
  EyeOff,
  LogOut,
  TriangleAlert,
} from "lucide-react";

import { Button, Input } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";
import {
  ghAuthSignin,
  ghAuthStatus,
  ghDetectCli,
  ghSetToken,
  ghSignOut,
  isGitErrorShape,
} from "../../native/git";
import { nativeListen } from "../../native/runtime";
import { useBridge } from "../bridge/use-bridge";
import { pushGithubTokenToEngine } from "../bridge/github-token-sync";
import {
  ghAuthStatusCache,
  GITHUB_READ_MAX_AGE_MS,
  type GithubConnection,
} from "../store/read-caches";
import { useCachedRead } from "../store/use-cached-read";
import { ZerosSpinner } from "@/loaders";

interface DeviceCode {
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

function humanError(e: unknown): string {
  if (isGitErrorShape(e))
    return e.remediation ? `${e.message} — ${e.remediation}` : e.message;
  return e instanceof Error ? e.message : String(e);
}

const SECTION_HEADING_CLS = "text-[14px] font-medium text-fg2";
// No bg fill — settings groups sit flat / bordered on the page surface
// (the bg2 card treatment was retired 2026-07-12).
const CARD_CLS = "flex flex-col gap-4 rounded-lg border p-6";
const HINT_CLS = "text-sm text-fg2";

export function GitHubSection() {
  const [pat, setPat] = useState("");
  const [showPat, setShowPat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const bridge = useBridge();

  // After any auth change, nudge the engine to re-sync its GitHub token. The
  // gh.* ops run in the engine now (single-writer, option B); Electron main
  // couriers the token directly (the renderer never holds the decrypted value).
  // pushGithubTokenToEngine() is a no-op kept for call-site compatibility.
  const syncToken = useCallback(() => {
    if (bridge) void pushGithubTokenToEngine(bridge);
  }, [bridge]);

  // The probe result is cached: reopening settings shows "Signed in as @x"
  // instantly from the last verdict, and the status/CLI round-trips rerun only
  // past the freshness window (auth changes almost exclusively through the
  // buttons below, which write the cache directly).
  const connection = useCachedRead(
    ghAuthStatusCache,
    "auth",
    async (): Promise<GithubConnection> => {
      const previous = ghAuthStatusCache.getSnapshot("auth").data;
      try {
        const status = await ghAuthStatus();
        if (status.authenticated && status.login) {
          return {
            login: status.login,
            viaCli: previous?.viaCli ?? false,
            ghAvailable: previous?.ghAvailable ?? false,
          };
        }
        // Not signed in — probe the gh CLI and adopt its token if present.
        const gh = await ghDetectCli();
        if (gh.authenticated && gh.login) {
          syncToken();
          return { login: gh.login, viaCli: true, ghAvailable: gh.available };
        }
        return { login: null, viaCli: false, ghAvailable: gh.available };
      } catch (e) {
        throw new Error(humanError(e));
      }
    },
    { maxAgeMs: GITHUB_READ_MAX_AGE_MS },
  );
  const loading = connection.loading;
  const login = connection.data?.login ?? null;
  const viaCli = connection.data?.viaCli ?? false;
  const ghAvailable = connection.data?.ghAvailable ?? false;
  const refresh = connection.refresh;
  const visibleError = error ?? connection.error?.message ?? null;

  const submitPat = async () => {
    if (!pat.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ghSetToken(pat.trim());
      ghAuthStatusCache.setData("auth", {
        login: r.login,
        viaCli: false,
        ghAvailable,
      });
      setPat("");
      syncToken();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const connectDeviceFlow = async () => {
    setBusy(true);
    setError(null);
    setDeviceCode(null);
    let unlisten: () => void = () => {};
    try {
      unlisten = await nativeListen<DeviceCode>("gh:device-code", (v) =>
        setDeviceCode(v),
      );
      const r = await ghAuthSignin();
      ghAuthStatusCache.setData("auth", {
        login: r.login,
        viaCli: false,
        ghAvailable,
      });
      setDeviceCode(null);
      syncToken();
    } catch (e) {
      setError(humanError(e));
    } finally {
      unlisten();
      setBusy(false);
    }
  };

  const doSignOut = async () => {
    setBusy(true);
    try {
      await ghSignOut();
      ghAuthStatusCache.setData("auth", {
        login: null,
        viaCli: false,
        ghAvailable,
      });
      syncToken();
      // Re-probe: matches the old flow, where an authenticated gh CLI is
      // rediscovered (and re-adopted) after an explicit sign-out.
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className={SECTION_HEADING_CLS}>GitHub</div>
      <p className={HINT_CLS}>
        Connect GitHub so Zeros can open and review pull requests, read checks,
        and act on your behalf. Uses your{" "}
        <code className="bg-bg2-hover rounded-sm px-1.5 py-0.5 font-mono text-xs">
          gh
        </code>{" "}
        CLI login automatically when available.
      </p>

      <div className={CARD_CLS}>
        {loading ? (
          <div className="min-h-8" aria-busy="true" />
        ) : login ? (
          // ── Connected ──
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <div className="text-fg1 flex items-center gap-2 text-[14px] font-medium">
                <CircleCheck className="text-green-primary size-4" />
                {viaCli
                  ? "GitHub CLI is authenticated and ready"
                  : "Connected to GitHub"}
              </div>
              <p className="text-fg2 text-sm">
                Signed in as{" "}
                <span className="text-fg1 font-medium">@{login}</span>
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={doSignOut}
            >
              <LogOut className="size-3.5" /> Sign out
            </Button>
          </div>
        ) : (
          // ── Not connected ──
          <div className="flex flex-col gap-4">
            <p className="text-fg2 text-sm">
              {ghAvailable
                ? "GitHub CLI detected but not logged in. Run `gh auth login`, then Refresh — or use a token below."
                : "GitHub CLI not found. Paste a personal access token, or connect with GitHub."}
            </p>

            {/* Paste-a-PAT */}
            <div className="flex flex-col gap-1.5">
              <label className="text-fg1 text-[14px] font-medium">
                GitHub token
              </label>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Input
                    type={showPat ? "text" : "password"}
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    className="pr-9 font-mono text-xs"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitPat();
                    }}
                  />
                  <Tooltip label={showPat ? "Hide" : "Show"}>
                    <button
                      type="button"
                      onClick={() => setShowPat((s) => !s)}
                      className="text-fg2 hover:text-fg1 absolute inset-y-0 right-2 flex items-center"
                    >
                      {showPat ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                  </Tooltip>
                </div>
                <Button
                  size="lg"
                  disabled={busy || !pat.trim()}
                  onClick={submitPat}
                >
                  Save token
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={connectDeviceFlow}
              >
                {busy && !deviceCode ? <ZerosSpinner size={16} /> : null}
                Connect with GitHub
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={refresh}
              >
                Refresh
              </Button>
            </div>

            {/* Device-flow code */}
            {deviceCode && (
              <div className="border-border1 bg-bg1 flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
                <p className="text-fg2 text-sm">
                  Enter this code at GitHub to authorize Zeros:
                </p>
                <div className="flex items-center gap-3">
                  <code className="bg-bg2-hover text-fg1 rounded-sm px-2 py-1 font-mono text-sm font-semibold tracking-widest">
                    {deviceCode.userCode}
                  </code>
                  <a
                    href={deviceCode.verificationUri}
                    target="_blank"
                    rel="noreferrer"
                    className="text-fg2 hover:text-fg1 inline-flex items-center gap-1 text-sm hover:underline"
                  >
                    {deviceCode.verificationUri.replace(/^https?:\/\//, "")}
                    <ExternalLink className="size-3.5" />
                  </a>
                </div>
              </div>
            )}
          </div>
        )}

        {visibleError && (
          <div className="bg-red-bg text-red-fg flex items-start gap-2 rounded-md px-3 py-2 text-xs">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{visibleError}</span>
          </div>
        )}
      </div>
    </section>
  );
}
