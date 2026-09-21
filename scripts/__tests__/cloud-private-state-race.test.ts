import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  target: "",
  replace: null as (() => void) | null,
  beforeRead: null as (() => void) | null,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  const beforeUse = (file: unknown) => {
    if (file === race.target && race.replace) {
      const replace = race.replace;
      race.replace = null;
      replace();
    }
  };
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      beforeUse(args[0]);
      return actual.openSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      beforeUse(args[0]);
      return actual.readFileSync(...args);
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      const replace = race.beforeRead;
      race.beforeRead = null;
      replace?.();
      return actual.readSync(...args);
    },
  };
});
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), "zeros-private-state-race-"));
  vi.stubEnv("ZEROS_CLOUD_VALIDATION_STATE_DIR", root);
  vi.resetModules();
});
afterEach(() => {
  race.replace = null;
  race.beforeRead = null;
  race.target = "";
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(root + "-moved", { recursive: true, force: true });
});

const runId = "11111111-1111-4111-8111-111111111111";
const cases = [
  {
    kind: "intent",
    file: "allocation-intent.json",
    max: 4096,
    value: {
      version: 1,
      providerScope: "a".repeat(64),
      runId,
      name: `zeros-validation-${runId}`,
      snapshot: "fixture",
      createdAt: "2026-09-01T00:00:00Z",
      ttlMinutes: 5,
    },
  },
  {
    kind: "snapshot",
    file: "snapshot-allocation.json",
    max: 4096,
    value: {
      version: 1,
      providerScope: "a".repeat(64),
      runId,
      name: "fixture",
      requestedAt: "2026-09-01T00:00:00Z",
    },
  },
  {
    kind: "attestation",
    file: "snapshot-attestation.json",
    max: 16384,
    value: {
      version: 2,
      snapshotId: "snapshot-id",
      snapshotImageName: "snapshot-image",
      sourceCommit: "a".repeat(40),
      imageContractSha256: "b".repeat(64),
      sandboxClass: "linux-vm",
      region: "eu",
      resources: { cpu: 2, memory: 4, disk: 20 },
      registryImage: `registry.example.test/zeros/engine@sha256:${"c".repeat(64)}`,
    },
  },
  {
    kind: "state",
    file: "state.json",
    max: 2 * 1024 * 1024,
    value: {
      sandboxId: "sandbox-test",
      previewUrl: "https://39393-sandbox-id.proxy.daytona.work",
      previewToken: "preview-token-placeholder",
      cloudToken: "cloud-token-placeholder",
      region: "eu",
      createdAt: "2026-09-01T00:00:00Z",
      snapshotId: "snapshot-id",
      snapshotImageName: "snapshot-image",
      runtimeAttestationSha256: "a".repeat(64),
    },
  },
];
it.each(
  cases.flatMap((value) =>
    ["hardlink", "oversized"].map((replacement) => ({ ...value, replacement })),
  ),
)(
  "retains and rejects a $replacement substituted for $kind evidence before reading",
  async (test) => {
    const config = await import("../cloud-workspace-validation/config");
    race.target = path.join(root, test.file);
    const outside = path.join(root, "outside.json");
    const content = JSON.stringify(test.value);
    fs.writeFileSync(race.target, content, { mode: 0o600 });
    fs.writeFileSync(outside, content, { mode: 0o600 });
    const read = () =>
      test.kind === "intent"
        ? config.qualificationAllocationStore.read()
        : test.kind === "snapshot"
          ? config.snapshotAllocationStore.read()
          : test.kind === "attestation"
            ? config.loadSnapshotAttestation(race.target)
            : config.loadState(race.target);
    expect(read()).toEqual(test.value);
    race.replace = () => {
      fs.rmSync(race.target);
      if (test.replacement === "hardlink") fs.linkSync(outside, race.target);
      else
        fs.writeFileSync(race.target, content + " ".repeat(test.max), {
          mode: 0o600,
        });
    };
    expect(read).toThrow();
    expect(race.replace).toBeNull();
    expect(fs.existsSync(race.target)).toBe(true);
    expect(fs.readFileSync(outside, "utf8")).toBe(content);
  },
);

it.each(cases)(
  "does not echo malformed $kind evidence in diagnostics",
  async (test) => {
    const config = await import("../cloud-workspace-validation/config");
    const file = path.join(root, test.file);
    const content = 'PRIVATE_DOCUMENT_CANARY{"token":"fixture"';
    fs.writeFileSync(file, content, { mode: 0o600 });
    const read = () =>
      test.kind === "intent"
        ? config.qualificationAllocationStore.read()
        : test.kind === "snapshot"
          ? config.snapshotAllocationStore.read()
          : test.kind === "attestation"
            ? config.loadSnapshotAttestation(file)
            : config.loadState(file);
    expect(read).toThrow(/^cloud validation state is invalid JSON$/);
    expect(fs.readFileSync(file, "utf8")).toBe(content);
  },
);

it.each(cases)(
  "rejects the $kind parent being replaced while its descriptor is read",
  async (test) => {
    const config = await import("../cloud-workspace-validation/config");
    const file = path.join(root, test.file);
    const content = JSON.stringify(test.value);
    fs.writeFileSync(file, content, { mode: 0o600 });
    race.beforeRead = () => {
      fs.renameSync(root, root + "-moved");
      fs.mkdirSync(root, { mode: 0o700 });
      fs.writeFileSync(file, '{"replacement":true}', { mode: 0o600 });
    };
    const read = () =>
      test.kind === "intent"
        ? config.qualificationAllocationStore.read()
        : test.kind === "snapshot"
          ? config.snapshotAllocationStore.read()
          : test.kind === "attestation"
            ? config.loadSnapshotAttestation(file)
            : config.loadState(file);
    expect(read).toThrow(/unsafe/);
    expect(fs.readFileSync(file, "utf8")).toBe('{"replacement":true}');
    expect(fs.readFileSync(path.join(root + "-moved", test.file), "utf8")).toBe(
      content,
    );
  },
);

it.each(cases)(
  "retains and rejects dangling $kind evidence instead of treating it as absent",
  async (test) => {
    const config = await import("../cloud-workspace-validation/config");
    const file = path.join(root, test.file);
    fs.symlinkSync(path.join(root, "missing.json"), file);
    const read = () =>
      test.kind === "intent"
        ? config.qualificationAllocationStore.read()
        : test.kind === "snapshot"
          ? config.snapshotAllocationStore.read()
          : test.kind === "attestation"
            ? config.loadSnapshotAttestation(file)
            : config.loadState(file);
    // loadState's missing-file CLI exit must not replace refusal of unsafe evidence.
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("unexpected missing-state exit");
    });
    try {
      expect(read).toThrow(/ELOOP|unsafe/);
      expect(exit).not.toHaveBeenCalled();
      expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
      if (test.kind === "attestation")
        expect(config.snapshotAttestationExists(file)).toBe(true);
    } finally {
      exit.mockRestore();
    }
  },
);
