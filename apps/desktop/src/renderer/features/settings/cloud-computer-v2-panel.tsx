import { useEffect, useMemo, useRef, useState } from "react";
import { Cloud, RefreshCw, X } from "lucide-react";
import {
  CloudComputerV2DraftInputSchema,
  type CloudComputerV2BuildError,
  type CloudComputerV2BuildSummary,
  type CloudComputerV2DraftInput,
  type CloudComputerV2State,
} from "@zeros/protocol/cloud-computer-v2";
import { Button, Input } from "../../shared/ui";
import { CodeTextarea } from "../../shared/ui/primitives";
import { useCachedRead } from "../../state/use-cached-read";
import {
  getOrganizationStoreGeneration,
  useActiveOrganization,
  useTeams,
} from "../team/team-store";
import { ControlPlaneError } from "../team/control-plane";
import { SettingsSection, SettingsList, SettingsRow } from "./settings-ui";
import { useInternalFeatureActive } from "./internal-features";
import { CloudRepositoryPicker } from "./cloud-repository-picker";
import {
  activateCloudComputerV2,
  buildCloudComputerV2,
  cancelCloudComputerV2Build,
  cloudComputerV2BuildCache,
  cloudComputerV2BuildKey,
  cloudComputerV2Cache,
  cloudComputerV2Key,
  cloudComputerV2MaxAgeMs,
  discardCloudComputerV2,
  loadCloudComputerV2,
  loadCloudComputerV2Build,
  loadCloudComputerV2Logs,
  readCloudComputerV2,
  rebuildCloudComputerV2,
  refreshCloudComputerV2,
  saveCloudComputerV2Draft,
} from "./cloud-computer-v2-client";
import {
  acceptCloudComputerV2EditorRevision,
  acceptCloudComputerV2EditorSave,
  acceptCloudComputerV2EditorDiscard,
  cloudComputerV2EditorDirty,
  editCloudComputerV2Environment,
  newCloudComputerV2Editor,
  reconcileCloudComputerV2Editor,
} from "./cloud-computer-v2-editor";
import { CloudComputerV2Environment } from "./cloud-computer-v2-environment";
import {
  CloudComputerV2Log,
  cloudComputerV2Stages,
} from "./cloud-computer-v2-log";
import { CloudComputerV2History } from "./cloud-computer-v2-history";
import {
  startCloudComputerV2Polling,
  useCloudComputerV2Visible,
} from "./cloud-computer-v2-polling";

const pendingBuild = (build: CloudComputerV2BuildSummary | null) =>
  build?.state === "queued" || build?.state === "running";
const buildFailureMessages: Record<CloudComputerV2BuildError, string> = {
  allocation_failed: "The build computer could not be allocated.",
  runtime_unavailable: "The required Zeros runtime is unavailable.",
  runtime_install_failed: "Zeros runtime installation failed.",
  repository_access_denied:
    "Repository access was denied. Review the organization’s repository connections.",
  repository_clone_failed: "A repository could not be cloned.",
  install_failed: "The install script failed. Review its build log.",
  integrity_failed: "Protected file verification failed.",
  tcb_modified: "The install script changed protected system files.",
  sanitation_failed: "Build credential cleanup failed.",
  template_stop_failed: "The template could not be stopped safely.",
  template_capture_failed: "The template could not be captured.",
  build_timeout: "The build timed out.",
  build_failed: "The build failed. Review its build log.",
};
export function CloudComputerV2Panel({
  surfaceActive = true,
}: {
  surfaceActive?: boolean;
}) {
  const authorized = useInternalFeatureActive("cloudComputerV2");
  const organization = useActiveOrganization();
  const { me } = useTeams();
  if (!authorized || !organization || organization.isPersonal || !me)
    return null;
  const key = cloudComputerV2Key(me.user.id, organization.id);
  return (
    <CloudComputerV2Scope
      key={key}
      scopeKey={key}
      userId={me.user.id}
      organizationId={organization.id}
      organizationCanManage={
        organization.role === "owner" || organization.role === "admin"
      }
      active={surfaceActive}
    />
  );
}

