import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { ensureDevImage } from "../dev-environment/hosted-image.mjs";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { DevProviderError } from "../dev-environment/provider-http.mjs";

const kit = vi.hoisted(() => ({ main: vi.fn() }));
vi.mock("../cloud-workspace-validation/boat-image/boat-image.ts", () => ({ ...kit, TEMPLATES: "unused" }));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const inputs = "b".repeat(64), commit = "a".repeat(40);
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals(); kit.main.mockReset();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dev-image-generation-"));
  fs.chmodSync(directory, 0o700); directories.push(directory);
  const legacy = path.join(directory, "images", inputs);
  fs.mkdirSync(legacy, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacy, "builder.json"), JSON.stringify({ marker: "retired-generation" }), { mode: 0o600 });
  const state = newHostedGeneration({ owner: "c".repeat(24), identity: "generation-test" });
  const lease = { state, save: vi.fn(async () => {}), fence: vi.fn(async () => {}) };
  const profile = { boat: { apiKey: "test-only", billingOrg: "test-org", baseSnapshot: "test-base", builderBudgetHours: 1 } };
  const source = { workerInputsSha256: inputs, worker: { directory: root, commit } };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (!url.includes("/limits?")) throw new Error("Unexpected provider request");
    return new Response(JSON.stringify({ creditUsedSeconds: 0 }), { status: 200 });
  }));
  const observed: string[] = [];
  kit.main.mockImplementation(async (args: string[], deps: { stateDir: string }) => {
    const file = path.join(deps.stateDir, "builder.json");
    if (args[0] === "builder" && args[1] === "create") {
      fs.writeFileSync(file, JSON.stringify({ marker: "fresh-generation" }), { mode: 0o600 });
      return {};
    }
    if (args[0] === "builder" && args[1] === "status") {
      observed.push(JSON.parse(fs.readFileSync(file, "utf8")).marker);
      // Stop this fixture before any actual image build. The test exercises
      // the real filesystem/registry selection at the kit boundary.
      throw new Error("fixture finished inspecting builder selection");
    }
    throw new Error("Unexpected image-kit operation");
  });
  return { directory, legacy, state, lease, profile, source, observed };
}

describe("Dev image state after remote archive", () => {
  it("does not mislabel an old local kit ceiling or arbitrary output as a current provider quota", async () => {
    const f = fixture();
    kit.main.mockRejectedValue(new Error("The account already holds 10 named snapshots; delete an unused one first"));
    await expect(ensureDevImage(f.lease,f.profile,f.source,f.directory,{})).rejects.not.toThrow(/Boat.*snapshot.*limit/i);
    kit.main.mockRejectedValue(new Error("secret-fixture-must-not-appear"));
    await expect(ensureDevImage(f.lease,f.profile,f.source,f.directory,{})).rejects.not.toThrow(/secret-fixture/);
  });

  it.each([{ status: 402, code: "provider_budget_exhausted" }, { status: 429, code: "provider_rate_limited" }])("keeps HTTP $status through the real kit and hosted wrapper without releasing an uncertain create", async ({ status, code }) => {
    const f = fixture();
    const actual = await vi.importActual<typeof import("../cloud-workspace-validation/boat-image/boat-image")>("../cloud-workspace-validation/boat-image/boat-image.ts");
    kit.main.mockImplementation(actual.main);
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes("/limits?")) return Response.json({ creditUsedSeconds: 0 });
      if (url.endsWith("/sandboxes")) return Response.json({ message: "synthetic-private-canary" }, { status });
      throw new Error("Unexpected provider request");
    });
    vi.stubGlobal("fetch", fetcher);
    const error = await ensureDevImage(f.lease, f.profile, f.source, f.directory, {}).catch(error => error);
    expect(error).toBeInstanceOf(DevProviderError); expect(error).toMatchObject({ status, code });
    expect(String(error)).not.toContain("synthetic-private-canary");
    const record = f.state.resources.images[0];
    expect(record.builderCreate).toMatchObject({ phase: "uncertain", outcome: status });
    expect(record.builderIntent).toBeDefined(); expect(record.builder).toBeUndefined();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith("/sandboxes"))).toHaveLength(1);
  });

  it("does not reuse a retired builder left on another device for identical source inputs", async () => {
    const f = fixture();
    await expect(ensureDevImage(f.lease, f.profile, f.source, f.directory, {})).rejects.toThrow(/worker build did not complete/);
    expect(f.observed).toEqual(["fresh-generation"]);
    expect(kit.main.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.legacy, "builder.json"), "utf8")).marker).toBe("retired-generation");
  });

  it("restores a pending build from its encrypted generation receipt without allocating another builder", async () => {
    const f = fixture();
    f.state.resources.images = [{ inputsSha256: inputs, sourceCommit: commit, maxUsedHours: 1,
      files: gzipSync(JSON.stringify({ "builder.json": JSON.stringify({ marker: "recorded-current-generation" }) })).toString("base64") }];
    await expect(ensureDevImage(f.lease, f.profile, f.source, f.directory, {})).rejects.toThrow(/worker build did not complete/);
    expect(f.observed).toEqual(["recorded-current-generation"]);
    expect(kit.main.mock.calls.some(([args]) => args[1] === "create")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(f.legacy, "builder.json"), "utf8")).marker).toBe("retired-generation");
  });

  it("allocates a fresh builder on repeated generations without requiring local cache deletion", async () => {
    const f = fixture();
    await expect(ensureDevImage(f.lease, f.profile, f.source, f.directory, {})).rejects.toThrow(/worker build did not complete/);
    f.state.status = "archived";
    const next = { ...f.lease, state: newHostedGeneration({ owner: f.state.owner, identity: f.state.identity }, f.state) };
    await expect(ensureDevImage(next, f.profile, f.source, f.directory, {})).rejects.toThrow(/worker build did not complete/);
    expect(f.observed).toEqual(["fresh-generation", "fresh-generation"]);
    expect(kit.main.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(2);
  });
});
