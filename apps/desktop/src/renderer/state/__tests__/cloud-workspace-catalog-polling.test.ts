import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudSdkStreamSnapshot } from "../../../../shared/cloud-sdk-stream-contract";

const rollout = vi.hoisted(() => ({ enabled: true }));
vi.mock("../cloud-workspace-stream-rollout", () => ({ cloudCatalogStreamRolloutEnabled: () => rollout.enabled }));
import { cloudCatalogFallbackOrganizations, cloudWorkspaceLifecycleStreamCovered } from "../cloud-workspace-catalog-polling";
import { cloudWorkspaceStreamCoverage, setCloudWorkspaceStreamCoverage, subscribeCloudWorkspaceStreamCoverage } from "../cloud-workspace-stream-coverage";

const id = (n: number) => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const a = id(1), b = id(2), guest = id(3);
function coverage(organizations = [
  { organizationId: a, deviceStream: true, presence: true },
  { organizationId: b, deviceStream: false, presence: false },
]): CloudSdkStreamSnapshot {
  return { streamId: id(10), leaseId: id(11), sequence: 3, revision: 1, state: "open", catalogRequired: false, organizations };
}
beforeEach(() => { rollout.enabled = true; setCloudWorkspaceStreamCoverage(null); });
afterEach(() => setCloudWorkspaceStreamCoverage(null));

describe("catalog and lifecycle poll eligibility", () => {
  it("ships disabled independently of server rollout flags", async () => {
    const actual = await vi.importActual<typeof import("../cloud-workspace-stream-rollout")>("../cloud-workspace-stream-rollout");
    expect(actual.cloudCatalogStreamRolloutEnabled()).toBe(false);
    setCloudWorkspaceStreamCoverage(coverage()); rollout.enabled = false;
    expect(cloudCatalogFallbackOrganizations([a, b], [a, b])).toBeNull();
    expect(cloudWorkspaceLifecycleStreamCovered(a)).toBe(false);
  });

  it("suppresses only explicitly covered organizations after a complete current snapshot", () => {
    setCloudWorkspaceStreamCoverage(coverage());
    expect(cloudCatalogFallbackOrganizations([a, b], [a, b])).toEqual([b]);
    expect(cloudWorkspaceLifecycleStreamCovered(a)).toBe(true);
    expect(cloudWorkspaceLifecycleStreamCovered(b)).toBe(false);
    setCloudWorkspaceStreamCoverage(coverage([{ organizationId: a, deviceStream: true, presence: false }]));
    expect(cloudCatalogFallbackOrganizations([a], [a])).toEqual([]);
    expect(cloudWorkspaceLifecycleStreamCovered(a)).toBe(true);
  });

  it.each(["missing", "waiting", "catchup", "lease"])("keeps fallback with %s stream proof", kind => {
    const view = coverage();
    if (kind === "waiting") view.state = "waiting";
    if (kind === "catchup") view.catalogRequired = true;
    if (kind === "lease") view.leaseId = null;
    setCloudWorkspaceStreamCoverage(kind === "missing" ? null : view);
    expect(cloudCatalogFallbackOrganizations([a, b], [a])).toBeNull();
    expect(cloudWorkspaceLifecycleStreamCovered(a)).toBe(false);
  });

  it("retains the global fallback for unknown membership and uncovered guest organizations", () => {
    setCloudWorkspaceStreamCoverage(coverage());
    expect(cloudCatalogFallbackOrganizations(null, [a, b])).toBeNull();
    expect(cloudCatalogFallbackOrganizations([a], [a, guest])).toBeNull();
    expect(cloudCatalogFallbackOrganizations([a], [a])).toBeNull(); // B is in ready, but not the member set.
    setCloudWorkspaceStreamCoverage(coverage([{ organizationId: a, deviceStream: true, presence: true }]));
    expect(cloudCatalogFallbackOrganizations([a, b], [a])).toEqual([b]); // Missing entry is unproven.
  });

  it("keeps global fallback for bounded organization metadata and excessive scoped reads", () => {
    const ids = Array.from({ length: 1_000 }, (_, i) => id(i + 100));
    setCloudWorkspaceStreamCoverage(coverage(ids.map(organizationId => ({ organizationId, deviceStream: true, presence: false }))));
    expect(cloudCatalogFallbackOrganizations(ids, ids)).toBeNull();
    setCloudWorkspaceStreamCoverage(coverage());
    expect(cloudCatalogFallbackOrganizations([a, ...ids.slice(0, 20)], [])).toBeNull();
  });

  it("reuses coverage values and only notifies meaningful changes", () => {
    const changed = vi.fn(), off = subscribeCloudWorkspaceStreamCoverage(changed);
    try {
      setCloudWorkspaceStreamCoverage(coverage()); const first = cloudWorkspaceStreamCoverage(a);
      setCloudWorkspaceStreamCoverage({ ...coverage(), sequence: 4 });
      expect(cloudWorkspaceStreamCoverage(a)).toBe(first); expect(changed).toHaveBeenCalledOnce();
      setCloudWorkspaceStreamCoverage(null);
      expect(cloudWorkspaceLifecycleStreamCovered(a)).toBe(false); expect(changed).toHaveBeenCalledTimes(2);
    } finally { off(); }
  });
});
