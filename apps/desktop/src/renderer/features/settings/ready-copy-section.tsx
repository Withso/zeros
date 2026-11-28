import { useEffect, useState } from "react";
import { Button } from "../../shared/ui";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../shared/ui/primitives/sheet";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useDocumentActive } from "../../state/use-document-active";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { CONTROL_PLANE_URL, ControlPlaneError } from "../team/control-plane";
import { getOrganizationStoreGeneration } from "../team/team-store";
import { buildCloudReadyCopy, getCloudReadyCopy, getCloudReadyCopyOutput, type CloudReadyCopy } from "../../platform/cloud-github-levels";
import { message } from "./cloud-computer-store";
import { relativeAge } from "./cloud-computer-model";
import { BuildHistoryItem } from "./build-history";
import { readyCopyBaseLine, readyCopyFailureLine, readyCopySubmodulesLine, readyCopyTriggerLabel } from "./ready-copy-copy";
import { SettingsGroup, SettingsRow } from "./settings-ui";

/** Null: no ready copies here (setting off, older control plane, or not visible to this reader). */
export const readyCopyCache = new KeyedAsyncCache<CloudReadyCopy | null>({ maxEntries: 32 });
/** The server decides per person who may see a ready copy; the organization
 * store generation changes with the account, so one never paints another's. */
export const readyCopyKey = (organizationId: string, projectId: string) =>
  JSON.stringify([CONTROL_PLANE_URL, getOrganizationStoreGeneration(), organizationId, projectId]);
const absent = (error: unknown) => { if (error instanceof ControlPlaneError && error.status === 404) return null; throw error; };
const later = (iso: string | null, now: number) => {
  if (!iso) return null;
  const days = Math.round((Date.parse(iso) - now) / 86_400_000);
  return days <= 0 ? "soon" : days === 1 ? "in 1 day" : `in ${days} days`;
};

/** The status in words: the label is the status itself, the hint its detail.
 * Members get it without any failure (the server never sends one). */
export function readyCopyStatus(status: CloudReadyCopy["status"], now: number): { label: string; hint: string | null } | null {
  const updated = relativeAge(status.updatedAt, now), next = later(status.nextUpdateAt, now);
  switch (status.state) {
    case "ready": return { label: "Ready", hint: [updated && `Updated ${updated}`, next && `next update ${next}`].filter(Boolean).join(" · ") || null };
    case "updating": return { label: "Updating…", hint: "New workspaces use the last build until this one is ready." };
    case "getting_ready": return { label: "Getting ready…", hint: "New workspaces clone directly until the first build is ready." };
    case "update_failed": return { label: "Update failed", hint: `New workspaces still use the build from ${updated ?? "before"}.` };
    case "failed": return { label: "Update failed", hint: "New workspaces clone directly until a build succeeds." };
    default: return null;
  }
}

/** How often an open project page reads its build again while one is in progress. */
export const READY_COPY_PROGRESS_MS = 5_000;
/** A build is under way: getting ready or updating, a generation still building, or the organization's Cloud Computer
 * still being prepared for it. Ready and failed end it. */
export function readyCopyInProgress(copy: Pick<CloudReadyCopy, "status" | "history" | "base">): boolean {
  return copy.status.state === "getting_ready" || copy.status.state === "updating"
    || !!copy.history?.some(build => build.state === "building") || copy.base?.state === "preparing";
}

const RESULT = { building: "building", ready: "succeeded", retired: "succeeded", failed: "failed" } as const;
const duration = (start: string | null, end: string | null) => {
  if (!start || !end) return null;
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
};

/** A project's ready copy on its project page, for whoever the server lets see it. */
export function ReadyCopySection({ organizationId, projectId, active }: { organizationId: string; projectId: string; active: boolean }) {
  const key = readyCopyKey(organizationId, projectId);
  const read = useRecoveringRead(readyCopyCache, key, () => getCloudReadyCopy(organizationId, projectId).catch(absent), { enabled: active, maxAgeMs: 30_000 });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<{ generation: number; text: string } | null>(null);
  const copy = read.data;
  // While a build is under way, an open, visible page reads it again (keeping what it shows until the reply), so a
  // person watching sees it become Ready; nothing reads on a hidden or retained page, and ready or failed ends it.
  const visible = useDocumentActive(active);
  const inProgress = !!copy && readyCopyInProgress(copy);
  const refresh = read.refresh;
  useEffect(() => {
    if (!visible || !inProgress) return;
    const timer = setInterval(refresh, READY_COPY_PROGRESS_MS);
    return () => clearInterval(timer);
  }, [visible, inProgress, refresh]);
  if (!copy) return null;
  const now = Date.now(), status = readyCopyStatus(copy.status, now), failure = copy.status.failure;
  const build = async () => {
    setBusy(true); setError(null);
    try { await buildCloudReadyCopy(organizationId, projectId); read.refresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const show = async (generation: number) => {
    try { setOutput({ generation, text: await getCloudReadyCopyOutput(organizationId, projectId, generation) }); } catch (cause) { setError(message(cause)); }
  };
  if (!status && !copy.history?.length) {
    if (!copy.base) return null;
    const waiting = readyCopyBaseLine(copy.base, now);
    return <SettingsGroup><SettingsRow label={waiting.label} hint={waiting.hint} /></SettingsGroup>;
  }
  return (
    <SettingsGroup>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      <SettingsRow label={status?.label ?? "Not built yet"} hint={[status?.hint, failure && readyCopyFailureLine(failure, now)].filter(Boolean).join(" ") || null}>
        {copy.canBuild && (
          <Button variant="secondary" disabled={busy || copy.status.state === "updating" || copy.status.state === "getting_ready"}
            onClick={() => void build()}>{failure ? "Retry now" : "Build now"}</Button>
        )}
      </SettingsRow>
      {copy.history && copy.history.length > 0 && (
        <ul className="divide-border1 m-0 flex list-none flex-col divide-y p-0" aria-label="Builds">
          {copy.history.map(row => (
            <BuildHistoryItem key={row.generation} state={RESULT[row.state]} title={`Build #${row.generation}`}
              // Why it ran first, then when and how long.
              details={[readyCopyTriggerLabel(row.trigger, row.startedBy, row.triggerDetail), relativeAge(row.startedAt, now), duration(row.startedAt, row.finishedAt),
                row.failure ? readyCopyFailureLine({ ...row.failure, nextRetryAt: null }, now).split(".")[0]! : null,
                ...(row.repositories ?? []).flatMap(entry => [entry.branch && entry.commit
                  ? `${row.repositories!.length > 1 ? `${entry.repository} ` : ""}${entry.branch} @ ${entry.commit.slice(0, 7)}` : null,
                  readyCopySubmodulesLine(entry.submoduleCounts, row.repositories!.length > 1 ? entry.repository : undefined)])]}
              // Only a failed build keeps its setup output.
              action={row.state === "failed" && row.output ? <Button variant="ghost" size="compact" onClick={() => void show(row.generation)}>Output</Button> : undefined} />
          ))}
        </ul>
      )}
      <Sheet open={!!output} onOpenChange={value => { if (!value) setOutput(null); }}>
        <SheetContent side="right" className="p-6">
          <SheetHeader>
            <SheetTitle>{`Build #${output?.generation ?? ""} setup output`}</SheetTitle>
            <SheetDescription>The last part of the setup's output. Build secrets are shown as [redacted].</SheetDescription>
          </SheetHeader>
          <pre className="text-fg2 m-0 overflow-auto text-xs whitespace-pre-wrap">{output?.text}</pre>
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
