#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const macosEngineBoundaryProbe = path.join(here, "macos-engine-boundary.ts");
const localHostParityProbe = path.join(here, "local-host-parity.ts");
const packageJsonPath = fileURLToPath(
  new URL(
    "../../node_modules/@anthropic-ai/sandbox-runtime/package.json",
    import.meta.url,
  ),
);
const expectedVersion = "0.0.75";
const args = new Set(process.argv.slice(2));

function result(name, status, detail) {
  return { name, status, ...(detail ? { detail } : {}) };
}

/** The JSON report a fixture wrote, out of a stdout that may also carry engine
 * diagnostics.
 *
 * A fixture builds a real boundary, so the engine legitimately logs while it
 * runs — `[zsr] admitted …` on a slow admission, `[zsr] retired …` on a slow
 * teardown. Requiring stdout to be *nothing but* the report made every such line
 * present as a fence failure with the useless detail "fixture produced no
 * parseable report", and it did exactly that twice on 2026-08-17: first for
 * `macos-detached-process-domain` (attributed at the time to a live dev app, then
 * to transience — both wrong), and again for it plus `macos-dynamic-dev-ports`
 * the moment a retirement report was added. The report is the LAST balanced JSON
 * object on stdout; nothing about the checks themselves is loosened, because the
 * checks are the parsed fields. */
function fixtureReport(stdout) {
  const text = String(stdout ?? "");
  for (let start = text.lastIndexOf("{"); start >= 0; ) {
    const candidate = text.slice(start);
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Not a complete document from here; try the previous opening brace.
    }
    start = text.lastIndexOf("{", start - 1);
  }
  throw new Error("fixture produced no parseable report");
}

/** Why a spawned fixture failed, in a form a human can act on.
 *
 * The old form was `error ?? stderr ?? "fixture exited N"`, and `??` only falls
 * through on null/undefined — so a fixture that exited cleanly with a report
 * whose fields simply did not match produced an EMPTY stderr, an omitted
 * `detail`, and a `--require-secure` failure with no stated reason at all. That
 * happened for real on 2026-08-17. Always say the exit status and what the
 * fixture actually reported. */
function fixtureFailureDetail(spawned, observed) {
  const parts = [
    spawned.error ? safeError(spawned.error) : "",
    `status=${spawned.status === null ? `signal ${spawned.signal}` : spawned.status}`,
    observed ? `observed: ${observed}` : "",
    spawned.stderr ? `stderr: ${safeError(spawned.stderr)}` : "",
  ].filter(Boolean);
  return parts.join("; ").slice(0, 1_000);
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replaceAll(os.homedir(), "<home>")
    .replaceAll(process.cwd(), "<workspace>")
    .slice(0, 1_000);
}

function packagedFixtureEnvironment(cloudWorker = false) {
  return {
    ...process.env,
    ZEROS_ZSR_SUPERVISOR_SCRIPT: path.resolve(
      here,
      "../../binaries/zsr-supervisor.mjs",
    ),
    ZEROS_ZSR_MACOS_PROCESS_DOMAIN_HELPER: path.resolve(
      here,
      "../../binaries/zsr-macos-process-domain",
    ),
    ...(cloudWorker
      ? {
          ZEROS_ZSR_CLOUD_WORKER_CONFIG: "/etc/zeros/cloud-worker.json",
        }
      : {}),
  };
}

