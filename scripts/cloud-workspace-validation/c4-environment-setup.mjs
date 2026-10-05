#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parseAgentEnv } from "../agent-env-check.mjs";

const API = "https://api-alpha.zeros.build";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const version = (value) => Number.isSafeInteger(value) && value >= 0;
const required = (condition) => {
  if (!condition) throw new Error("C4 probe rejected");
};

/** This probe uses a prepared, disposable Alpha org/repository. It creates no
 * compute, credentials, secrets, builds or templates. Setup writes are restored
 * with CAS in finally; append-only version/audit rows belong to fixture cleanup.
 * No response document or exception text is ever a diagnostic. */
export async function runC4SetupProbe(config, requestFetch = fetch) {
  const report = {
    version: 1,
    passed: false,
    phase: "input",
    cleanup: "not-needed",
    checks: [],
    organizationId: null,
    repositoryId: null,
    githubRepositoryId: null,
    operationIds: [],
    settingsVersions: [],
  };
  let before,
    expected,
    writeAttempted = false;
  const ownedVersions = new Map();
  const settingsPath = `/v1/organizations/${config.organizationId}/cloud-workspace-management/repositories/${config.repositoryId}/settings`;
  const computerPath = `/v1/organizations/${config.organizationId}/cloud-computer/v2`;
  const setupPath = `${computerPath}/repositories/${config.githubRepositoryId}/setup`;
  const request = async (path, token, method = "GET", body) => {
    const response = await requestFetch(API + path, {
      method,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (
      !response.body ||
      Number(response.headers.get("content-length") ?? 0) > 1024 * 1024
    ) {
      await response.body?.cancel().catch(() => {});
      required(false);
    }
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        required(size <= 1024 * 1024);
        chunks.push(value);
      }
      return {
        status: response.status,
        document: JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
      };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  const read = async () => {
    const response = await request(settingsPath, config.adminToken);
    required(
      response.status === 200 &&
        response.document.repositoryId === config.repositoryId &&
        Array.isArray(response.document.scopes),
    );
    const cloud = response.document.scopes.find(
      (scope) => scope.scope === "cloud",
    );
    // Start from an existing fixture version so cleanup can restore its exact
    // document without creating a previously absent settings owner.
    required(
      cloud &&
        version(cloud.version) &&
        cloud.version > 0 &&
        object(cloud.document),
    );
    return {
      cloud,
      shared: response.document.scopes.filter(
        (scope) => scope.scope !== "cloud",
      ),
    };
  };
  const input = (expectedSettingsVersion, script) => {
    const operationId = randomUUID();
    report.operationIds.push(operationId);
    return { expectedSettingsVersion, operationId, script, timeoutSeconds: 30 };
  };
  const withoutCommands = (document) => {
    const { setupCommands: _commands, ...other } = document;
    return other;
  };
  try {
    required(
      uuid.test(config.organizationId) &&
        uuid.test(config.repositoryId) &&
        /^[1-9][0-9]{0,39}$/.test(config.githubRepositoryId),
    );
    required(
      [config.adminToken, config.memberToken, config.nonstaffToken].every(
        (token) => typeof token === "string" && token.length > 0,
      ),
    );
    report.organizationId = config.organizationId;
    report.repositoryId = config.repositoryId;
    report.githubRepositoryId = config.githubRepositoryId;
    report.phase = "fixture";
    const org = await request(
      `/v1/organizations/${config.organizationId}`,
      config.adminToken,
    );
    required(
      org.status === 200 &&
        org.document.organization?.name?.startsWith("zeros-v2-test-") &&
        org.document.organization.isPersonal === false,
    );
    before = await read();
    const computer = await request(computerPath, config.adminToken);
    required(computer.status === 200 && version(computer.document.revision));
    report.phase = "authority";
    for (const [label, token] of [
      ["member403", config.memberToken],
      ["nonstaff403", config.nonstaffToken],
    ]) {
      required(
        (
          await request(
            setupPath,
            token,
            "PUT",
            input(Number.MAX_SAFE_INTEGER, ""),
          )
        ).status === 403,
      );
      report.checks.push(label);
    }
    report.phase = "setup-write";
    const script = `printf 'zeros-v2-test-c4-${randomUUID()}\\n'`;
    expected = {
      ...before.cloud.document,
      setupCommands: [{ command: script, timeoutSeconds: 30 }],
    };
    ownedVersions.set(before.cloud.version + 1, expected);
    writeAttempted = true;
    const saved = await request(
      setupPath,
      config.adminToken,
      "PUT",
      input(before.cloud.version, script),
    );
    required(
      saved.status === 200 &&
        saved.document.version === before.cloud.version + 1 &&
        saved.document.repositoryId === config.githubRepositoryId,
    );
    report.settingsVersions.push(saved.document.version);
    const current = await read();
    required(
      current.cloud.version === saved.document.version &&
        isDeepStrictEqual(current.cloud.document, expected) &&
        isDeepStrictEqual(current.shared, before.shared),
    );
    required(
      isDeepStrictEqual(
        withoutCommands(current.cloud.document),
        withoutCommands(before.cloud.document),
      ),
    );
    report.checks.push("staffAdmin", "preservesOtherValues");
    report.phase = "cas";
    required(
      (
        await request(
          setupPath,
          config.adminToken,
          "PUT",
          input(before.cloud.version, ""),
        )
      ).status === 409,
    );
    report.checks.push("casConflict");
    report.phase = "disable";
    const disabled = { ...expected, setupCommands: [] };
    // Keep both owned documents for cleanup if a successful write loses its response.
    ownedVersions.set(saved.document.version + 1, disabled);
    const result = await request(
      setupPath,
      config.adminToken,
      "PUT",
      input(saved.document.version, ""),
    );
    required(
      result.status === 200 &&
        result.document.version === saved.document.version + 1,
    );
    report.settingsVersions.push(result.document.version);
    required(isDeepStrictEqual((await read()).cloud.document, disabled));
    const afterComputer = await request(computerPath, config.adminToken);
    required(
      afterComputer.status === 200 &&
        afterComputer.document.revision === computer.document.revision,
    );
    report.checks.push("disabled", "noComputerRevisionChange");
    report.passed = true;
    report.phase = "complete";
  } catch {
    /* The closed phase is the diagnostic; never return upstream text. */
  } finally {
    if (writeAttempted) {
      report.cleanup = "required";
      try {
        const current = await read();
        if (isDeepStrictEqual(current.cloud.document, before.cloud.document))
          report.cleanup = "restored";
        else {
          required(
            ownedVersions.has(current.cloud.version) &&
              isDeepStrictEqual(
                current.cloud.document,
                ownedVersions.get(current.cloud.version),
              ),
          );
          if (!report.settingsVersions.includes(current.cloud.version))
            report.settingsVersions.push(current.cloud.version);
          const restored = await request(
            `${settingsPath}/cloud`,
            config.adminToken,
            "PUT",
            {
              expectedVersion: current.cloud.version,
              document: before.cloud.document,
            },
          );
          required(
            restored.status === 200 && version(restored.document.version),
          );
          report.settingsVersions.push(restored.document.version);
          const confirmed = await read();
          required(
            isDeepStrictEqual(
              confirmed.cloud.document,
              before.cloud.document,
            ) && isDeepStrictEqual(confirmed.shared, before.shared),
          );
          report.cleanup = "restored";
        }
      } catch {
        report.passed = false;
      }
    }
  }
  return report;
}

async function main() {
  if (process.argv.slice(2).join(" ") !== "--run") {
    process.stdout.write(
      "Usage: node scripts/cloud-workspace-validation/c4-environment-setup.mjs --run\nSee docs/cloud-workspace/computer-environment.md for Alpha fixture and cleanup requirements.\n",
    );
    process.exitCode = 2;
    return;
  }
  try {
    const file = fileURLToPath(new URL("../../.env.agent", import.meta.url));
    const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let parsed;
    try {
      const stat = fstatSync(descriptor);
      required(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size > 0 && stat.size <= 1024 * 1024);
      parsed = parseAgentEnv(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
    required(
      parsed.malformedLines.length === 0 && parsed.duplicateKeys.length === 0,
    );
    const get = (name) => parsed.values.get(`ZEROS_C4_ALPHA_${name}`);
    const report = await runC4SetupProbe({
      organizationId: get("ORGANIZATION_ID"),
      repositoryId: get("REPOSITORY_ID"),
      githubRepositoryId: get("GITHUB_REPOSITORY_ID"),
      adminToken: get("ADMIN_TOKEN"),
      memberToken: get("MEMBER_TOKEN"),
      nonstaffToken: get("NONSTAFF_TOKEN"),
    });
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exitCode = report.passed ? 0 : 1;
  } catch {
    process.stdout.write(
      '{"version":1,"passed":false,"phase":"configuration","cleanup":"not-needed"}\n',
    );
    process.exitCode = 1;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
