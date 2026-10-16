/**
 * Per-organization flag discovery (owner decision 1 for S3-Q10).
 *
 * The SDK POSTs runtime/connect for a workspace; a legacy 404 or an explicit
 * disabled code means the organization still uses the legacy engine-admission
 * path. The decision is cached per organization and re-evaluated only when a
 * catalog.changed event invalidates it — no polling, no extra traffic, and the
 * probe itself never wakes a workspace.
 */
import { CloudRestError } from "./rest-client";

export type CloudFlagState = "sdk" | "legacy";

const DISABLED_CODES = new Set([
  "cloud_workspaces_disabled",
  "feature_disabled",
  "runtime_connect_disabled",
]);

/**
 * Map a runtime/connect failure to a flag decision, or null when the failure
 * says nothing about the flag (transient 5xx, network) — never decide on those.
 */
export function probeFromConnectFailure(error: unknown): CloudFlagState | null {
  if (!(error instanceof CloudRestError)) return null;
  if (error.status === 404) return "legacy";
  if (error.status === 403 && DISABLED_CODES.has(error.code)) return "legacy";
  return null;
}

/**
 * Per-organization, single-flight cache of the probe answer. The caller wires
 * `invalidate()` to the device-stream catalog.changed event.
 */
export class CloudOrgFlagCache {
  private readonly entries = new Map<string, Promise<CloudFlagState>>();

  constructor(private readonly probe: (organizationId: string) => Promise<CloudFlagState>) {}

  resolve(organizationId: string): Promise<CloudFlagState> {
    const cached = this.entries.get(organizationId);
    if (cached) return cached;
    const pending = this.probe(organizationId).catch((error: unknown) => {
      // A failed probe is not a decision; drop it so the next resolve retries.
      this.entries.delete(organizationId);
      throw error;
    });
    this.entries.set(organizationId, pending);
    return pending;
  }

  invalidate(organizationId?: string): void {
    if (organizationId === undefined) this.entries.clear();
    else this.entries.delete(organizationId);
  }
}
