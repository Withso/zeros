import { useState } from "react";
import { Button } from "../../shared/ui";
import { MessageRow } from "../../shared/ui/primitives/message-row";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../shared/ui/primitives/sheet";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { ControlPlaneError } from "../team/control-plane";
import { buildCloudReadyCopy, getCloudReadyCopy, getCloudReadyCopyOutput, type CloudReadyCopy } from "../../platform/cloud-github-levels";
import { message } from "./cloud-computer-store";
import { relativeAge } from "./cloud-computer-model";
import { BuildHistoryItem } from "./build-history";
import { readyCopyFailureLine, readyCopyTriggerLabel } from "./ready-copy-copy";
import { SettingsGroup, SettingsRow } from "./settings-ui";

/** Null: no ready copies here (setting off, older control plane, or not visible to this reader). */
export const readyCopyCache = new KeyedAsyncCache<CloudReadyCopy | null>({ maxEntries: 32 });
const absent = (error: unknown) => { if (error instanceof ControlPlaneError && error.status === 404) return null; throw error; };
const later = (iso: string | null, now: number) => {
  if (!iso) return null;
  const days = Math.round((Date.parse(iso) - now) / 86_400_000);
  return days <= 0 ? "soon" : days === 1 ? "in 1 day" : `in ${days} days`;
};

/** The status line in words. Members get it without any failure (the server never sends one). */
export function readyCopyStatusLine(status: CloudReadyCopy["status"], now: number): string | null {
  const updated = relativeAge(status.updatedAt, now), next = later(status.nextUpdateAt, now);
  switch (status.state) {
    case "ready": return ["Ready", updated && `updated ${updated}`, next && `next update ${next}`].filter(Boolean).join(" · ");
    case "updating": return "Updating… The previous copy still serves new workspaces.";
    case "getting_ready": return "Getting ready…";
    case "update_failed": return `Update failed. New workspaces still use the copy from ${updated ?? "before"}.`;
    case "failed": return "Update failed. New workspaces clone directly until a copy is ready.";
    default: return null;
  }
}

const RESULT = { building: "building", ready: "succeeded", retired: "succeeded", failed: "failed" } as const;
const duration = (start: string | null, end: string | null) => {
  if (!start || !end) return null;
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
};

/** A project's ready copy on its project page, for whoever the server lets see it. */
export function ReadyCopySection({ organizationId, projectId, active }: { organizationId: string; projectId: string; active: boolean }) {
  const key = JSON.stringify([organizationId, projectId]);
  const read = useRecoveringRead(readyCopyCache, key, () => getCloudReadyCopy(organizationId, projectId).catch(absent), { enabled: active, maxAgeMs: 30_000 });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<{ generation: number; text: string } | null>(null);
  const copy = read.data;
  if (!copy) return null;
  const now = Date.now(), line = readyCopyStatusLine(copy.status, now), failure = copy.status.failure;
  const build = async () => {
    setBusy(true); setError(null);
    try { await buildCloudReadyCopy(organizationId, projectId); read.refresh(); } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  const show = async (generation: number) => {
    try { setOutput({ generation, text: await getCloudReadyCopyOutput(organizationId, projectId, generation) }); } catch (cause) { setError(message(cause)); }
  };
  if (!line && !copy.history?.length) return null;
  return (
    <SettingsGroup>
      {error && <MessageRow tone="error" role="alert" flush>{error}</MessageRow>}
      <SettingsRow label="Ready copy" hint={[line, failure && readyCopyFailureLine(failure, now)].filter(Boolean).join(" ")}>
        {copy.canBuild && (
          <Button variant="secondary" size="sm" disabled={busy || copy.status.state === "updating" || copy.status.state === "getting_ready"}
            onClick={() => void build()}>{failure ? "Retry now" : "Build now"}</Button>
        )}
      </SettingsRow>
      {copy.history && copy.history.length > 0 && (
        <ul className="divide-border1 m-0 flex list-none flex-col divide-y p-0" aria-label="Ready copy builds">
          {copy.history.map(row => (
            <BuildHistoryItem key={row.generation} state={RESULT[row.state]} title={`Copy #${row.generation}`}
              details={[relativeAge(row.startedAt, now) && `started ${relativeAge(row.startedAt, now)}`, duration(row.startedAt, row.finishedAt),
                row.failure ? readyCopyFailureLine({ ...row.failure, nextRetryAt: null }, now).split(".")[0]! : null,
                ...(row.repositories ?? []).map(entry => entry.branch && entry.commit
                  ? `${row.repositories!.length > 1 ? `${entry.repository} ` : ""}${entry.branch} @ ${entry.commit.slice(0, 7)}` : null),
                readyCopyTriggerLabel(row.trigger, row.startedBy)]}
              action={row.output ? <Button variant="ghost" size="compact" onClick={() => void show(row.generation)}>Output</Button> : undefined} />
          ))}
        </ul>
      )}
      <Sheet open={!!output} onOpenChange={value => { if (!value) setOutput(null); }}>
        <SheetContent side="right" className="p-6">
          <SheetHeader>
            <SheetTitle>{`Copy #${output?.generation ?? ""} setup output`}</SheetTitle>
            <SheetDescription>The last part of the setup's output. Build secrets are shown as [redacted].</SheetDescription>
          </SheetHeader>
          <pre className="text-fg2 m-0 overflow-auto text-xs whitespace-pre-wrap">{output?.text}</pre>
        </SheetContent>
      </Sheet>
    </SettingsGroup>
  );
}