function CloudComputerV2Scope({
  scopeKey,
  userId,
  organizationId,
  organizationCanManage,
  active,
}: {
  scopeKey: string;
  userId: string;
  organizationId: string;
  organizationCanManage: boolean;
  active: boolean;
}) {
  const visible = useCloudComputerV2Visible(active);
  const snapshot = useCachedRead(
    cloudComputerV2Cache,
    scopeKey,
    readCloudComputerV2,
    { enabled: visible, maxAgeMs: cloudComputerV2MaxAgeMs },
  );
  const building = pendingBuild(snapshot.data?.latestBuild ?? null);
  const loaded = Boolean(snapshot.data);
  useEffect(() => {
    if (!visible || !loaded) return;
    return startCloudComputerV2Polling({
      intervalMs: building ? 3000 : 30_000,
      maxIntervalMs: building ? 3000 : 30_000,
      immediate: false,
      read: async () => {
        await loadCloudComputerV2(scopeKey, { force: true });
        return { idle: false, complete: false };
      },
    });
  }, [visible, building, scopeKey, loaded]);
  return (
    <div
      className="flex flex-col gap-6"
      {...(!active ? { inert: "" } : {})}
      aria-hidden={!active || undefined}
    >
      {snapshot.error && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-error text-xs" role="alert">
            Cloud Computer could not be refreshed. Your edits and confirmed
            state are preserved.
          </p>
          <Button variant="ghost" disabled={!active} onClick={snapshot.refresh}>
            Retry
          </Button>
        </div>
      )}
      {snapshot.data ? (
        <CloudComputerV2Form
          scopeKey={scopeKey}
          userId={userId}
          organizationId={organizationId}
          organizationCanManage={organizationCanManage}
          snapshot={snapshot.data}
          active={visible}
          refreshing={snapshot.refreshing}
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

function CloudComputerV2Form({
  scopeKey,
  userId,
  organizationId,
  organizationCanManage,
  snapshot,
  active,
  refreshing,
}: {
  scopeKey: string;
  userId: string;
  organizationId: string;
  organizationCanManage: boolean;
  snapshot: CloudComputerV2State;
  active: boolean;
  refreshing: boolean;
}) {
  const discardEdits = useRef<
    Partial<Pick<CloudComputerV2DraftInput, "installScript" | "timeoutSeconds">>
    | null
  >(null);
  const [editor, setEditor] = useState(() =>
    newCloudComputerV2Editor(snapshot),
  );
  const reconciled = discardEdits.current
    ? editor
    : reconcileCloudComputerV2Editor(editor, snapshot);
  if (reconciled !== editor) setEditor(reconciled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState(false);
  const [secretEditorRevision, setSecretEditorRevision] = useState(0);
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0);
  const [selectedBuild, setSelectedBuild] =
    useState<CloudComputerV2BuildSummary | null>(null);
  const [observedLog, setObservedLog] = useState(() => ({
    build: pendingBuild(snapshot.latestBuild) ? snapshot.latestBuild : null,
    closed: false,
  }));
  if (
    pendingBuild(snapshot.latestBuild) &&
    observedLog.build?.id !== snapshot.latestBuild?.id
  ) {
    setObservedLog({ build: snapshot.latestBuild, closed: false });
  }
  const mounted = useRef(true),
    pending = useRef(false);
  const visibleRef = useRef(active);
  visibleRef.current = active;
  const operationIntent = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationIntent.current = null;
    };
  }, []);
  const canManage = organizationCanManage && snapshot.canManage;
  useEffect(() => {
    if (canManage) return;
    setEditor((current) => ({
      ...current,
      document: { ...current.document, environment: undefined },
    }));
    setSecretEditorRevision((value) => value + 1);
    operationIntent.current = null;
  }, [canManage]);
  const dirty = cloudComputerV2EditorDirty(editor);
  const stale = conflict || editor.revision < snapshot.revision;
  const running = pendingBuild(snapshot.latestBuild)
    ? snapshot.latestBuild
    : null;
  const editable = active && canManage;
  const valid = CloudComputerV2DraftInputSchema.safeParse(
    editor.document,
  ).success;
  const canMutate =
    editable && !busy && !stale && editor.revision === snapshot.revision;
  const update = (change: Partial<CloudComputerV2DraftInput>) => {
    if (discardEdits.current) {
      if (change.installScript !== undefined)
        discardEdits.current.installScript = change.installScript;
      if (change.timeoutSeconds !== undefined)
        discardEdits.current.timeoutSeconds = change.timeoutSeconds;
    }
    setEditor((current) => ({
      ...current,
      document: { ...current.document, ...change },
    }));
  };
  const selectedRepositories = useMemo(
    () =>
      editor.document.repositories.map((repo) => ({
        ...repo,
        defaultBranch: "main",
        private: true,
      })),
    [editor.document.repositories],
  );
  const run = async (
    action: () => Promise<{ revision: number } | void>,
    revalidate = true,
  ) => {
    if (!editable || pending.current) return;
    const epoch = getOrganizationStoreGeneration();
    const current = () =>
      mounted.current && epoch === getOrganizationStoreGeneration();
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (current() && revalidate) {
        const confirmed = await loadCloudComputerV2(scopeKey);
        if (result && current())
          setEditor((editor) =>
            acceptCloudComputerV2EditorRevision(
              editor,
              confirmed,
              result.revision,
            ),
          );
      }
    } catch (failure) {
      if (!current()) return;
      if (failure instanceof ControlPlaneError && failure.status === 409) {
        setConflict(true);
        setReview(false);
        operationIntent.current = null;
        // The server's current revision is reviewable; keep the local buffer.
        if (visibleRef.current)
          void refreshCloudComputerV2(scopeKey).catch(() => {});
        else cloudComputerV2Cache.invalidate(scopeKey);
        return "conflict" as const;
      } else
        setError(
          "Cloud Computer could not be updated. Your edits are preserved. Try again.",
        );
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  };
  const intent = (kind: string, input: unknown) => {
    const fingerprint = JSON.stringify([kind, editor.revision, input]);
    if (operationIntent.current?.fingerprint !== fingerprint)
      operationIntent.current = { fingerprint, id: crypto.randomUUID() };
    return operationIntent.current.id;
  };
  const save = () =>
    run(async () => {
      const submitted = editor,
        epoch = getOrganizationStoreGeneration();
      const result = await saveCloudComputerV2Draft(
        scopeKey,
        submitted.revision,
        submitted.document,
      );
      if (!mounted.current || epoch !== getOrganizationStoreGeneration())
        return;
      setEditor((current) =>
        acceptCloudComputerV2EditorSave(current, submitted, result),
      );
      setSecretEditorRevision((value) => value + 1);
      operationIntent.current = null;
    });
  const build = () =>
    run(async () => {
      const submitted = editor,
        epoch = getOrganizationStoreGeneration();
      const result = await buildCloudComputerV2(
        scopeKey,
        submitted.revision,
        intent("build", submitted.document),
        submitted.document,
      );
      if (!mounted.current || epoch !== getOrganizationStoreGeneration())
        return;
      setEditor((current) =>
        acceptCloudComputerV2EditorSave(current, submitted, {
          revision: result.revision,
          configId: result.build.configId,
        }),
      );
      setSecretEditorRevision((value) => value + 1);
      setObservedLog({ build: result.build, closed: false });
      setSelectedBuild(null);
      operationIntent.current = null;
    });
  const discard = () =>
    run(async () => {
      const submitted = editor,
        epoch = getOrganizationStoreGeneration();
      // Keep automatic reconciliation fenced until the confirmed merge is queued.
      discardEdits.current = {};
      const edits = discardEdits.current;
      try {
        const result = await discardCloudComputerV2(
          scopeKey,
          submitted.revision,
        );
        const confirmed = await loadCloudComputerV2(scopeKey);
        if (
          mounted.current &&
          epoch === getOrganizationStoreGeneration() &&
          confirmed.revision >= result.revision
        ) {
          setEditor((current) =>
            acceptCloudComputerV2EditorDiscard(
              current,
              submitted,
              confirmed,
              edits,
            ),
          );
          setSecretEditorRevision((value) => value + 1);
          operationIntent.current = null;
        }
      } finally {
        discardEdits.current = null;
      }
    }, false);
  const logBuild =
    selectedBuild ?? (observedLog.closed ? null : observedLog.build);
  const warmLog = (row: CloudComputerV2BuildSummary) => {
    if (!active) return;
    const key = cloudComputerV2BuildKey(userId, organizationId, row.id);
    void loadCloudComputerV2Build(key).catch(() => {});
    void loadCloudComputerV2Logs(key).catch(() => {});
  };
  return (
    <>
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            <Cloud className="size-4" />
            Cloud Computer
          </span>
        }
        description="Build a versioned computer for this organization’s cloud workspaces. Successful builds activate automatically."
        action={
          <Button
            variant="ghost"
            aria-label="Refresh Cloud Computer"
            disabled={!active || busy}
            onClick={() => {
              const epoch = getOrganizationStoreGeneration();
              void refreshCloudComputerV2(scopeKey)
                .then(() => {
                  if (
                    mounted.current &&
                    epoch === getOrganizationStoreGeneration()
                  )
                    setHistoryRefreshVersion((value) => value + 1);
                })
                .catch(() => {});
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        }
      >
        <SettingsList>
          <SettingsRow
            label={
              snapshot.active
                ? `Active v${snapshot.active.version}`
                : "Not built yet"
            }
            hint={
              snapshot.active
                ? `Built ${new Date(snapshot.active.completedAt ?? snapshot.active.createdAt).toLocaleString()}. New workspaces use this version.`
                : "Build computer to create your first cloud workspace."
            }
          >
            <Button
              disabled={!canMutate || !valid || Boolean(running)}
              onClick={() => void build()}
            >
              Build computer
            </Button>
          </SettingsRow>
        </SettingsList>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled>
            Configure with an agent
          </Button>
          <span className="text-fg3 text-xs">Coming soon</span>
        </div>
        {snapshot.unbuiltChanges && (
          <div
            className="bg-bg2 flex items-center justify-between gap-3 rounded-md p-3"
            role="status"
          >
            <span className="text-fg1 text-xs">Unbuilt changes</span>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                disabled={!canMutate}
                onClick={() => void discard()}
              >
                Discard
              </Button>
              <Button
                disabled={!canMutate || !valid || Boolean(running)}
                onClick={() => void build()}
              >
                Build computer
              </Button>
            </div>
          </div>
        )}
        {running && (
          <div
            className="flex items-center justify-between gap-3"
            role="status"
          >
            <span className="text-fg2 text-xs">
              Building v{running.version} ·{" "}
              {cloudComputerV2Stages[running.stage]} · Step{" "}
              {Object.keys(cloudComputerV2Stages).indexOf(running.stage) + 1} of
              9{running.cancelRequestedAt ? " · Cancellation requested" : ""}
            </span>
            <Button
              variant="secondary"
              disabled={!canMutate || Boolean(running.cancelRequestedAt)}
              onClick={() =>
                void run(() =>
                  cancelCloudComputerV2Build(
                    scopeKey,
                    snapshot.revision,
                    running.id,
                  ),
                )
              }
            >
              Cancel build
            </Button>
          </div>
        )}
        {snapshot.latestBuild &&
          ["failed", "cancelled", "superseded"].includes(
            snapshot.latestBuild.state,
          ) && (
            <p className="text-fg2 text-xs" role="status">
              Version {snapshot.latestBuild.version} ·{" "}
              {snapshot.latestBuild.state}
              {snapshot.latestBuild.errorCode
                ? ` · ${cloudComputerV2Stages[snapshot.latestBuild.stage]}`
                : ""}
              .{" "}
              {snapshot.latestBuild.errorCode &&
                `${buildFailureMessages[snapshot.latestBuild.errorCode]} `}
              {snapshot.active
                ? "The active computer is still available."
                : "Build computer to try again."}
            </p>
          )}
        {error && (
          <p className="text-error text-xs" role="alert">
            {error}
          </p>
        )}
        {stale && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-fg2 text-xs" role="alert">
              Changed by someone else — Review
            </p>
            <Button
              variant="secondary"
              disabled={!active || busy}
              onClick={() => setReview(true)}
            >
              Review
            </Button>
          </div>
        )}
        {review && stale && (
          <div className="bg-bg2 flex flex-col gap-3 rounded-md p-3">
            <p className="text-fg2 text-xs">
              Saved draft · revision {snapshot.revision}. Your edits are
              preserved. Compare the saved script and repository list before
              continuing.
            </p>
            <p className="text-fg2 text-xs">
              Repositories:{" "}
              {snapshot.draft.repositories
                .map((row) => `${row.owner}/${row.name}`)
                .join(", ") || "None"}
            </p>
            <p className="text-fg2 text-xs">
              Environment:{" "}
              {snapshot.draft.environment
                .map((row) => `${row.name} (${row.set ? "set" : "not set"})`)
                .join(", ") || "None"}
            </p>
            <pre className="text-fg2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap">
              {snapshot.draft.installScript || "No install script"}
            </pre>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={!editable || refreshing || busy}
                onClick={() => {
                  setEditor((current) => ({
                    ...current,
                    revision: snapshot.revision,
                    base: snapshot.draft,
                  }));
                  setConflict(false);
                  setReview(false);
                }}
              >
                Keep my edits
              </Button>
              <Button
                variant="ghost"
                disabled={!editable || refreshing || busy}
                onClick={() => {
                  setEditor(newCloudComputerV2Editor(snapshot));
                  setConflict(false);
                  setReview(false);
                  setSecretEditorRevision((value) => value + 1);
                }}
              >
                Use saved draft
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
      <SettingsSection
        title="Repositories"
        description="Every selected repository is shared with the organization and present in every member’s workspace, including members without their own GitHub access. For Alpha, Files and checkpoints cover only the primary repository."
      >
        <CloudRepositoryPicker
          userId={userId}
          organizationId={organizationId}
          active={active}
          multiple
          disabled={!editable || busy}
          value={selectedRepositories}
          onChange={(rows) => {
            if (rows.length > 20) {
              setError("Select up to 20 repositories.");
              return;
            }
            const existing = new Map(
              editor.document.repositories.map((repo) => [repo.id, repo]),
            );
            update({
              repositories: rows.map(
                (row) =>
                  existing.get(row.id) ?? {
                    id: row.id,
                    owner: row.owner,
                    name: row.name,
                    installationId: row.installationId,
                    requestedRef: null,
                  },
              ),
            });
          }}
        />
        <div className="flex flex-wrap gap-2">
          {editor.document.repositories.map((repo) => (
            <span
              key={repo.id}
              className="bg-bg2 text-fg1 flex items-center gap-1 rounded-sm px-2 py-1 text-xs"
            >
              {repo.owner}/{repo.name}
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={!editable || busy}
                aria-label={`Remove ${repo.owner}/${repo.name}`}
                onClick={() =>
                  update({
                    repositories: editor.document.repositories.filter(
                      (row) => row.id !== repo.id,
                    ),
                  })
                }
              >
                <X className="size-3" />
              </Button>
            </span>
          ))}
        </div>
      </SettingsSection>
      <CloudComputerV2Environment
        key={secretEditorRevision}
        editor={editor}
        editable={editable && !busy}
        onChange={(operation) =>
          setEditor((current) =>
            editCloudComputerV2Environment(current, operation),
          )
        }
      />
      <SettingsSection
        title="Install script"
        description="Runs with root privileges in a fresh build. Organization admins are trusted with this access. Protected Zeros files are checked before activation."
      >
        <CodeTextarea
          readOnly={!editable}
          offscreen={!active}
          value={editor.document.installScript}
          onChange={
            editable ? (value) => update({ installScript: value }) : undefined
          }
          aria-label="Cloud Computer install script"
          description="Install script"
        />
        <SettingsRow label="Build timeout" hint="Maximum 900 seconds.">
          <Input
            type="number"
            min={1}
            max={900}
            className="w-24"
            aria-label="Cloud Computer build timeout"
            disabled={!editable}
            value={editor.document.timeoutSeconds}
            onChange={(event) =>
              update({ timeoutSeconds: Number(event.target.value) })
            }
          />
        </SettingsRow>
        {!valid && (
          <p className="text-error text-xs" role="alert">
            Check the draft. Scripts must be at most 16 KiB and the timeout must
            be between 1 and 900 seconds.
          </p>
        )}
        {canManage && (
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={!editable || busy || !dirty}
              onClick={() => {
                setEditor(newCloudComputerV2Editor(snapshot));
                setConflict(false);
                setReview(false);
                setSecretEditorRevision((value) => value + 1);
              }}
            >
              Discard local edits
            </Button>
            <Button
              variant="secondary"
              disabled={!canMutate || !valid || !dirty}
              onClick={() => void save()}
            >
              Save draft
            </Button>
          </div>
        )}
      </SettingsSection>
      <CloudComputerV2History
        scopeKey={scopeKey}
        snapshot={snapshot}
        active={active}
        refreshVersion={historyRefreshVersion}
        disabled={!canMutate || Boolean(running)}
        onWarmLog={warmLog}
        onOpenLog={setSelectedBuild}
        onAction={async (kind, row) => {
          const epoch = getOrganizationStoreGeneration();
          const outcome = await run(async () => {
            const action =
              kind === "activate"
                ? activateCloudComputerV2
                : rebuildCloudComputerV2;
            const result = await action(
              scopeKey,
              snapshot.revision,
              row.version,
              intent(kind, row.id),
            );
            operationIntent.current = null;
            return kind === "activate" ? result : undefined;
          });
          if (
            outcome === "conflict" &&
            mounted.current &&
            epoch === getOrganizationStoreGeneration()
          ) {
            if (!visibleRef.current) {
              // History consumes the pending refresh only when this scope returns.
              setHistoryRefreshVersion((value) => value + 1);
              return;
            }
            const buildKey = cloudComputerV2BuildKey(
              userId,
              organizationId,
              row.id,
            );
            cloudComputerV2BuildCache.invalidate(buildKey);
            return loadCloudComputerV2Build(buildKey, { force: true });
          }
        }}
      />
      {logBuild && (
        <SettingsSection
          title={`Version ${logBuild.version} log`}
          action={
            <Button
              variant="ghost"
              disabled={!active}
              onClick={() => {
                setSelectedBuild(null);
                setObservedLog((current) => ({ ...current, closed: true }));
              }}
            >
              Close log
            </Button>
          }
        >
          <CloudComputerV2Log
            key={logBuild.id}
            buildKey={cloudComputerV2BuildKey(
              userId,
              organizationId,
              logBuild.id,
            )}
            version={logBuild.version}
            active={active}
          />
        </SettingsSection>
      )}
    </>
  );
}
