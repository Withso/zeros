import { useEffect, useRef, useState } from "react";
import {
  Check,
  ExternalLink,
  KeyRound,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { CloudGithubMethod } from "@zeros/protocol/cloud-github-connection";
import { Button, GithubIcon, Input } from "../../shared/ui";
import { SettingsSection } from "./settings-ui";
import { shellOpenUrl } from "../../platform/app";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { cn } from "../../shared/ui/cn";
import {
  beginCloudGithubConnection,
  changeCloudGithubConnection,
  cloudGithubConnectionCache,
  cloudGithubConnectionKey,
  readCloudGithubConnection,
} from "../../platform/cloud-github-connection";
import { cloudGithubHealthCopy } from "./cloud-github-health";

const methods = ["github-app", "pat"] as const;
const label = (method: CloudGithubMethod) =>
  method === "github-app" ? "Zeros GitHub App" : "Personal Access Token";

export function CloudGithubSection({
  userId,
  organizationId,
  surfaceActive,
}: {
  userId: string;
  organizationId: string;
  surfaceActive: boolean;
}) {
  const key = cloudGithubConnectionKey(userId, organizationId);
  const snapshot = useRecoveringRead(
    cloudGithubConnectionCache,
    key,
    (value) => {
      const [user, org] = JSON.parse(value) as [string, string];
      return readCloudGithubConnection(user, org);
    },
    { enabled: surfaceActive, maxAgeMs: 30_000 },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [patOpen, setPatOpen] = useState(false),
    [pat, setPat] = useState("");
  const [waiting, setWaiting] = useState<{
    generation: string;
    expires: number;
  } | null>(null);
  const live = useRef({ key, mounted: true }),
    pending = useRef(false);
  live.current.key = key;
  useEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
    };
  }, []);
  const current = () => live.current.mounted && live.current.key === key;
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current || !surfaceActive) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (current())
        setError(
          cause instanceof Error
            ? cause.message
            : "GitHub connection failed. Try again.",
        );
    } finally {
      pending.current = false;
      if (current()) {
        setBusy(false);
        cloudGithubConnectionCache.invalidate(key);
      }
    }
  };
  useEffect(() => {
    if (!surfaceActive || !waiting) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() >= waiting.expires) {
        setWaiting(null);
        setError("GitHub sign-in timed out. Start again to reconnect.");
        return;
      }
      void cloudGithubConnectionCache
        .load(key, () => readCloudGithubConnection(userId, organizationId), {
          maxAgeMs: 0,
        })
        .catch(() => {});
    };
    const timer = window.setInterval(refresh, 2500);
    refresh();
    return () => window.clearInterval(timer);
  }, [key, organizationId, surfaceActive, userId, waiting]);
  useEffect(() => {
    if (
      waiting &&
      snapshot.data &&
      snapshot.data.generation !== waiting.generation
    )
      setWaiting(null);
  }, [snapshot.data, waiting]);
  const change = (
    action: Parameters<typeof changeCloudGithubConnection>[3],
  ) => {
    const value = snapshot.data;
    if (!value)
      return Promise.reject(
        new Error("Refresh your GitHub connection before continuing."),
      );
    return changeCloudGithubConnection(
      userId,
      organizationId,
      value.generation,
      action,
    );
  };
  const begin = async () => {
    if (!snapshot.data) return;
    const result = await beginCloudGithubConnection(
      userId,
      organizationId,
      snapshot.data.generation,
    );
    if (!current()) return;
    // Publish this attempt before polling so an older rendered snapshot cannot
    // be mistaken for completion of the browser authorization.
    const fresh = await readCloudGithubConnection(userId, organizationId);
    if (!current()) return;
    cloudGithubConnectionCache.setData(key, fresh);
    setWaiting({
      generation: result.generation,
      expires: Date.now() + 10 * 60_000,
    });
    await shellOpenUrl(result.url);
  };
  const openUrl = (url: string) => void run(() => shellOpenUrl(url));
  return (
    <SettingsSection
      title="GitHub"
      description="Choose how Zeros connects to GitHub for your cloud workspaces in this organization."
      action={
        <Button
          variant="ghost"
          aria-label="Refresh cloud GitHub connection"
          disabled={busy || snapshot.refreshing}
          onClick={() => {
            setError(null);
            snapshot.refresh();
          }}
        >
          <RefreshCw className="size-3.5" />
        </Button>
      }
    >
      {(error || snapshot.error) && (
        <p className="text-red-primary text-xs" role="alert">
          {error ?? snapshot.error?.message}
        </p>
      )}
      <div
        className="flex flex-col gap-2"
        role="group"
        aria-label="Cloud GitHub authentication method"
        aria-busy={snapshot.loading || undefined}
      >
        {methods.map((method) => {
          const summary = snapshot.data?.methods[method],
            selected = snapshot.data?.selectedMethod === method;
          const Icon = method === "github-app" ? GithubIcon : KeyRound;
          const attention =
            summary?.configured && summary.health !== "connected";
          return (
            <div
              key={method}
              role="group"
              aria-label={label(method)}
              className={cn(
                "flex flex-col gap-3 rounded-md border p-3.5",
                selected
                  ? "border-border4 bg-bg1-highlight"
                  : "border-border2 bg-bg1",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-col gap-1.5">
                  <span className="text-fg1 flex items-center gap-2 text-sm font-medium">
                    <Icon className="size-4" />
                    {label(method)}
                  </span>
                  <span className="text-fg2 text-xs">
                    {summary?.login
                      ? `Signed in as ${summary.login}`
                      : method === "github-app"
                        ? "Sign in through GitHub and choose repository access."
                        : "Use a token you create and control on GitHub."}
                  </span>
                  {selected && (
                    <span className="text-fg2 flex items-center gap-1 text-xs">
                      <Check className="size-3.5" />
                      Selected for cloud workspaces
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {summary?.configured && !selected && (
                    <Button
                      variant="secondary"
                      disabled={busy || !!waiting}
                      onClick={() =>
                        void run(() => change({ action: "select", method }))
                      }
                    >
                      Use
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    disabled={
                      busy ||
                      !snapshot.data ||
                      !!waiting ||
                      (method === "github-app" && !snapshot.data.appAvailable)
                    }
                    onClick={() =>
                      method === "github-app"
                        ? void run(begin)
                        : setPatOpen((value) => !value)
                    }
                  >
                    {summary?.configured
                      ? method === "pat"
                        ? "Replace"
                        : "Reconnect"
                      : "Connect"}
                  </Button>
                  {summary?.configured && (
                    <Button
                      variant="ghost"
                      disabled={busy || !!waiting}
                      aria-label={`Disconnect ${label(method)}`}
                      onClick={() =>
                        void run(() => change({ action: "disconnect", method }))
                      }
                    >
                      Disconnect
                    </Button>
                  )}
                </div>
              </div>
              {attention && (
                <p
                  className="text-fg2 flex items-start gap-2 text-xs"
                  role="status"
                >
                  <TriangleAlert className="text-yellow-fg size-3.5 shrink-0" />
                  {cloudGithubHealthCopy[summary.health]}
                </p>
              )}
              {method === "github-app" && snapshot.data?.installUrl && (
                <Button
                  variant="ghost"
                  className="self-start"
                  disabled={busy}
                  onClick={() => openUrl(snapshot.data!.installUrl!)}
                >
                  Grant Zeros access in GitHub
                  <ExternalLink className="size-3.5" />
                </Button>
              )}
              {method === "github-app" && waiting && (
                <div className="flex items-center justify-between gap-2">
                  <p className="text-fg2 text-xs" role="status">
                    Finish signing in on GitHub.
                  </p>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await changeCloudGithubConnection(
                          userId,
                          organizationId,
                          waiting.generation,
                          { action: "cancel" },
                        );
                        if (current()) setWaiting(null);
                      })
                    }
                  >
                    Cancel
                  </Button>
                </div>
              )}
              {method === "pat" && patOpen && (
                <div className="border-border1 flex flex-col gap-2.5 border-t pt-3">
                  <Input
                    type="password"
                    value={pat}
                    aria-label="Cloud GitHub personal access token"
                    placeholder="Paste your personal access token"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setPat(event.target.value)}
                  />
                  <p className="text-fg2 text-xs">
                    Choose the repositories you need. Allow Contents for Git and
                    Pull requests for PR actions. Add Checks read to show CI
                    results. Organization approval may be required.
                  </p>
                  <p className="text-fg2 text-xs">
                    Git tools in your cloud VM can use this token with all of
                    its GitHub permissions. Prefer a token limited to the
                    repositories you work on.
                  </p>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy || !pat.trim()}
                      onClick={() =>
                        void run(async () => {
                          const token = pat.trim();
                          setPat("");
                          await change({ action: "pat", token });
                          if (current()) setPatOpen(false);
                        })
                      }
                    >
                      Save token
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setPat("");
                        setPatOpen(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        openUrl(
                          "https://github.com/settings/personal-access-tokens/new",
                        )
                      }
                    >
                      Create token
                      <ExternalLink className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-fg2 text-xs">
        Only repositories allowed by your GitHub account and the selected
        connection are available.
      </p>
    </SettingsSection>
  );
}
