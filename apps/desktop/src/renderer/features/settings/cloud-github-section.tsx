import { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button, GithubIcon } from "../../shared/ui";
import { SettingsSection, SettingsList, SettingsRow } from "./settings-ui";
import { ghAppConnect, onGithubAppConnected } from "../../platform/git";
import { shellOpenUrl } from "../../platform/app";
import { useCachedRead } from "../../state/use-cached-read";
import {
  cloudGithubCatalogCache,
  cloudGithubRepositoriesCache,
  cloudGithubScopeKey,
  connectCloudGithub,
  disconnectCloudGithub,
  readCloudGithubCatalog,
} from "../../platform/cloud-github";

export function CloudGithubSection({
  userId,
  organizationId,
  surfaceActive,
}: {
  userId: string;
  organizationId: string;
  surfaceActive: boolean;
}) {
  const key = cloudGithubScopeKey(userId, organizationId);
  const snapshot = useCachedRead(
    cloudGithubCatalogCache,
    key,
    (value) =>
      readCloudGithubCatalog((JSON.parse(value) as [string, string])[1]),
    { enabled: surfaceActive, maxAgeMs: 60_000 },
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const mounted = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!surfaceActive) return;
    let alive = true,
      unlisten: (() => void) | undefined;
    void onGithubAppConnected(() => {
      if (alive) cloudGithubCatalogCache.invalidate(key);
    })
      .then((off) => {
        if (alive) unlisten = off;
        else off();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [key, surfaceActive]);
  const run = async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (mounted.current) cloudGithubCatalogCache.invalidate(key);
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : "GitHub connection failed. Try again.",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const refresh = () => {
    setError(null);
    snapshot.refresh();
  };
  return (
    <SettingsSection
      title="GitHub"
      description="Connect your GitHub account and organizations to choose repositories for cloud workspaces."
      action={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            aria-label="Refresh GitHub organizations"
            disabled={busy || snapshot.refreshing}
            onClick={refresh}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          {snapshot.data ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(() => shellOpenUrl(snapshot.data!.installUrl))
              }
            >
              Add GitHub account or organization
              <ExternalLink className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  ghAppConnect({
                    installFlow: false,
                    preserveSelectedMethod: true,
                  }),
                )
              }
            >
              Connect GitHub
            </Button>
          )}
        </div>
      }
    >
      {(error || snapshot.error) && (
        <p className="text-red-primary text-xs" role="alert">
          {error ?? snapshot.error?.message}
        </p>
      )}
      {snapshot.data && (
        <>
          <p className="text-fg2 text-xs">
            Linked as {snapshot.data.login}. Install the App in GitHub, then
            refresh this list. Only repositories you can access will be
            available.
          </p>
          <SettingsList>
            {snapshot.data.installations.map((installation) => (
              <SettingsRow
                key={installation.id}
                label={
                  <span className="flex items-center gap-2">
                    <GithubIcon className="size-4" />
                    {installation.accountLogin}
                  </span>
                }
                hint={
                  installation.suspendedAt
                    ? "Suspended in GitHub"
                    : `${installation.accountType === "Organization" ? "Organization" : "Personal GitHub account"} · ${installation.connected ? "Connected" : "Available"}`
                }
              >
                <Button
                  variant="secondary"
                  disabled={busy || Boolean(installation.suspendedAt)}
                  onClick={() =>
                    void run(async () => {
                      if (installation.connected)
                        await disconnectCloudGithub(
                          organizationId,
                          installation.id,
                        );
                      else
                        await connectCloudGithub(
                          organizationId,
                          installation.id,
                        );
                      for (const cached of cloudGithubRepositoriesCache.keys()) {
                        const scope = JSON.parse(cached) as string[];
                        if (
                          scope[0] === userId &&
                          scope[1] === organizationId &&
                          scope[2] === installation.id
                        )
                          cloudGithubRepositoriesCache.forget(cached);
                      }
                    })
                  }
                >
                  {installation.connected ? "Disconnect" : "Connect"}
                </Button>
              </SettingsRow>
            ))}
          </SettingsList>
          {!snapshot.data.installations.length && (
            <p className="text-fg2 text-xs">
              Install the Zeros GitHub App on your account or organization to
              add repositories.
            </p>
          )}
          {!snapshot.data.complete && (
            <p className="text-fg2 text-xs" role="status">
              GitHub returned a partial installation list. Refresh to load the
              remaining connections.
            </p>
          )}
        </>
      )}
    </SettingsSection>
  );
}
