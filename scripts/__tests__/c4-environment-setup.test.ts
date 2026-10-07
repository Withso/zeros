import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runC4SetupProbe } from "../cloud-workspace-validation/c4-environment-setup.mjs";

function fixture(
  options: {
    loseWriteResponse?: number;
    concurrent?: boolean;
    organizationName?: string;
  } = {},
) {
  const config = {
    organizationId: randomUUID(),
    repositoryId: randomUUID(),
    githubRepositoryId: "123",
    adminToken: "synthetic-private-admin",
    memberToken: "synthetic-private-member",
    nonstaffToken: "synthetic-private-nonstaff",
  };
  const original = {
    values: { env: { REGISTRY: "synthetic-private-setting" } },
    setupCommands: [{ command: "old setup", timeoutSeconds: 90 }],
  };
  let current = structuredClone(original),
    revision = 4,
    writes = 0;
  const requests: Array<{ method: string; path: string }> = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe("https://api-alpha.zeros.build");
    expect(init.redirect).toBe("error");
    const path = new URL(url).pathname,
      method = init.method!;
    requests.push({ method, path });
    const json = (document: unknown, status = 200) =>
      new Response(JSON.stringify(document), { status });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (path.endsWith(`/organizations/${config.organizationId}`))
      return json({
        organization: {
          name: options.organizationName ?? "zeros-v2-test-c4",
          isPersonal: false,
        },
      });
    if (path.endsWith("/cloud-computer/v2")) return json({ revision: 8 });
    if (path.endsWith("/settings"))
      return json({
        repositoryId: config.repositoryId,
        scopes: [
          { scope: "cloud", version: revision, document: current },
          {
            scope: "shared",
            version: 1,
            document: { values: { shared: true } },
          },
        ],
      });
    if (path.endsWith("/setup")) {
      if (![`Bearer ${config.adminToken}`, `Bearer ${config.nonstaffToken}`].includes(
        (init.headers as Record<string, string>).authorization,
      ))
        return json({ error: "private-auth-detail" }, 403);
      if (body.expectedSettingsVersion !== revision)
        return json({ error: { code: "cloud_settings_version_conflict", message: "private-cas-detail" } }, 409);
      current = {
        ...current,
        setupCommands: body.script
          ? [{ command: body.script, timeoutSeconds: body.timeoutSeconds }]
          : [],
      };
      revision++;
      writes++;
      if (writes === options.loseWriteResponse) {
        if (options.concurrent) {
          current = {
            ...current,
            setupCommands: [
              { command: "concurrent administrator", timeoutSeconds: 5 },
            ],
          };
          revision++;
        }
        throw new Error(config.adminToken);
      }
      return json({
        repositoryId: config.githubRepositoryId,
        version: revision,
      });
    }
    if (path.endsWith("/settings/cloud")) {
      expect(body.expectedVersion).toBe(revision);
      current = body.document;
      revision++;
      return json({ version: revision });
    }
    throw new Error("unexpected probe route");
  });
  return { config, original, fetcher, requests, current: () => current };
}

describe("Alpha C4 runbook", () => {
  it.each(["private file", "symlink", "public file", "directory", "oversized file", "replaced after inspection"])(
    "reads only the inspected private credential file: %s",
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), "zeros-c4-agent-env-"));
      try {
        const scripts = join(root, "scripts", "cloud-workspace-validation");
        mkdirSync(scripts, { recursive: true });
        const script = join(scripts, "c4-environment-setup.mjs");
        copyFileSync(fileURLToPath(new URL("../cloud-workspace-validation/c4-environment-setup.mjs", import.meta.url)), script);
        writeFileSync(join(root, "scripts", "agent-env-check.mjs"),
          `export { parseAgentEnv } from ${JSON.stringify(new URL("../agent-env-check.mjs", import.meta.url).href)};`);
        const file = join(root, ".env.agent");
        if (kind === "directory") mkdirSync(file, { mode: 0o700 });
        else if (kind === "symlink") {
          writeFileSync(file + ".target", "FIXTURE=synthetic\n", { mode: 0o600 });
          symlinkSync(file + ".target", file);
        } else writeFileSync(file, kind === "oversized file" ? " ".repeat(1024 * 1024 + 1) : "FIXTURE=synthetic\n",
          { mode: kind === "public file" ? 0o644 : 0o600 });
        const args: string[] = [];
        if (kind === "replaced after inspection") {
          const preload = join(root, "race.mjs");
          writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const file = ${JSON.stringify(file)}, descriptors = new Set();
let replaced = false;
function replace() {
  if (replaced) return;
  replaced = true;
  fs.renameSync(file, file + ".opened");
  fs.writeFileSync(file, "invalid dotenv", { mode: 0o600 });
}
const open = fs.openSync, stat = fs.statSync, fstat = fs.fstatSync;
fs.openSync = (path, ...args) => { const fd = open(path, ...args); if (path === file) descriptors.add(fd); return fd; };
fs.statSync = (path, ...args) => { const result = stat(path, ...args); if (path === file) replace(); return result; };
fs.fstatSync = (fd, ...args) => { const result = fstat(fd, ...args); if (descriptors.has(fd)) replace(); return result; };
syncBuiltinESMExports();
`);
          args.push("--import", pathToFileURL(preload).href);
        }
        const result = spawnSync(process.execPath, [...args, script, "--run"], { encoding: "utf8", timeout: 5_000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toBe("");
        // Valid dotenv has no live configuration, so it stops before any HTTP.
        expect(JSON.parse(result.stdout)).toMatchObject({
          passed: false,
          phase: ["private file", "replaced after inspection"].includes(kind) ? "input" : "configuration",
          cleanup: "not-needed",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
  it("restores setup settings and reports only closed checks and resource identities", async () => {
    const f = fixture();
    const report = await runC4SetupProbe(f.config, f.fetcher);
    expect(report).toMatchObject({
      passed: true,
      phase: "complete",
      cleanup: "restored",
      settingsVersions: [5, 6, 7],
    });
    expect(f.current()).toEqual(f.original);
    for (const value of [
      ...Object.values(f.config).filter((value) =>
        value.startsWith("synthetic-"),
      ),
      "synthetic-private-setting",
      "old setup",
    ])
      expect(JSON.stringify(report)).not.toContain(value);
  });
  it.each([1, 2])(
    "restores its own settings after write %s loses its response",
    async (loseWriteResponse) => {
      const f = fixture({ loseWriteResponse });
      const report = await runC4SetupProbe(f.config, f.fetcher);
      expect(report).toMatchObject({ passed: false, cleanup: "restored" });
      expect(report.settingsVersions).toContain(4 + loseWriteResponse);
      expect(f.current()).toEqual(f.original);
      expect(JSON.stringify(report)).not.toContain(f.config.adminToken);
    },
  );
  it("refuses an ordinary organization before any write", async () => {
    const f = fixture({ organizationName: "ordinary organization" });
    expect(await runC4SetupProbe(f.config, f.fetcher)).toMatchObject({
      passed: false,
      phase: "fixture",
      cleanup: "not-needed",
    });
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
  });
  it("reports cleanup required instead of overwriting a concurrent administrator", async () => {
    const f = fixture({ loseWriteResponse: 1, concurrent: true });
    expect(await runC4SetupProbe(f.config, f.fetcher)).toMatchObject({
      passed: false,
      cleanup: "required",
    });
    expect(
      f.requests.some((request) => request.path.endsWith("/settings/cloud")),
    ).toBe(false);
    expect(f.current().setupCommands[0].command).toBe(
      "concurrent administrator",
    );
  });
});