async function localHostParityMain(cloudWorker = false) {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const report = {
    schemaVersion: 1,
    runtime: {
      name: packageJson.name,
      version: packageJson.version,
      expectedVersion,
      license: packageJson.license,
    },
    platform: process.platform,
    arch: process.arch,
    backend: cloudWorker ? "cloud-worker+zsr" : "native-code+zsr-design",
    secure: false,
    checks: [
      result(
        "exact-pin",
        packageJson.version === expectedVersion ? "pass" : "fail",
        `${packageJson.name}@${packageJson.version}`,
      ),
      result("license", packageJson.license === "Apache-2.0" ? "pass" : "fail"),
    ],
  };
  if (process.platform !== "darwin" && process.platform !== "linux") {
    report.checks.push(result("platform", "unsupported", process.platform));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (args.has("--require-secure")) process.exitCode = 1;
    return;
  }

  const fixture = spawnSync(
    process.execPath,
    ["--import", "tsx", localHostParityProbe],
    {
      cwd: path.resolve(here, "../.."),
      env: packagedFixtureEnvironment(cloudWorker),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 256 * 1024,
    },
  );
  let observed;
  try {
    observed = fixtureReport(fixture.stdout);
  } catch (error) {
    report.checks.push(
      result(
        "local-host-parity-canary",
        "fail",
        fixtureFailureDetail(fixture, safeError(error)),
      ),
    );
  }
  if (observed) {
    const code = observed.code ?? {};
    const design = observed.design ?? {};
    const all = (value, length, expected) =>
      Array.isArray(value) &&
      value.length === length &&
      value.every((entry) => entry === expected);
    const checks = [
      [
        "actor-boundary-routing",
        cloudWorker
          ? observed.codeBackend === "cloud-worker" &&
            observed.designBackend === "cloud-worker"
          : observed.codeBackend === "none" &&
            observed.designBackend === "zeros-srt",
      ],
      ["host-machine-read", code.hostRead === true],
      ["code-workspace-write", code.codeWrite === true],
      [
        cloudWorker
          ? "cloud-code-design-write-denial"
          : "native-code-has-no-filesystem-fence",
        all(code.designDenied, 3, cloudWorker) &&
          code.markerDenied === cloudWorker,
      ],
      [
        "native-git-all-subcommands",
        code.canonicalGit === true &&
          Array.isArray(code.gitStatuses) &&
          code.gitStatuses.length === 5 &&
          code.gitStatuses.every((status) => status === 0),
      ],
      [
        "native-git-stderr",
        typeof code.rawGitErrors === "string" &&
          !code.rawGitErrors.includes("[zsr"),
      ],
      ["pre-push-hook", observed.prePushHook === true],
      ["real-home", observed.hostHomePreserved === true],
      ["provider-home", observed.providerHomePreserved === true],
      ["gh-token", observed.ghTokenPreserved === true],
      ["github-token", observed.githubTokenPreserved === true],
      ["ssh-agent", observed.sshAgentPreserved === true],
      ["gh-cli", code.ghAvailable === true],
      ["keychain", code.keychainAvailable === true],
      ...(process.platform === "darwin"
        ? cloudWorker
          ? [["macos-apple-events-denial", code.appleEventsDenied === true]]
          : []
        : []),
      [
        cloudWorker
          ? "ambient-container-authority-denial"
          : "native-container-environment",
        cloudWorker
          ? code.ambientContainerSocketDenied === true &&
            code.ambientContainerSelectorsScrubbed === true
          : code.ambientContainerSocketVisible === true &&
            code.ambientContainerSelectorsPreserved === true,
      ],
      [
        "cloud-private-container-workflow",
        !cloudWorker ||
          (observed.cloudContainerBoundary === true &&
            code.privateContainerReady === true),
      ],
      ["direct-local-service", code.directService === true],
      ["direct-agent-port", code.directPort === true],
      ["direct-requested-port", observed.directRequestedPort === true],
      [
        "host-network-environment",
        code.proxyUnchanged === true && code.noNetworkBridge === true,
      ],
      // Named separately from `host-network-environment` (which covers proxy
      // variables only) because TLS trust is what actually breaks `git clone
      // https://…`, `curl`, and `pip install` when the supervisor rewrites it.
      ["host-tls-trust-environment", code.caTrustExact === true],
      // The recognition split. The canvas marker is unwritable because it sits
      // inside protected Design territory; the `.zeros` pointer stays writable
      // because it is committed repository content and denying it broke every
      // `git pull` that had to rewrite it. De-registration is covered by
      // engine-side sticky recognition, which is deliberately NOT a filesystem
      // rule — both halves are asserted so neither can drift silently.
      ["design-marker-boundary-posture", code.markerDenied === cloudWorker],
      ["repo-settings-host-parity-write", code.repoSettingsWritable === true],
      [
        "code-engine-authority-posture",
        cloudWorker
          ? code.engineAuthorityRead === false &&
            all(code.engineAuthorityWriteDenied, 6, true) &&
            all(code.engineAuthorityHardlinkDenied, 6, true)
          : code.engineAuthorityRead === true &&
            all(code.engineAuthorityWriteDenied, 6, false) &&
            all(code.engineAuthorityHardlinkDenied, 6, false),
      ],
      [
        "cloud-worker-identity",
        !cloudWorker ||
          (code.workerIdentity === observed.cloudWorkerUid &&
            design.workerIdentity === observed.cloudWorkerUid),
      ],
      [
        "design-engine-authority-read-denial",
        all(design.engineAuthorityReadDenied, 6, true),
      ],
      [
        "design-engine-authority-durable-write-denial",
        observed.designEngineAuthorityPreserved === true,
      ],
      [
        "design-engine-authority-hardlink-denial",
        all(design.engineAuthorityHardlinkDenied, 6, true),
      ],
      // The one case a matching Design tree hides: git itself writing a protected
      // path. Refused on that path, with the bytes intact.
      [
        "design-git-restore-denial",
        cloudWorker
          ? code.designRestoreRefused === true &&
            code.designRestoreBytes === '{"mode":"code-protected-v2"}\n'
          : code.designRestoreRefused === false &&
            code.designRestoreBytes === '{"mode":"code-protected"}\n',
      ],
      ["design-code-read", design.codeReadable === true],
      ["design-context-read", design.designReadable === true],
      ["design-code-write-denial", design.codeDenied === true],
      [
        "design-directory-write-denial",
        design.primaryDenied === true && design.secondaryDenied === true,
      ],
      ["design-outside-write-denial", design.outsideDenied === true],
      [
        "design-git-metadata-write-denial",
        design.gitDirectoryWriteDenied === true,
      ],
      [
        "design-canonical-git-write-denial",
        design.canonicalGitWriteDenied === true,
      ],
      ["design-scratch-write", design.scratchWrite === true],
      ["design-provider-state-write", all(design.providerStateWrites, 4, true)],
      ["design-preserves-code", observed.codeFileUnchangedByDesign === true],
      [
        "local-admission-fast-path",
        Number.isFinite(observed.codeAdmissionMs) &&
          Number.isFinite(observed.designAdmissionMs),
      ],
    ];
    const detailFor = (name) => {
      if (name === "local-admission-fast-path") {
        return `code=${observed.codeAdmissionMs}ms design=${observed.designAdmissionMs}ms`;
      }
      if (
        name === "native-git-all-subcommands" &&
        (!Array.isArray(code.gitStatuses) ||
          code.gitStatuses.some((status) => status !== 0))
      ) {
        return `statuses=${JSON.stringify(code.gitStatuses)} stderr=${safeError(
          code.rawGitErrors ?? "",
        )}`;
      }
      // Name the variables, not just the verdict: the failure this check exists
      // for is a rewritten TLS-trust path, and "which one" is the whole
      // remediation. Values are engine/host paths, never credentials.
      if (
        name === "host-tls-trust-environment" &&
        Array.isArray(code.caTrustDrift) &&
        code.caTrustDrift.length > 0
      ) {
        return code.caTrustDrift.slice(0, 16).join(" ");
      }
      return undefined;
    };
    for (const [name, passed] of checks) {
      report.checks.push(
        result(
          name,
          fixture.status === 0 && passed ? "pass" : "fail",
          detailFor(name),
        ),
      );
    }
  }

  if (process.platform === "darwin") {
    const lifecycle = spawnSync(
      process.execPath,
      ["--import", "tsx", macosEngineBoundaryProbe],
      {
        cwd: path.resolve(here, "../.."),
        env: packagedFixtureEnvironment(cloudWorker),
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 128 * 1024,
      },
    );
    let passed = false;
    let detail = "";
    try {
      const lifecycleReport = fixtureReport(lifecycle.stdout);
      passed =
        lifecycle.status === 0 &&
        lifecycleReport.normalTeardown === true &&
        lifecycleReport.crashRecovery === true &&
        lifecycleReport.recovered === 1;
      detail =
        `normalTeardown=${lifecycleReport.normalTeardown} ` +
        `crashRecovery=${lifecycleReport.crashRecovery} ` +
        `recovered=${lifecycleReport.recovered}`;
    } catch (error) {
      detail = safeError(error);
    }
    report.checks.push(
      result(
        "macos-detached-process-domain",
        passed ? "pass" : "fail",
        passed ? undefined : fixtureFailureDetail(lifecycle, detail),
      ),
    );
  } else {
    report.checks.push(result("macos-detached-process-domain", "not-required"));
  }

  report.secure = report.checks.every((check) =>
    ["pass", "not-required"].includes(check.status),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.has("--require-secure") && !report.secure) process.exitCode = 1;
}

await localHostParityMain(args.has("--cloud-worker")).catch((error) => {
  process.stderr.write(safeError(error) + "\n");
  process.exitCode = 1;
});
