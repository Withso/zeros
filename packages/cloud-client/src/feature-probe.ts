/**
 * Per-organization flag discovery (owner decision 1 for S3-Q10).
 *
 * The SDK POSTs runtime/connect for a workspace; a route-absent 404 (generic
 * `not_found`, or no S3 error envelope at all) or an explicit 403 disabled
 * code means the organization still uses the legacy engine-admission path. A
 * 404 with any specific code — `cloud_workspace_not_found` for a deleted
 * workspace — comes from a control plane that serves the route, so it decides
 * nothing and nothing is cached. The decision is cached per organization and re-evaluated only when a
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
  if (error.status === 404) return !error.envelope || error.code === "not_found" ? "legacy" : null;
  if (error.status === 403 && DISABLED_CODES.has(error.code)) return "legacy";
  return null;
}

/**
 * Per-organization, single-flight cache of the probe answer. The probe runs
 * against the workspace the caller is opening; a null answer (no decision) is
 * returned to that caller and never cached. The caller wires `invalidate()`
 * to the device-stream catalog.changed event.
 */
export class CloudOrgFlagCache {
  private readonly entries = new Map<string, Promise<CloudFlagState | null>>();

  constructor(
    private readonly probe: (organizationId: string, workspaceId: string) => Promise<CloudFlagState | null>,
  ) {}

  resolve(organizationId: string, workspaceId: string): Promise<CloudFlagState | null> {
    const cached = this.entries.get(organizationId);
    if (cached) return cached;
    const forget = () => {
      if (this.entries.get(organizationId) === pending) this.entries.delete(organizationId);
    };
    const pending: Promise<CloudFlagState | null> = this.probe(organizationId, workspaceId).then(
      (state) => {
        if (state === null) forget();
        return state;
      },
      (error: unknown) => {
        // A failed probe is not a decision; drop it so the next resolve retries.
        forget();
        throw error;
      },
    );
    this.entries.set(organizationId, pending);
    return pending;
  }

  invalidate(organizationId?: string): void {
    if (organizationId === undefined) this.entries.clear();
    else this.entries.delete(organizationId);
  }
}
