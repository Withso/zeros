import { useEffect, useRef, useState } from "react";
import { Cloud, RefreshCw, X } from "lucide-react";
import { Button, Input } from "../../shared/ui";
import { CodeTextarea } from "../../shared/ui/primitives";
import { SettingsSection, SettingsRow, SettingsList } from "./settings-ui";
import {
  getOrganizationStoreGeneration,
  useActiveOrganization,
  useTeams,
} from "../team/team-store";
import { useCachedRead } from "../../state/use-cached-read";
import { CloudRepositoryPicker } from "./cloud-repository-picker";
import { cloudGithubScopeKey } from "../../platform/cloud-github";
import { useInternalFeatureActive } from "./internal-features";
import { CloudComputerV2Panel } from "./cloud-computer-v2-panel";
import {
  activateCloudComputer,
  rollbackCloudComputer,
  cloudComputerFailure,
  cloudComputerImageAge,
  buildCloudComputer,
  cancelCloudComputerBuild,
  cloudComputerCache,
  readCloudComputer,
  refreshCloudComputer,
  cloudComputerMaxAgeMs,
  saveCloudComputer,
  type CloudComputerRecipe,
  type CloudComputerSnapshot,
} from "./cloud-computer-client";

export function CloudComputerPanel({
  surfaceActive = true,
}: {
  surfaceActive?: boolean;
}) {
  const organization = useActiveOrganization(),
    { me } = useTeams();
  const v2 = useInternalFeatureActive("cloudComputerV2");
  if (v2) return <CloudComputerV2Panel surfaceActive={surfaceActive} />;
  return organization && !organization.isPersonal && me ? (
    <CloudComputerScope
      key={cloudGithubScopeKey(me.user.id, organization.id)}
      userId={me.user.id}
      organizationId={organization.id}
      active={surfaceActive}
    />
  ) : null;
}
function CloudComputerScope({
  userId,
  organizationId,
  active,
}: {
  userId: string;
  organizationId: string;
  active: boolean;
}) {
  const key = cloudGithubScopeKey(userId, organizationId);
  const snapshot = useCachedRead(
    cloudComputerCache,
    key,
    (key) => readCloudComputer((JSON.parse(key) as string[])[1]!),
    { enabled: active, maxAgeMs: cloudComputerMaxAgeMs },
  );
  const running =
    snapshot.data?.history.some(
      (build) =>
        build.state === "building" || build.cleanupState !== "complete",
    ) ?? false;
  useEffect(() => {
    if (!active || !running) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        // Polling joins the newest read; only explicit changes invalidate it.
        void cloudComputerCache.load(
          key,
          () => readCloudComputer(organizationId),
          { force: true },
        ).catch(() => { /* The shared snapshot exposes the read error. */ });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, key, organizationId, running]);
  return (
    <div className="flex flex-col gap-6">
      {snapshot.error && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-red-primary text-xs" role="alert">
            {snapshot.error.message}
          </p>
          <Button variant="ghost" onClick={snapshot.refresh}>
            Retry
          </Button>
        </div>
      )}
      {snapshot.data ? (
        <CloudComputerEditor
          userId={userId}
          organizationId={organizationId}
          snapshot={snapshot.data}
          active={active}
        />
      ) : (
        snapshot.loading && (
          <p className="text-fg2 text-xs" role="status">
            Loading Cloud Computer…
          </p>
        )
      )}
    </div>
  );
}
function CloudComputerEditor({
  userId,
  organizationId,
  snapshot,
  active,
}: {
  userId: string;
  organizationId: string;
  snapshot: CloudComputerSnapshot;
  active: boolean;
}) {
  const key = cloudGithubScopeKey(userId, organizationId);
  const [draft, setDraft] = useState(() => ({
    document: snapshot.document,
    revision: snapshot.revision,
  }));
  const [lastSaved, setLastSaved] = useState(() => ({
    document: JSON.stringify(snapshot.document),
    revision: snapshot.revision,
  }));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const pending = useRef(false),
    mounted = useRef(true),
    saveIntent = useRef<{
      document: string;
      revision: number;
      operationId: string;
    } | null>(null),
    buildIntent = useRef<{
      version: number;
      revision: number;
      id: string;
    } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (lastSaved.revision !== snapshot.revision) {
    const serialized = JSON.stringify(snapshot.document);
    setLastSaved({ document: serialized, revision: snapshot.revision });
    if (JSON.stringify(draft.document) === lastSaved.document)
      setDraft({ document: snapshot.document, revision: snapshot.revision });
  }
  const dirty =
      JSON.stringify(draft.document) !== JSON.stringify(snapshot.document),
    stale = draft.revision !== snapshot.revision;
  const running = snapshot.history.find((build) => build.state === "building");
  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    const epoch = getOrganizationStoreGeneration();
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (mounted.current && epoch === getOrganizationStoreGeneration())
        await refreshCloudComputer(key);
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : "Cloud Computer could not be updated. Try again.",
        );
      cloudComputerCache.invalidate(key);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const update = (next: Partial<CloudComputerRecipe>) =>
    setDraft((current) => ({
      ...current,
      document: { ...current.document, ...next },
    }));
  const save = () =>
    run(async () => {
      const document = JSON.stringify(draft.document);
      if (
        saveIntent.current?.document !== document ||
        saveIntent.current.revision !== draft.revision
      )
        saveIntent.current = {
          document,
          revision: draft.revision,
          operationId: crypto.randomUUID(),
        };
      const result = await saveCloudComputer(
        organizationId,
        draft.revision,
        saveIntent.current.operationId,
        draft.document,
      );
      if (mounted.current)
        setDraft({ document: draft.document, revision: result.revision });
      saveIntent.current = null;
    });
  const build = () =>
    run(async () => {
      if (
        buildIntent.current?.version !== snapshot.draftVersion ||
        buildIntent.current.revision !== snapshot.revision
      )
        buildIntent.current = {
          version: snapshot.draftVersion,
          revision: snapshot.revision,
          id: crypto.randomUUID(),
        };
      await buildCloudComputer(
        organizationId,
        snapshot.draftVersion,
        snapshot.revision,
        buildIntent.current.id,
      );
      buildIntent.current = null;
    });
  const editable = snapshot.canManage && !busy;
  // Installation UUIDs are private to the person selecting repositories. The
  // shared recipe contains only immutable repository identity and metadata.
  const selected = draft.document.repositories.map((repo) => ({
    ...repo,
    installationId: "",
  }));
  return (
    <>
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            <Cloud className="size-4" />
            Cloud Computer
          </span>
        }
        description="Build a reusable computer image for this organization’s cloud workspaces."
        action={
          <Button
            variant="ghost"
            aria-label="Refresh Cloud Computer"
            disabled={busy}
            onClick={() => void run(async () => {})}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        }
      >
        <p className="text-fg2 text-xs">
          {snapshot.resources.cpuMillicores / 1000} CPUs ·{" "}
          {(snapshot.resources.memoryMiB / 1024).toLocaleString()} GiB memory ·{" "}
          {(snapshot.resources.storageMiB / 1024).toLocaleString(undefined, {
            maximumFractionDigits: 1,
          })}{" "}
          GiB storage
        </p>
        <SettingsList>
          <SettingsRow
            label={
              snapshot.activeArtifactId
                ? `Active version ${snapshot.activeVersion}`
                : "No active configuration"
            }
            hint={
              snapshot.activeArtifactId
                ? "New workspaces clone this image. Existing workspaces keep their current image."
                : "Save and build a configuration, then activate a successful version."
            }
          >
            <Button
              variant="secondary"
              disabled={
                !editable ||
                !snapshot.configured || !snapshot.imageBuilds ||
                dirty ||
                stale ||
                !snapshot.draftVersion ||
                Boolean(running)
              }
              onClick={() => void build()}
            >
              {running ? "Building…" : "Build computer"}
            </Button>
          </SettingsRow>
        </SettingsList>
        {snapshot.activeArtifact && (
          <p className="text-fg2 break-all text-xs">
            {cloudComputerImageAge(snapshot.activeArtifact.createdAt)} · {snapshot.activeArtifact.imageRef}
          </p>
        )}
        {!snapshot.configured && (
          <p className="text-fg2 text-xs">
            Cloud Computer builds are unavailable until managed cloud setup is
            enabled for this environment.
          </p>
        )}
        {snapshot.previousArtifactId && snapshot.canManage && (
          <Button variant="secondary" disabled={busy} onClick={() => void run(async () => {
            await rollbackCloudComputer(organizationId, snapshot.revision, snapshot.previousArtifactId!);
          })}>Roll back to previous image</Button>
        )}
        <p className="text-fg2 text-xs">
          Builds install into $PREFIX (/usr/local/zeros-computer) without account credentials or repository access.
          Tools in $PREFIX/bin are available in new workspaces. System and runtime files are read-only.
          Each image is sanitized and checked on a fresh clone, then requires exact-image agent qualification before activation.
        </p>
        {error && (
          <p className="text-red-primary text-xs" role="alert">
            {error}
          </p>
        )}
      </SettingsSection>
      <SettingsSection
        title="Repositories"
        description="Select up to 20 repositories for this configuration. Each member must have their own GitHub access."
      >
        <CloudRepositoryPicker
          userId={userId}
          organizationId={organizationId}
          active={active}
          multiple
          disabled={!editable}
          value={selected}
          onChange={(rows) => {
            if (rows.length > 20) {
              setError("Select up to 20 repositories.");
              return;
            }
            update({
              repositories: rows.map(({ installationId: _, ...repo }) => repo),
            });
          }}
        />
        <div className="flex flex-wrap gap-2">
          {draft.document.repositories.map((repo) => (
            <span
              key={repo.id}
              className="bg-bg2 text-fg1 flex items-center gap-1 rounded-sm px-2 py-1 text-xs"
            >
              {repo.owner}/{repo.name}
              {editable && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${repo.owner}/${repo.name}`}
                  onClick={() =>
                    update({
                      repositories: draft.document.repositories.filter(
                        (row) => row.id !== repo.id,
                      ),
                    })
                  }
                >
                  <X className="size-3" />
                </Button>
              )}
            </span>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection
        title="Install software"
        description="Runs once in the image builder. Install software and files into $PREFIX."
      >
        <CodeTextarea
          readOnly={!editable}
          value={draft.document.installScript}
          onChange={
            editable ? (value) => update({ installScript: value }) : undefined
          }
          aria-label="Cloud Computer install script"
          description="Install script"
        />
        <SettingsRow label="Setup timeout" hint="Maximum 900 seconds.">
          <Input
            type="number"
            min={1}
            max={900}
            aria-label="Cloud Computer setup timeout"
            className="w-24"
            disabled={!editable}
            value={draft.document.timeoutSeconds}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value >= 1 && value <= 900)
                update({ timeoutSeconds: value });
            }}
          />
        </SettingsRow>
        {stale && dirty && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-fg2 text-xs">
              Configuration changed in another window. Your edits are preserved.
            </p>
            <Button
              variant="secondary"
              onClick={() =>
                setDraft({
                  document: snapshot.document,
                  revision: snapshot.revision,
                })
              }
            >
              Discard edits and reload
            </Button>
          </div>
        )}
        {snapshot.canManage && (
          <div className="flex justify-end">
            <Button
              disabled={
                !editable ||
                stale ||
                (!dirty && snapshot.draftVersion > 0) ||
                new TextEncoder().encode(draft.document.installScript).length >
                  16384
              }
              onClick={() => void save()}
            >
              Save configuration
            </Button>
          </div>
        )}
      </SettingsSection>
      {snapshot.history.length > 0 && (
        <SettingsSection title={`Build history (${snapshot.history.length})`}>
          <SettingsList>
            {snapshot.history.map((build) => (
              <SettingsRow
                key={build.id}
                label={`Version ${build.version} · ${build.state === "succeeded" ? "Attested" : build.state === "building" ? (build.artifact?.state ?? "Building") : build.state === "cancelled" ? "Cancelled" : "Failed"}`}
                hint={[
                  new Date(build.createdAt).toLocaleString(),
                  build.artifact ? cloudComputerImageAge(build.artifact.createdAt) : null,
                  build.artifact?.snapshotId ? `Snapshot ${build.artifact.snapshotId}` : null,
                  build.artifact?.buildSha256 ? `Build ${build.artifact.buildSha256.slice(0, 12)}` : null,
                  build.artifact ? `Image ${build.artifact.state}` : "Legacy workspace build",
                  build.cleanupState === "complete" ? "Builder deleted" : "Builder cleanup pending",
                  cloudComputerFailure(build.errorCode),
                ].filter(Boolean).join(" · ")}
              >
                {build.state === "building" && snapshot.canManage ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await cancelCloudComputerBuild(
                          organizationId,
                          build.id,
                        );
                      })
                    }
                  >
                    Cancel build
                  </Button>
                ) : build.state === "succeeded" && build.artifact?.state === "attested" && snapshot.canManage ? (
                  <Button
                    variant="secondary"
                    disabled={busy || snapshot.activeArtifactId === build.artifact?.id}
                    onClick={() =>
                      void run(async () => {
                        await activateCloudComputer(
                          organizationId,
                          snapshot.revision,
                          build.version,
                          build.artifact!.id,
                        );
                      })
                    }
                  >
                    {snapshot.activeArtifactId === build.artifact?.id
                      ? "Active"
                      : "Activate"}
                  </Button>
                ) : null}
              </SettingsRow>
            ))}
          </SettingsList>
        </SettingsSection>
      )}
    </>
  );
}
