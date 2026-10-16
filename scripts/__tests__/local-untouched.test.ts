import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  evaluateLocalSeams,
  loadLocalSeamsManifest,
  runLocalUntouched,
  validateLocalSeamsManifest,
} from "../ci/local-untouched.mjs";
import { matchesGlob, parseNameStatus } from "../ci/scope.mjs";

/** Build change records the way Git reports them, NUL-terminated. */
function changes(...lines: string[]) {
  return parseNameStatus(Buffer.from(`${lines.join("\0")}\0`));
}

const MANIFEST = {
  schema: "zeros.local-seams/v1",
  sign_off_label: "local-seams-sign-off",
  cloud_paths: [
    "apps/control-plane/**",
    "packages/cloud-client/**",
    "packages/protocol/**",
    "apps/desktop/src/engine/cloud-*.ts",
    "apps/desktop/src/engine/transport/cloud.ts",
    "apps/desktop/src/renderer/state/cloud-*.ts*",
    "apps/desktop/electron/cloud-*.ts",
  ],
  local_only: [
    { include: ["scripts/electron-local.mjs"] },
    {
      include: ["apps/desktop/src/engine/transport/**"],
      exclude: [
        "apps/desktop/src/engine/transport/cloud.ts",
        "apps/desktop/src/engine/transport/cloud-*.ts",
        "apps/desktop/src/engine/transport/cloud-*.mts",
        "apps/desktop/src/engine/transport/router.ts",
        "apps/desktop/src/engine/transport/types.ts",
        "apps/desktop/src/engine/transport/__tests__/cloud-*.ts",
        "apps/desktop/src/engine/transport/__tests__/router.test.ts",
      ],
    },
    {
      include: ["apps/desktop/src/engine/agents/**"],
      exclude: [
        "apps/desktop/src/engine/agents/cloud-*.ts",
        "apps/desktop/src/engine/agents/__tests__/cloud-*.ts",
      ],
    },
  ],
  shared_seams: [
    {
      id: "engine-core",
      include: ["apps/desktop/src/engine/zeros-engine.ts"],
      requires_lanes: ["desktop-engine"],
    },
    {
      id: "renderer-bridge",
      include: [
        "apps/desktop/src/renderer/platform/bridge/runtime-client.ts",
        "apps/desktop/src/renderer/platform/bridge/workspace-runtime-client.ts",
        "apps/desktop/src/renderer/platform/bridge/use-bridge.tsx",
      ],
      requires_lanes: ["desktop-renderer"],
    },
    {
      id: "protocol",
      include: ["packages/protocol/**"],
      requires_lanes: ["protocol", "desktop-renderer", "desktop-engine", "electron"],
    },
  ],
};

const CLOUD_CHANGE = "M\0apps/control-plane/src/cloud-workspaces/reconciler.ts";
const LOCAL_LANES = ["desktop-engine", "desktop-renderer", "electron", "protocol"];

describe("local-untouched manifest", () => {
  it("accepts the checked-in manifest", () => {
    expect(() => validateLocalSeamsManifest(MANIFEST)).not.toThrow();
    const loaded = loadLocalSeamsManifest();
    expect(loaded.schema).toBe("zeros.local-seams/v1");
    expect(loaded.sign_off_label).toMatch(/^[a-z][a-z\d]*(?:-[a-z\d]+)*$/);
  });

  it("rejects malformed manifests", () => {
    expect(() => validateLocalSeamsManifest(null)).toThrow(/object/);
    expect(() => validateLocalSeamsManifest({ ...MANIFEST, schema: "other" })).toThrow(/schema/);
    expect(() => validateLocalSeamsManifest({ ...MANIFEST, cloud_paths: [] })).toThrow(/cloud_paths/);
    expect(() =>
      validateLocalSeamsManifest({ ...MANIFEST, local_only: [{ include: [] }] }),
    ).toThrow(/include/);
    expect(() =>
      validateLocalSeamsManifest({
        ...MANIFEST,
        shared_seams: [{ id: "x", include: ["a/**"], requires_lanes: [] }],
      }),
    ).toThrow(/requires_lanes/);
    expect(() =>
      validateLocalSeamsManifest({ ...MANIFEST, extra: true }),
    ).toThrow(/unrecognized/);
  });

  it("matches the real Local transport seam precisely", () => {
    const loaded = loadLocalSeamsManifest();
    const hit = (file: string, entries: { include: string[]; exclude?: string[] }[]) =>
      entries.some(
        (entry) =>
          entry.include.some((glob) => matchesGlob(file, glob)) &&
          !(entry.exclude ?? []).some((glob) => matchesGlob(file, glob)),
      );
    expect(hit("apps/desktop/src/engine/transport/local.ts", loaded.local_only)).toBe(true);
    expect(hit("apps/desktop/src/engine/transport/cloud.ts", loaded.local_only)).toBe(false);
    expect(hit("apps/desktop/src/engine/transport/router.ts", loaded.local_only)).toBe(false);
    expect(hit("apps/desktop/src/engine/agents/adapters/codex/app-server-client.ts", loaded.local_only)).toBe(true);
    expect(hit("apps/desktop/src/engine/agents/cloud-actor-authority.ts", loaded.local_only)).toBe(false);
  });
});

