import { describe, expect, it, vi } from "vitest";
import { cloudCanaryRequired, createHourlyRepairMarker, validateHourlyRepair, evaluateHourly } from "../ci/zeros-dev-gate.mjs";
import Ajv from "ajv/dist/2020";
import { INCIDENT_SCHEMA, validateSchema } from "../ci/recovery-contract.mjs";

const snapshot = { activated: true, completedAt: "2026-10-14T00:08:00Z", latest: { id: 17, run_number: 17, run_attempt: 1,
  path: ".github/workflows/zeros-dev-e2e.yml", name: "Zeros dev E2E", head_sha: "a".repeat(40), head_branch: "main", event: "schedule", status: "completed", conclusion: "failure",
  repository: { full_name: "Withso/zeros" }, head_repository: { full_name: "Withso/zeros" } } };
const head = "b".repeat(40), first = "c".repeat(40);
function api(overrides = {}) {
  const marker = createHourlyRepairMarker(snapshot);
  const get = vi.fn(async (url: string) => {
    if (url.endsWith("/pulls/123")) return { number: 123, state: "open", base: { ref: "main", repo: { full_name: "Withso/zeros" } }, head: { sha: head, repo: { full_name: "Withso/zeros" } }, changed_files: 2, commits: 2, ...overrides };
    if (url.includes("/commits?")) return [{ sha: first }, { sha: head }];
    if (url.endsWith(`/commits/${first}`)) return { files: [{ filename: marker.path, status: "added" }] };
    if (url.includes("/contents/")) return url.endsWith(`ref=${first}`) ? { type: "file", encoding: "base64", size: 1000, content: Buffer.from(JSON.stringify(marker.value)).toString("base64") } : null;
    if (url.includes("/reviews?")) return [{ state: "APPROVED", commit_id: head, submitted_at: "2026-10-14T01:00:00Z", user: { login: "owner", type: "User" } }];
    if (url.includes("/permission")) return { permission: "admin" };
    if (url.includes("/files?")) return [{ filename: "scripts/zeros-dev/hourly.ts", status: "modified" }, { filename: "scripts/__tests__/zeros-dev-hourly.test.ts", status: "modified" }];
    throw new Error("unregistered read");
  });
  return { get, marker };
}
describe("D7 cloud merge gate", () => {
  it("uses a closed incident marker without widening the Preflight bot's writer contract", () => {
    const marker = createHourlyRepairMarker(snapshot).value;
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile({ ...INCIDENT_SCHEMA.$defs.hourly_marker, $defs: INCIDENT_SCHEMA.$defs });
    expect(validate(marker), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...marker, source: { ...marker.source, workflow_path: ".github/workflows/preflight.yml" } })).toBe(false);
    expect(validate({ ...marker, override: true })).toBe(false);
    expect(() => validateSchema(marker, INCIDENT_SCHEMA.$defs.marker)).toThrow();
  });
  it("uses path-selected cloud lanes and keeps Local-only/marketing/docs changes nonblocking", () => {
    expect(cloudCanaryRequired({ full: false, lanes: { "cloud-runtime": true } })).toBe(true);
    expect(cloudCanaryRequired({ full: false, lanes: { "control-plane-db": true } })).toBe(true);
    expect(cloudCanaryRequired({ full: false, lanes: { "docs-only": true, "cloud-runtime": false } })).toBe(false);
    expect(cloudCanaryRequired({ full: false, lanes: { marketing: true } })).toBe(false);
    expect(cloudCanaryRequired({ full: false, lanes: { electron: true } })).toBe(false);
    expect(cloudCanaryRequired(null)).toBe(true);
  });
  it("permits only the exact owner-reviewed repair with its initial marker removed and a regression", async () => {
    const f = api(); await expect(validateHourlyRepair(f, { number: 123, head }, snapshot)).resolves.toBe(true);
    expect(await evaluateHourly(f, { cloudRequired: true, number: 123, head, snapshot })).toMatchObject({ allowed: true, code: "hourly_reviewed_repair" });
  });
  it.each(["stale-review", "not-owner", "marker-retained", "different-failure", "no-regression"])("rejects a %s repair", async kind => {
    const f = api(), original = f.get.getMockImplementation()!;
    f.get.mockImplementation(async url => {
      if (kind === "stale-review" && url.includes("/reviews?")) return [{ state: "APPROVED", commit_id: first, submitted_at: "2026-10-14T01:00:00Z", user: { login: "owner", type: "User" } }];
      if (kind === "not-owner" && url.includes("/permission")) return { permission: "write" };
      if (kind === "marker-retained" && url.includes("/contents/") && url.endsWith(`ref=${head}`)) return { type: "file" };
      if (kind === "no-regression" && url.includes("/files?")) return [{ filename: "docs/zeros-dev.md", status: "modified" }, { filename: "scripts/zeros-dev/hourly.ts", status: "modified" }];
      return original(url);
    });
    const target = kind === "different-failure" ? { ...snapshot, latest: { ...snapshot.latest, run_attempt: 2 } } : snapshot;
    expect(await validateHourlyRepair(f, { number: 123, head }, target)).toBe(false);
  });
  it("network failures close the cloud gate while noncloud changes get an alert", async () => {
    const f = { get: vi.fn(async () => { throw new Error("private diagnostic"); }) };
    expect(await evaluateHourly(f, { cloudRequired: true })).toMatchObject({ allowed: false, code: "hourly_unavailable" });
    expect(await evaluateHourly(f, { cloudRequired: false })).toMatchObject({ allowed: true, alert: true });
  });
});
