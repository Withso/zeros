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
