/** `undefined` means this renderer has not proved what organization context is
 * resident in the engine yet. A different semantic owner must clear the old
 * settings before any network revalidation can fail or stall. */
export function organizationContextNeedsClear(
  appliedOrganizationId: string | null | undefined,
  selectedOrganizationId: string | null,
): boolean {
  return (
    appliedOrganizationId === undefined ||
    appliedOrganizationId !== selectedOrganizationId
  );
}

/** A settings response is usable only while the exact organization that
 * requested it remains selected. */
export function organizationContextStillSelected(
  requestedOrganizationId: string,
  selectedOrganizationId: string | null,
): boolean {
  return requestedOrganizationId === selectedOrganizationId;
}

export const ORGANIZATION_FOCUS_RESYNC_MIN_INTERVAL_MS = 30_000;

/** Window activation is a freshness hint, not an instruction to issue one
 * request per alt-tab. Explicit mutations and selection changes bypass this
 * guard; focus only refreshes once the last real sync start is old enough. */
export function organizationContextShouldRefreshOnFocus(
  lastSyncStartedAt: number,
  now: number,
): boolean {
  return now - lastSyncStartedAt >= ORGANIZATION_FOCUS_RESYNC_MIN_INTERVAL_MS;
}
