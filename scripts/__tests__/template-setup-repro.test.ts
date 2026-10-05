import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupTemplateSetupFork,
  newTemplateSetupJournal,
  runTemplateSetupRepro,
  readTemplateSetupSource,
  templateSetupForkBody,
  templateSetupReproConfig,
} from "../cloud-workspace-validation/template-setup-repro.mjs";
import {
  safeProbePath,
  sanitizeProbeReport,
} from "../cloud-workspace-validation/template-setup-probe.mjs";

const templateId = "bx_3456789a",
  childId = "bx_23456789";
const deletionId = `bdop_${"d".repeat(32)}`;
const billingOrg = `team_${randomUUID()}`;
function fixture() {
  const journal = newTemplateSetupJournal(randomUUID(), 1, templateId);
  const material = {
    templateId,
    billingOrg,
    baseImageId: "zeros-v2-test-base-v4-fixture",
    image: {
      resources: {
        architecture: "linux/amd64",
        cpuMillicores: 4000,
        memoryMiB: 8192,
        storageMiB: 20480,
      },
    },
  };
  let deleted = false;
  const request = vi.fn(async (pathname: string, input: any = {}) => {
    if (pathname.endsWith("/fork"))
      return { sandboxId: childId, sourceSandboxId: templateId };
    if (pathname.startsWith("/deletion-operations/"))
      return {
        operation: {
          id: deletionId,
          kind: "sandbox",
          targetId: childId,
          status: "completed",
          completedAt: "2026-10-05T00:00:00Z",
        },
      };
    if (input.method === "DELETE") {
      deleted = true;
      return { operation: { id: deletionId, targetId: childId } };
    }
    return {
      sandbox: {
        id: pathname.split("/").at(-1),
        team: { id: billingOrg },
        state: pathname.endsWith(templateId) ? "archived" : "running",
        snapshotAvailable: true,
        lastSnapshotStatus: "completed",
        sourceSandboxId: pathname.endsWith(childId) ? templateId : undefined,
      },
    };
  });
  const saves: string[] = [];
  const dependencies = {
    request,
    load: vi.fn(async () => material),
    ready: vi.fn(async () => {}),
    probe: vi.fn(async () => ({
      schema: "zeros.template-setup-probe/v1",
      checks: [
        {
          check: "template",
          ok: false,
          sites: [
            {
              source: "cloud-computer-checkout.mjs",
              function: "walk",
              line: 104,
            },
          ],
          observed: {
            path: "/srv/zeros/files/repos/example/repo/.git/config",
            uid: 0,
            gid: 0,
            mode: "0644",
            nlink: 1,
            type: "file",
            realpath: "/srv/zeros/files/repos/example/repo/.git/config",
          },
        },
      ],
      paths: [],
    })),
    save: vi.fn((value) => saves.push(JSON.stringify(value))),
    wait: vi.fn(async () => {}),
    attempts: 2,
  };
  return {
    journal,
    material,
    request,
    dependencies,
    saves,
    deleted: () => deleted,
  };
}

