/** Per-organization rollout gate for the engine uplink. Kept behind this one
 * function so a durable feature-flag source can replace the configured list
 * without touching the uplink server or the engine-facing advertisement. */
export type UplinkRolloutGate = (organizationId: string) => boolean;

export function configuredUplinkRollout(organizations: readonly string[] | undefined): UplinkRolloutGate {
  const enabled = new Set((organizations ?? []).map(id => id.toLowerCase()));
  return organizationId => enabled.has(organizationId.toLowerCase());
}
