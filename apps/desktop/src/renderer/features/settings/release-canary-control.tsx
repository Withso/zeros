import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui";
import { Switch } from "../../shared/ui/primitives/switch";
import { useCachedRead } from "../../state/use-cached-read";
import { getTeamStoreState } from "../team/team-store";
import type { CloudProviderCredential } from "./cloud-provider-connection";
import { useInternalFeatureActive } from "./internal-features";
import { changeReleaseCanaryDesignation, releaseCanaryDefaultModel, releaseCanaryDesignationKey, releaseCanaryDesignationsCache,
  readReleaseCanaryDesignationKey, type ReleaseCanaryChange, type ReleaseCanaryDesignation } from "./release-canary-designation";

type PendingChange = { body: ReleaseCanaryChange; dispatched: boolean };
export function ReleaseCanaryControl({ userId, organizationId, credential, surfaceActive }: {
  userId: string; organizationId: string; credential: CloudProviderCredential; surfaceActive: boolean;
}) {
  const visible = useInternalFeatureActive("releaseCanaries");
  const defaultModel = releaseCanaryDefaultModel(credential.kind);
  const eligible = visible && !!defaultModel && !credential.revoked;
  const key = eligible ? releaseCanaryDesignationKey(userId, organizationId, credential.id, credential.revision) : null;
  const snapshot = useCachedRead(releaseCanaryDesignationsCache, key, readReleaseCanaryDesignationKey,
    { enabled: surfaceActive && eligible, maxAgeMs: 30_000 });
  const confirmed = snapshot.data?.credentialRevision === credential.revision ? snapshot.data : undefined;
  const enabled = eligible && confirmed?.enabled === true;
  const approvedModel = enabled && confirmed ? confirmed.models.includes(defaultModel!) ? defaultModel : [...confirmed.models].sort()[0] : defaultModel;
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const pending = useRef<PendingChange | null>(null), inFlight = useRef(false), mounted = useRef(true);
  const activity = useRef(surfaceActive);
  useEffect(() => { activity.current = surfaceActive; }, [surfaceActive]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; pending.current = null; }; }, []);
  const current = () => mounted.current && getTeamStoreState().me?.user.id === userId && getTeamStoreState().me?.user.staffRole === "platform_owner";
  const matches = (value: ReleaseCanaryDesignation, body: ReleaseCanaryChange) => value.credentialRevision === body.credentialRevision &&
    value.enabled === body.enabled && (!body.enabled || JSON.stringify(value.models) === JSON.stringify(body.models));
  const readback = async () => {
    releaseCanaryDesignationsCache.invalidate(key!);
    return releaseCanaryDesignationsCache.load(key!, () => readReleaseCanaryDesignationKey(key!), { force: true });
  };
  const submit = async (intent: PendingChange) => {
    if (!surfaceActive || !eligible || !key || !current() || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      if (intent.dispatched) {
        const observed = await readback();
        if (matches(observed, intent.body)) { pending.current = null; return; }
        if (observed.designationId !== intent.body.expectedDesignationId || observed.credentialRevision !== intent.body.credentialRevision) {
          pending.current = null; throw new Error("changed");
        }
      }
      if (!current()) return;
      if (!activity.current) { setError("Could not confirm the change. Retry reconciles the same operation."); return; }
      intent.dispatched = true;
      const result = await changeReleaseCanaryDesignation(credential.id, intent.body);
      if (!current()) return;
      if (result.enabled !== intent.body.enabled) throw new Error("unconfirmed");
      releaseCanaryDesignationsCache.setData(key, { designationId: result.designationId, credentialRevision: intent.body.credentialRevision,
        enabled: result.enabled, models: result.enabled ? intent.body.models : [], lastUsedAt: confirmed?.lastUsedAt ?? null });
      pending.current = null; if (activity.current) snapshot.refresh();
    } catch {
      if (!current()) return;
      if (!activity.current) { setError("Could not confirm the change. Retry reconciles the same operation."); return; }
      try {
        const observed = await readback();
        if (matches(observed, intent.body)) { pending.current = null; return; }
        if (observed.designationId !== intent.body.expectedDesignationId || observed.credentialRevision !== intent.body.credentialRevision) pending.current = null;
      } catch {}
      if (current()) setError(pending.current ? "Could not confirm the change. Retry reconciles the same operation." : "Release check consent changed. Review the current setting before changing it again.");
    } finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const toggle = (next: boolean) => {
    if (!confirmed || !defaultModel || !key || pending.current || snapshot.error) return;
    const intent = { body: { operationId: crypto.randomUUID(), expectedDesignationId: confirmed.designationId,
      credentialRevision: credential.revision, enabled: next, models: next ? [defaultModel] : confirmed.models.length ? confirmed.models : [defaultModel] }, dispatched: false };
    pending.current = intent; void submit(intent);
  };
  const controlId = `release-canary-${organizationId}-${credential.id}`;
  if (!visible) return null;
  return (
    <div className="flex flex-col gap-2" data-release-canary-control="">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={controlId} className="text-fg1 text-xs">Use for release checks</label>
        <Switch id={controlId} checked={enabled} onCheckedChange={toggle} aria-describedby={`${controlId}-details`}
          disabled={!surfaceActive || !eligible || !confirmed || !!snapshot.error || busy || !!pending.current} />
      </div>
      <div id={`${controlId}-details`} className="text-fg2 flex flex-col gap-1 text-xs">
        {eligible ? <>
          <span>{enabled ? "Approved model" : "Model"}: {approvedModel}</span>
          {enabled && approvedModel !== defaultModel && <span>SMOKE requires {defaultModel}. Switch off and on to approve it.</span>}
          <span>Last used: {confirmed?.lastUsedAt ? <time dateTime={confirmed.lastUsedAt}>{new Date(confirmed.lastUsedAt).toLocaleString()}</time> : confirmed ? "Never" : "Not checked"}</span>
          <span>Used only by automated release checks on temporary cloud machines, usually two messages per check. Reconnecting this account turns it off.</span>
        </> : <span>This connection type is not part of release checks.</span>}
      </div>
      {(error || snapshot.error) && <div className="flex items-center justify-between gap-3">
        <p role="alert" className="text-red-primary text-xs">{error ?? "Release checks are unavailable for this channel owner."}</p>
        <Button variant="ghost" disabled={!surfaceActive || busy} onClick={() => pending.current ? void submit(pending.current) : snapshot.refresh()}>
          {pending.current ? "Retry change" : "Refresh"}
        </Button>
      </div>}
    </div>
  );
}
