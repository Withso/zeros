import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
  runTemplateSetupProbe,
  readTemplateSetupSource,
  templateSetupErrorDiagnostic,
  templateSetupForkBody,
  templateSetupReproConfig,
} from "../cloud-workspace-validation/template-setup-repro.mjs";
import {
  safeProbePath,
  sanitizeProbeReport,
  serializeProbeReport,
  summarizeQualification,
  sanitizeLauncherError,
  qualificationResult,
  collectProbeDirectories,
  runQualificationDiagnostics,
} from "../cloud-workspace-validation/template-setup-probe.mjs";
import { CloudProviderError } from "../../apps/control-plane/src/cloud-workspaces/provider";

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
    if (deleted && pathname === `/sandboxes/${childId}`)
      throw new CloudProviderError(
        "provider_not_found",
        "private provider body",
        false,
        { httpStatus: 404 },
      );
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
    diagnose: vi.fn(),
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
  it("reads source as the operator role without requiring membership in zeros_app", async () => {
    const query = vi.fn(async (sql: string) => {
      if (/SET\s+LOCAL\s+ROLE/i.test(sql))
        throw Object.assign(new Error("permission denied to set role"), {
          code: "42501",
        });
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };
    await expect(
      readTemplateSetupSource(pool, fixture().journal),
    ).rejects.toThrow(/^source_invalid$/);
    expect(
      query.mock.calls
        .map(([sql]) => sql)
        .some((sql) => /SET\s+LOCAL\s+ROLE/i.test(sql)),
    ).toBe(false);
    expect(query.mock.calls[0]?.[0]).toBe("BEGIN READ ONLY");
    expect(query.mock.calls[1]?.[0]).toBe(
      "SELECT set_config('app.system', 'on', true)",
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

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

  it.each([
    "waiting_for_uploads",
    "kept_for_newer_snapshots",
    "waiting_for_restore",
  ])(
    "confirms compute release with a %s storage receipt and child 404",
    async (stage) => {
      const f = fixture(),
        implementation = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (pathname, input) =>
        pathname.startsWith("/deletion-operations/")
          ? {
              operation: {
                id: deletionId,
                kind: "sandbox",
                targetId: childId,
                status: "blocked",
                stage,
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
        cleanup: "verified",
        cleanupStorageStage: stage,
        failedChecks: ["probe_failed"],
      });
      expect(
        f.request.mock.calls.some(
          ([pathname, input]) =>
            pathname === `/sandboxes/${childId}` && !input?.method,
        ),
      ).toBe(true);
    },
  );

  it.each([
    { status: "blocked", stage: "unknown_stage", absent: true },
    { status: "blocked", stage: "waiting_for_uploads", absent: false },
    { status: "completed", completedAt: "2026-10-05T00:00:00Z", absent: false },
  ])(
    "keeps cleanup pending without qualified receipt and child absence: %j",
    async ({ absent, ...operation }) => {
      const f = fixture(),
        implementation = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (pathname, input) => {
        if (pathname.startsWith("/deletion-operations/"))
          return {
            operation: {
              id: deletionId,
              kind: "sandbox",
              targetId: childId,
              ...operation,
            },
          };
        if (!absent && pathname === `/sandboxes/${childId}` && !input?.method)
          return { sandbox: { id: childId, state: "deleting" } };
        return implementation(pathname, input);
      });
      const result = await runTemplateSetupRepro(
        f.journal,
        billingOrg,
        f.dependencies,
      );
      expect(result).toMatchObject({
        cleanup: "pending",
        failedChecks: ["probe_failed", "cleanup_pending"],
      });
    },
  );

  it("uses B4's sudo Python transport over the commands API with a bounded response", async () => {
    const f = fixture(),
      report = await f.dependencies.probe();
    const request = vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdout: JSON.stringify(report),
      timedOut: false,
      stdoutTruncated: false,
    }));
    expect(
      await runTemplateSetupProbe(childId, f.material, { request }),
    ).toEqual(report);
    const [pathname, input] = request.mock.calls[0]! as any;
    expect(pathname).toBe(`/sandboxes/${childId}/commands`);
    expect(input.method).toBe("POST");
    expect(input.timeoutMs).toBe(510000);
    expect(input.body.timeoutSeconds).toBe(480);
    expect(
      input.body.command.startsWith(
        "/usr/bin/sudo -n /usr/bin/python3 -I - <<'PYV4'\n",
      ),
    ).toBe(true);
    expect(Buffer.byteLength(input.body.command)).toBeLessThanOrEqual(65536);
    expect(Object.hasOwn(input, "stdin")).toBe(false);
    const program = input.body.command.split("\n").slice(1, -1).join("\n");
    const decoded = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
import ast,json,pathlib,sys
tree=ast.parse(sys.stdin.read())
assignment=next(node for node in ast.walk(tree) if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='data' for target in node.targets))
data=json.loads(ast.literal_eval(assignment.value.args[0]))
source=pathlib.Path('scripts/cloud-workspace-validation/template-setup-probe.mjs').read_text()
qualification=pathlib.Path('scripts/cloud-workspace-validation/template-setup-qualification.py').read_text()
ast.parse(data['qualificationSource'])
print(json.dumps({'sourceMatches':data['source']==source,'qualificationMatches':data['qualificationSource']==qualification,'cpu':data['material']['image']['resources']['cpuMillicores']}))
`,
      ],
      { input: program, encoding: "utf8" },
    );
    expect(JSON.parse(decoded)).toEqual({
      sourceMatches: true,
      qualificationMatches: true,
      cpu: 4000,
    });
    for (const invalid of [
      { success: false },
      { exitCode: 1 },
      { timedOut: true },
      { stdoutTruncated: true },
      { stdout: "x".repeat(65537) },
    ]) {
      request.mockResolvedValueOnce({
        success: true,
        exitCode: 0,
        stdout: JSON.stringify(report),
        timedOut: false,
        stdoutTruncated: false,
        ...invalid,
      });
      await expect(
        runTemplateSetupProbe(childId, f.material, { request }),
      ).rejects.toThrow(/^probe_invalid$/);
    }
  });

  it("bounds snapshot output while retaining the first failing check and its metadata", async () => {
    const report = await fixture().dependencies.probe();
    const longPath = `/srv/zeros/${"directory/".repeat(390)}file`;
    const output = serializeProbeReport({
      ...report,
      paths: Array.from({ length: 100 }, () => ({
        path: longPath,
        realpath: longPath,
        uid: 0,
        gid: 0,
        mode: "0755",
        type: "directory",
      })),
    });
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65536);
    expect(JSON.parse(output).checks).toEqual(report.checks);
    expect(JSON.parse(output).paths.length).toBeGreaterThan(0);
    expect(JSON.parse(output).paths.length).toBeLessThan(100);
  });

  it("retains detailed qualification checks and redacts bounded section errors", () => {
    const token = ["ghs", "syntheticqualificationcredential"].join("_");
    const document = {
      version: 1,
      secure: false,
      identity: {
        secure: true,
        hostUid: 10003,
        namespaceUid: 0,
        noNewPrivs: 1,
        seccompMode: 2,
        checks: [{ name: "worker-file-ownership-preserved", status: "pass" }],
        contents: "private file contents",
      },
      workload: {
        secure: false,
        error: `${"diagnostic ".repeat(300)}Bearer ${token} https://private.invalid unix:///run/private.sock BOAT_API_KEY=${token}`,
        contents: "private file contents",
      },
      capture: null,
      humanServices: {
        secure: false,
        error: "Cloud human service qualification failed",
      },
      actorTools: {
        secure: false,
        error: "Cloud actor tool qualification failed",
      },
      contents: "private file contents",
    };
    const summary = summarizeQualification(document);
    const python = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
import importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('probe','scripts/cloud-workspace-validation/template-setup-qualification.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps(module.summarize(json.loads(sys.stdin.read()))))
`,
      ],
      { input: JSON.stringify(document), encoding: "utf8" },
    );
    expect(JSON.parse(python)).toEqual(summary);
    expect(summary).toMatchObject({
      secure: false,
      identity: {
        secure: true,
        hostUid: 10003,
        checks: [{ name: "worker-file-ownership-preserved", status: "pass" }],
      },
      workload: { secure: false },
      capture: null,
    });
    expect(summary.workload.error.length).toBeLessThanOrEqual(2000);
    expect(JSON.stringify(summary)).not.toContain(token);
    expect(JSON.stringify(summary)).not.toContain("://");
    expect(JSON.stringify(summary)).not.toContain("private file contents");
    expect(summarizeQualification(summary)).toEqual(summary);
    const projected = sanitizeProbeReport({
      schema: "zeros.template-setup-probe/v1",
      checks: [
        {
          check: "image",
          ok: false,
          qualification: { exitCode: 1, timedOut: false, report: summary },
        },
      ],
      paths: [],
    });
    expect(projected.checks[0].qualification.report).toEqual(summary);
  });

  it("retains a closed launcher exception when qualification throws before producing a report", () => {
    const safe = sanitizeLauncherError(
      Object.assign(new Error("Unexpected cloud engine mount contents"), {
        contents: "private file contents",
      }),
    );
    expect(safe).toEqual({
      name: "Error",
      message: "Unexpected cloud engine mount contents",
    });
    expect(
      sanitizeLauncherError({
        name: "private credential",
        message: "private credential",
        code: "private credential",
      }),
    ).toEqual({ name: "UnknownError", message: "<withheld>" });
    const result = qualificationResult({
      status: 125,
      stdout: "",
      stderr:
        JSON.stringify({
          schema: "zeros.template-setup-launcher-error/v1",
          ...safe,
        }) + "\n",
    });
    expect(result).toEqual({
      exitCode: 125,
      timedOut: false,
      outputLimit: false,
      report: null,
      launcherError: safe,
    });
    const projected = sanitizeProbeReport({
      schema: "zeros.template-setup-probe/v1",
      checks: [{ check: "image", ok: false, qualification: result }],
      paths: [],
    });
    expect(projected.checks[0].qualification.launcherError).toEqual(safe);
  });

  it("runs B4's network-isolated qualifier and requests launch_detail only when no report exists", () => {
    const execute = vi
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({ exitCode: 125, report: null }),
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          exitCode: 125,
          report: null,
          launcherError: {
            name: "Error",
            message: "Unexpected cloud engine mount contents",
          },
        }),
      });
    const runtime = { root: `/opt/zeros-infra/r1-${"a".repeat(64)}` };
    const result = runQualificationDiagnostics(runtime, {
      execute,
      now: () => 0,
      deadlineMs: 400000,
    });
    expect(result.launchDetail.launcherError.message).toBe(
      "Unexpected cloud engine mount contents",
    );
    expect(execute.mock.calls.map(([, args]) => args.at(-2))).toEqual([
      "qualify",
      "launch_detail",
    ]);
    expect(execute.mock.calls[0]![0]).toBe("/usr/bin/python3");
    const assertions = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
import ast,importlib.util,json,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('probe','scripts/cloud-workspace-validation/template-setup-qualification.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
calls=[]
def capture(command,environment,timeout):
 calls.append((command,environment,timeout));return {'exitCode':125,'timedOut':False,'outputLimit':False,'stdout':'','stderr':''}
module.capture=capture
module.qualify('/opt/zeros-infra/fixture','/run/zeros/zeros-v2-test-s1-home',False,'/run/zeros/probe.mjs',330)
module.qualify('/opt/zeros-infra/fixture','/run/zeros/zeros-v2-test-s1-home',True,'/run/zeros/probe.mjs',330)
tree=ast.parse(calls[1][0][-1])
invocation=next(node for node in ast.walk(tree) if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='execve')
detail=ast.literal_eval(invocation.args[1])[-1]
print(json.dumps({'network':all(c[0][:3]==['/usr/bin/unshare','--net','--'] for c in calls),
 'loopback':all('fcntl.ioctl' in c[0][-1] and "b'lo'" in c[0][-1] for c in calls),
 'minimalEnv':all(set(c[1])=={'PATH','LANG','HOME','TMPDIR'} for c in calls),
 'detail':"operation:'qualify'" in detail and 'sanitizeLauncherError(e)' in detail and '.stack' not in detail}))
`,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(assertions)).toEqual({
      network: true,
      loopback: true,
      minimalEnv: true,
      detail: true,
    });
    execute.mockReset().mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        exitCode: 1,
        report: {
          version: 1,
          secure: false,
          identity: { secure: false, checks: [] },
        },
      }),
    });
    expect(
      runQualificationDiagnostics(runtime, {
        execute,
        now: () => 0,
        deadlineMs: 400000,
      }).report.identity.secure,
    ).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("lists only fixed directory names and metadata, bounded to 64 entries without following links", () => {
    const listed: string[] = [];
    const filesystem = {
      lstatSync: vi.fn((file: string) => ({
        uid: 0,
        gid: 0,
        mode: 0o40755,
        nlink: 1,
        isDirectory: () => file === "/run/zeros",
        isFile: () => file !== "/run/zeros" && file.startsWith("/run/zeros/"),
        isSymbolicLink: () => file === "/srv/zeros/home",
      })),
      realpathSync: vi.fn((file: string) => file),
      opendirSync: vi.fn((file: string) => {
        listed.push(file);
        let index = 0;
        return {
          readSync: () => (index < 100 ? { name: `entry-${index++}` } : null),
          closeSync: vi.fn(),
        };
      }),
      readFileSync: vi.fn(() => {
        throw new Error("file contents must never be read");
      }),
    };
    const directories = collectProbeDirectories({ filesystem });
    expect(directories).toHaveLength(14);
    expect(listed).toEqual(["/run/zeros"]);
    expect(filesystem.readFileSync).not.toHaveBeenCalled();
    const listing = directories.find((item) => item.path === "/run/zeros");
    expect(listing).toMatchObject({
      truncated: true,
      entries: expect.any(Array),
    });
    expect(listing.entries).toHaveLength(64);
    expect(listing.entries[0]).toMatchObject({
      name: "entry-0",
      uid: 0,
      gid: 0,
      mode: "0755",
    });
    expect(listing.entries[0]).not.toHaveProperty("contents");
    expect(listing.entries[0]).not.toHaveProperty("path");
    expect(
      sanitizeProbeReport({
        schema: "zeros.template-setup-probe/v1",
        checks: [{ check: "image", ok: false }],
        paths: [],
        directories,
      }).directories,
    ).toEqual(directories);
  });

  it("keeps all directory headers and failure evidence within the commands API stdout budget", () => {
    const directories = collectProbeDirectories({
      filesystem: {
        lstatSync: () => ({
          uid: 0,
          gid: 0,
          mode: 0o40755,
          nlink: 1,
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        }),
        realpathSync: (file: string) => file,
        opendirSync: () => {
          let index = 0;
          return {
            readSync: () =>
              index < 64 ? { name: `${"entry.".repeat(40)}-${index++}` } : null,
            closeSync: () => {},
          };
        },
      },
    });
    const output = serializeProbeReport({
      schema: "zeros.template-setup-probe/v1",
      checks: [
        {
          check: "image",
          ok: false,
          sites: [
            {
              source: "attest-cloud-worker.mjs",
              function: "runV4Probe",
              line: 886,
            },
          ],
        },
      ],
      paths: [],
      directories,
    });
    const report = JSON.parse(output);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(65536);
    expect(report.directories).toHaveLength(14);
    expect(report.directories.every((item) => item.entries.length <= 64)).toBe(
      true,
    );
    expect(report.directories.some((item) => item.truncated)).toBe(true);
    expect(report.checks[0].sites[0]).toMatchObject({
      function: "runV4Probe",
      line: 886,
    });
  });

  it.each(["DatabaseError", "error"])(
    "emits closed %s phase diagnostics including SQLSTATE without messages or arbitrary codes",
    async (name) => {
      const f = fixture();
      f.dependencies.load.mockRejectedValue(
        Object.assign(new Error("private URL and credential"), {
          name,
          code: "42501",
        }),
      );
      await runTemplateSetupRepro(f.journal, billingOrg, f.dependencies);
      expect(f.dependencies.diagnose).toHaveBeenCalledWith(
        "source",
        expect.objectContaining({ code: "42501" }),
      );
      expect(
        templateSetupErrorDiagnostic(
          "source",
          f.dependencies.diagnose.mock.calls[0]![1],
        ),
      ).toEqual({
        schema: "zeros.template-setup-error/v1",
        phase: "source",
        name,
        sqlstate: "42501",
      });
      expect(
        templateSetupErrorDiagnostic(
          "probe",
          new CloudProviderError(
            "provider_request_failed",
            "private provider body",
            true,
          ),
        ),
      ).toMatchObject({
        name: "CloudProviderError",
        code: "provider_request_failed",
      });
      expect(
        JSON.stringify(
          templateSetupErrorDiagnostic("private URL", {
            name: "private credential",
            code: "private credential",
            check: "private credential",
            message: "private credential",
          }),
        ),
      ).not.toContain("private");
    },
  );

  it("prints a closed top-level diagnostic for invalid CLI input", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve(
          "scripts/cloud-workspace-validation/template-setup-repro.mjs",
        ),
        "--invalid",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schema: "zeros.template-setup-error/v1",
      phase: "top_level",
      name: "Error",
      code: "input_invalid",
    });
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
        ZEROS_S1_ALPHA_DATABASE_URL: values.ZEROS_S1_ALPHA_DATABASE_URL.replace(
          "verify-full",
          "require",
        ),
      },
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