describe("operator template setup reproduction", () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)(
    "executes the saved-source query against the migrated local Postgres schema",
    async () => {
      const { Pool } = createRequire(
        new URL("../../apps/control-plane/package.json", import.meta.url),
      )("pg");
      const pool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
        options: "-c default_transaction_read_only=on",
        statement_timeout: 5000,
      });
      try {
        await expect(
          readTemplateSetupSource(
            pool,
            newTemplateSetupJournal(randomUUID(), 1, templateId),
          ),
        ).rejects.toThrow(/^source_invalid$/);
      } finally {
        await pool.end();
      }
    },
  );

  it("uses C5's fork request without inheriting environment and matches the accepted size", () => {
    const f = fixture();
    expect(templateSetupForkBody(f.material)).toEqual({
      type: "default",
      ttlSeconds: 1800,
      noEnv: true,
      env: {},
    });
    expect(() =>
      templateSetupForkBody({
        ...f.material,
        image: { resources: { cpuMillicores: 4000, memoryMiB: 4096 } },
      }),
    ).toThrow(/^source_invalid$/);
  });

  it("reports the failing helper site, then deletes only its recorded fork in finally", async () => {
    const f = fixture();
    const result = await runTemplateSetupRepro(
      f.journal,
      billingOrg,
      f.dependencies,
    );
    expect(result).toMatchObject({
      childId,
      cleanup: "verified",
      failedChecks: ["probe_failed"],
      probe: {
        checks: [
          {
            check: "template",
            ok: false,
            sites: [{ function: "walk", line: 104 }],
          },
        ],
      },
    });
    expect(f.deleted()).toBe(true);
    expect(JSON.parse(f.saves[0]!)).toMatchObject({
      createAttempted: false,
      childId: null,
    });
    expect(f.request).toHaveBeenCalledWith(
      `/sandboxes/${templateId}/fork`,
      expect.objectContaining({
        method: "POST",
        body: { type: "default", ttlSeconds: 1800, noEnv: true, env: {} },
        idempotencyKey: `zeros-v2-test-s1-${f.journal.id}`,
      }),
    );
    expect(f.request).toHaveBeenCalledWith(`/sandboxes/${childId}`, {
      method: "DELETE",
      confirmDelete: childId,
    });
    expect(
      f.request.mock.calls.filter(([, input]) => input?.method === "DELETE"),
    ).toHaveLength(1);
  });

  it("recovers a lost fork reply using the saved key and body before cleanup", async () => {
    const f = fixture(),
      implementation = f.request.getMockImplementation()!;
    let forkCalls = 0;
    f.request.mockImplementation(async (pathname, input) => {
      if (pathname.endsWith("/fork") && ++forkCalls === 1)
        throw new Error("private URL and credential");
      return implementation(pathname, input);
    });
    const result = await runTemplateSetupRepro(
      f.journal,
      billingOrg,
      f.dependencies,
    );
    expect(result).toMatchObject({
      childId,
      cleanup: "verified",
      failedChecks: ["verification_failed"],
    });
    const forks = f.request.mock.calls.filter(([pathname]) =>
      pathname.endsWith("/fork"),
    );
    expect(forks).toHaveLength(2);
    expect(forks[0]).toEqual(forks[1]);
    expect(f.saves.join("\n")).not.toContain("private URL and credential");
  });

  it("never treats the template ID as a disposable child", async () => {
    const f = fixture();
    f.journal.childId = templateId;
    f.journal.createAttempted = true;
    await expect(
      cleanupTemplateSetupFork(f.journal, f.dependencies),
    ).rejects.toThrow(/^child_invalid$/);
    expect(f.request).not.toHaveBeenCalled();
  });

  it("requires a completed deletion receipt for the child, including after readiness fails", async () => {
    const f = fixture(),
      implementation = f.request.getMockImplementation()!;
    f.dependencies.ready.mockRejectedValue(new Error("untrusted stderr"));
    f.request.mockImplementation(async (pathname, input) =>
      pathname.startsWith("/deletion-operations/")
        ? {
            operation: {
              id: deletionId,
              kind: "sandbox",
              targetId: templateId,
              status: "completed",
              completedAt: "2026-10-05T00:00:00Z",
            },
          }
        : implementation(pathname, input),
    );
    const result = await runTemplateSetupRepro(
      f.journal,
      billingOrg,
      f.dependencies,
    );
    expect(result).toMatchObject({
      cleanup: "pending",
      failedChecks: ["verification_failed", "cleanup_pending"],
    });
    expect(f.dependencies.probe).not.toHaveBeenCalled();
    expect(f.saves.join("\n")).not.toContain("untrusted stderr");
  });

  it("accepts credentials only from the Alpha declaration and rejects database routing overrides", () => {
    const database = new URL(
      "postgresql://fixture.psdb.cloud/zeros?sslmode=verify-full",
    );
    database.username = "reader.branch";
    const values = {
      ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-alpha",
      ZEROS_S1_ALPHA_DATABASE_URL: database.toString(),
      BOAT_API_KEY: "synthetic-private-key",
      BOAT_BILLING_ORG: billingOrg,
    };
    expect(templateSetupReproConfig(values)).toMatchObject({
      billingOrg,
      apiKey: values.BOAT_API_KEY,
    });
    for (const changes of [
      { ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-beta" },
      {
        ZEROS_S1_ALPHA_DATABASE_URL:
          values.ZEROS_S1_ALPHA_DATABASE_URL + "&host=other",
      },
    ])
      expect(() => templateSetupReproConfig({ ...values, ...changes })).toThrow(
        /^input_invalid$/,
      );
  });

  it("projects only check names, source sites and safe metadata from probe output", () => {
    const report = sanitizeProbeReport({
      schema: "zeros.template-setup-probe/v1",
      contents: "private contents",
      checks: [
        {
          check: "template",
          ok: false,
          message: "private error",
          sites: [
            {
              source: "cloud-computer-checkout.mjs",
              function: "walk",
              line: 104,
              locals: "private contents",
            },
            { source: "private error", function: "unknown", line: 1 },
          ],
          observed: {
            path: "/srv/zeros/files/repos/example/repo/.git/config",
            uid: 0,
            gid: 0,
            mode: "0644",
            nlink: 1,
            type: "file",
            realpath: "/srv/zeros/files/repos/example/repo/.git/config",
            contents: "private contents",
          },
        },
      ],
      paths: [],
    });
    expect(report.checks[0].sites).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("private");
    expect(safeProbePath("/srv/zeros/ghs_syntheticcredential")).toContain(
      "<redacted>",
    );
    expect(safeProbePath("https://private.invalid/?token=hidden")).toBe(
      "<withheld>",
    );
    expect(
      safeProbePath(`/opt/zeros-infra/r1-${"a".repeat(64)}/lib/zeros`),
    ).toBe("/opt/zeros-infra/<runtime>/lib/zeros");
  });

  it("locates a rejected Git metadata link using the original checkout predicate", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-v2-test-s1-"));
    try {
      const filesRoot = path.join(directory, "files"),
        checkout = path.join(filesRoot, "repos/example/repo");
      mkdirSync(path.join(checkout, ".git"), { recursive: true });
      writeFileSync(
        path.join(checkout, ".git/config-source"),
        "private repository contents",
      );
      symlinkSync("config-source", path.join(checkout, ".git/config"));
      const template = {
        schema: "zeros.computer-template/v1",
        buildId: randomUUID(),
        configId: randomUUID(),
        baseImageId: "zeros-v2-test-base",
        runtimeId: `r1-${"b".repeat(64)}`,
        baseCompatibilityId: `bc1-${"c".repeat(64)}`,
        protectedContractDigest: "d".repeat(64),
        repositoryManifest: [
          { id: "1", owner: "example", name: "repo", sha: "a".repeat(40) },
        ],
      };
      const templateFile = path.join(directory, "computer-template.json");
      writeFileSync(templateFile, JSON.stringify(template), { mode: 0o600 });
      const script = `
        import { installFilesystemTrace, probeFailureSites } from ${JSON.stringify(new URL("../cloud-workspace-validation/template-setup-probe.mjs", import.meta.url).href)};
        const trace = installFilesystemTrace();
        const { verifyCloudComputerTemplate } = await import(${JSON.stringify(new URL("../cloud-workspace-validation/sandbox/cloud-computer-checkout.mjs", import.meta.url).href)});
        const template = ${JSON.stringify(template)};
        try {
          verifyCloudComputerTemplate({ template, primaryRepositoryId: "1", requestedRevision: "main" },
            { owner: "example", name: "repo", revision: "a".repeat(40), cloneUrl: "https://github.com/example/repo.git" },
            { filesRoot: ${JSON.stringify(filesRoot)}, templateFile: ${JSON.stringify(templateFile)}, rootUid: process.getuid(), workerUid: process.getuid(), readMountInfo: () => "" });
          throw new Error("unexpected success");
        } catch (error) { process.stdout.write(JSON.stringify({ sites: probeFailureSites(error), observed: trace.observed() })); }
        finally { trace.restore(); }
      `;
      const output = execFileSync(
        process.execPath,
        ["--input-type=module", "-"],
        { input: script, encoding: "utf8" },
      );
      const result = JSON.parse(output);
      expect(result.sites).toContainEqual({
        source: "cloud-computer-checkout.mjs",
        function: "walk",
        line: 104,
      });
      expect(result.observed).toMatchObject({
        type: "symlink",
        operation: "lstatSync",
        uid: process.getuid!(),
        nlink: 1,
      });
      expect(output).not.toContain("private repository contents");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