describe("evaluateLocalSeams", () => {
  it("ignores pull requests that do not touch the cloud program", () => {
    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes("M\0scripts/electron-local.mjs", "M\0apps/desktop/src/engine/transport/local.ts"),
      labels: [],
      selectedLanes: [],
    });
    expect(result.cloud).toBe(false);
    expect(result.problems).toEqual([]);
  });

  it("passes a cloud change that stays inside the cloud program", () => {
    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes(CLOUD_CHANGE, "A\0packages/cloud-client/src/index.ts"),
      labels: [],
      selectedLanes: [],
    });
    expect(result.cloud).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it("fails a cloud pull request touching Local-only files without sign-off", () => {
    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes(CLOUD_CHANGE, "M\0scripts/electron-local.mjs"),
      labels: [],
      selectedLanes: [],
    });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("scripts/electron-local.mjs");
    expect(result.problems[0]).toContain("local-seams-sign-off");
  });

  it("accepts Local-only edits when the owner sign-off label is present", () => {
    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes(CLOUD_CHANGE, "M\0apps/desktop/src/engine/transport/local.ts"),
      labels: ["local-seams-sign-off", "other-label"],
      selectedLanes: [],
    });
    expect(result.localOnlyHits).toEqual(["apps/desktop/src/engine/transport/local.ts"]);
    expect(result.problems).toEqual([]);
  });

  it("flags deleted and renamed Local-only files as well", () => {
    const removed = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes(CLOUD_CHANGE, "D\0apps/desktop/src/engine/transport/local.ts"),
      labels: [],
      selectedLanes: [],
    });
    expect(removed.problems[0]).toContain("apps/desktop/src/engine/transport/local.ts");
    const renamed = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes("R100\0apps/desktop/src/engine/transport/cloud.ts\0apps/desktop/src/engine/transport/local.ts"),
      labels: [],
      selectedLanes: [],
    });
    // The source path is cloud code, so this rename makes the PR a cloud PR,
    // and the destination lands on a Local-only file.
    expect(renamed.cloud).toBe(true);
    expect(renamed.problems[0]).toContain("apps/desktop/src/engine/transport/local.ts");
  });

  it("does not flag cloud transport code as Local-only", () => {
    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes(CLOUD_CHANGE, "M\0apps/desktop/src/engine/transport/cloud.ts"),
      labels: [],
      selectedLanes: [],
    });
    expect(result.localOnlyHits).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("requires the Local test lanes when a cloud pull request crosses a shared seam", () => {
    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes(CLOUD_CHANGE, "M\0apps/desktop/src/engine/zeros-engine.ts"),
      labels: [],
      selectedLanes: ["control-plane"],
    });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("engine-core");
    expect(result.problems[0]).toContain("desktop-engine");
  });

  it("passes shared-seam edits when the required Local lanes are selected", () => {
    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes(CLOUD_CHANGE, "M\0apps/desktop/src/engine/zeros-engine.ts"),
      labels: [],
      selectedLanes: LOCAL_LANES,
    });
    expect(result.sharedSeamHits.map((hit) => hit.id)).toEqual(["engine-core"]);
    expect(result.problems).toEqual([]);
  });

  it("requires every protocol lane for protocol changes in a cloud pull request", () => {    const result = evaluateLocalSeams({
      manifest: MANIFEST,
      changes: changes("M\0packages/protocol/src/cloud.ts"),
      labels: [],
      selectedLanes: ["protocol", "desktop-renderer"],
    });
    expect(result.cloud).toBe(true);
    expect(result.problems[0]).toContain("protocol");
    expect(result.problems[0]).toContain("desktop-engine");
    expect(result.problems[0]).toContain("electron");
  });
});

describe("runLocalUntouched CLI wiring", () => {
  it("rejects unknown arguments with usage", () => {
    expect(() => runLocalUntouched({ argv: ["--bogus"], env: {} })).toThrow(
      /Usage: node scripts\/ci\/local-untouched\.mjs/,
    );
  });

  it("fails closed when the pull-request evidence is unavailable", () => {
    expect(() =>
      runLocalUntouched({
        argv: [],
        env: { EVENT_NAME: "pull_request" },
        cwd: process.cwd(),
      }),
    ).toThrow(/failing closed/);
  });
});
