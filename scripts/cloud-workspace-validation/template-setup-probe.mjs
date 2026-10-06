// Operator-only payload, copied into the disposable fork's private /run tree.
// Import the installed helpers; never replace a runtime file or change a gate.
import {
  createRequire,
  registerHooks,
  syncBuiltinESMExports,
} from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url),
  fs = require("node:fs"),
  processes = require("node:child_process");
const native = Object.fromEntries(
  [
    "lstatSync",
    "realpathSync",
    "openSync",
    "fstatSync",
    "readFileSync",
    "readdirSync",
    "opendirSync",
    "closeSync",
  ].map((name) => [name, fs[name]]),
);
const CHECKS = new Set([
  "runtime",
  "runtime_pin",
  "host_profile",
  "setup_directory",
  "supervisor",
  "template",
  "admission",
  "admission_roundtrip",
  "credential_residue",
  "v4_installation",
  "image",
]);
const SOURCES = new Set([
  "cloud-computer-checkout.mjs",
  "cloud-runtime-root.mjs",
  "cloud-runtime-profile.mjs",
  "setup-cloud-workspace.mjs",
  "attest-cloud-worker.mjs",
  "cloud-setup-process.mjs",
  "cloud-engine-cgroup.mjs",
  "cloud-engine-launcher.mjs",
]);
const GATES = new Set([
  "execution",
  "report",
  "profile",
  "qualified",
  "metadata",
  "helpers",
  "resources",
  "runtime",
]);
const V4_CHECKS = new Set([
  "active_descriptor",
  "host_marker",
  "installer_receipt",
  "receipt_digest",
  "manifest_digest",
  "manifest_schema",
  "base_compatibility",
  "root_ownership",
  "file_mode",
  "file_inventory",
  "hard_link",
  "symlink_escape",
  "boot_identity",
  "namespace_binding",
  "uid_map",
  "apparmor",
  "cgroup_controllers",
  "finite_resources",
  "containment_smoke",
  "seccomp",
  "setup_exit",
  "input_schema",
  "lock_busy",
  "launch_proof",
  "pointer_publish",
  "timeout",
  "process_signal",
  "diagnostic_missing",
]);
const STAGES = new Set([
  "validate_input",
  "lock",
  "verify_tree",
  "qualify_engine",
  "run_setup",
  "publish_proof",
  "consume_proof",
  "done",
]);
const OPERATIONS = new Set(Object.keys(native));
const DIRECTORY_ROOTS = [
  "/srv/zeros/files/home",
  "/srv/zeros/files/home/agent",
  "/srv/zeros/files/home/capture",
  "/srv/zeros/files/state",
  "/srv/zeros/files/managed-settings",
  "/srv/zeros/files/.zeros-setup",
  "/srv/zeros/state",
  "/srv/zeros/home",
  "/srv/zeros/home/agent",
  "/srv/zeros/home/capture",
  "/srv/zeros/managed-settings",
  "/srv/zeros/runtime-installs",
  "/run/zeros",
  "/opt/zeros/sessions",
];
const QUALIFICATION_SECTIONS = [
  "identity",
  "workload",
  "capture",
  "humanServices",
  "actorTools",
];
const LAUNCHER_NAMES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "OSError",
  "FileNotFoundError",
  "PermissionError",
  "ValueError",
  "AssertionError",
]);
const LAUNCHER_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "EEXIST",
  "ENOTDIR",
  "ELOOP",
  "ENOSPC",
  "EIO",
  "ETIMEDOUT",
  "ENOBUFS",
  "EPIPE",
  "ERR_MODULE_NOT_FOUND",
  "ERR_INVALID_ARG_TYPE",
  "ERR_DLOPEN_FAILED",
]);
const LAUNCHER_MESSAGES = new Set([
  "image_contract_invalid",
  "repository_revision_invalid",
  "Cloud runtime descriptor or installation is invalid",
  "Invalid cloud setup process document",
  "probe_command_failed",
  "Noncanonical cloud launch source",
  "Unsafe cloud launch source",
  "Unexpected cloud engine file projection",
  "Unsafe cloud repository projection",
  "Unsafe cloud launch state directory",
  "Unsafe cloud launch document",
  "Cloud launch document is too large",
  "Unsupported cloud kernel parameter",
  "Unsupported cloud user namespace restriction",
  "Unsupported cloud kernel identity map",
  "Unsafe cloud computer repository parent",
  "Unexpected cloud computer repository projection",
  "Unsafe cloud computer repository projection",
  "Isolated cloud engine profile required",
  "Invalid cloud engine scope identity",
  "Unexpected cloud engine mount contents",
  "Unsafe cloud primary mount target",
  "Unsupported kernel overflow identity",
  "Invalid cloud disk epoch",
  "Cloud engine child could not start",
  "Cloud engine launch was cancelled",
  "Cloud engine launch barrier is unavailable",
  "Cloud engine launch barrier failed",
  "Cloud engine requires an admitted cgroup v2 scope",
  "Cloud engine cgroup ancestry is unsafe",
  "Invalid cgroup control",
  "Cloud engine cgroup control is unsafe",
  "Cloud engine cgroup evidence is too large",
  "Cloud engine cgroup write was not confirmed",
  "Invalid cgroup population evidence",
  "Previous cloud engine scope has not retired",
  "Cloud engine resource limit was not confirmed",
  "Invalid cloud engine process identity",
  "Cloud engine process placement was not confirmed",
  "Invalid cloud engine retirement deadline",
  "Cloud engine retirement is unconfirmed",
  "Invalid cloud engine launch operation",
  "Invalid cloud engine profile version",
  "Invalid cloud engine runtime projection",
  "Invalid cloud engine repository projection",
]);

// Match B4 containment_repro.py's redact()/summarize() projection. Messages
// from qualification sections are bounded; launch exceptions stay closed.
function redactQualificationText(value, maximum = 2000) {
  return String(value)
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+/g, "[url]")
    .replace(/\bBearer\s+[^\s"']+/gi, "[authorization]")
    .replace(
      /\b(?:gh[spou]_|github_pat_|condw_|sk[_-])[A-Za-z0-9_-]+/g,
      "[token]",
    )
    .replace(
      /\b[A-Z_][A-Z0-9_]*\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/g,
      "[assignment]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/\b[a-fA-F0-9]{32,}\b/g, "[hex]")
    .replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, "[opaque]")
    .replace(/\b(?:curl|wget)\b/g, "download-tool")
    .slice(-maximum);
}

export function summarizeQualification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {
    version: Number.isSafeInteger(value.version) ? value.version : null,
    secure: value.secure === true,
  };
  for (const name of QUALIFICATION_SECTIONS) {
    const section = value[name];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      result[name] = null;
      continue;
    }
    const selected = { secure: section.secure === true };
    for (const field of ["error", "phase", "failureCode", "signal"])
      if (typeof section[field] === "string")
        selected[field] = redactQualificationText(section[field]);
    for (const field of [
      "exitCode",
      "hostUid",
      "namespaceUid",
      "noNewPrivs",
      "seccompMode",
    ])
      if (Number.isSafeInteger(section[field]))
        selected[field] = section[field];
    if (Array.isArray(section.checks))
      selected.checks = section.checks.slice(0, 128).flatMap((item) => {
        if (typeof item === "string")
          return [redactQualificationText(item, 200)];
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        return [
          Object.fromEntries(
            ["name", "status", "detail"]
              .filter((key) => typeof item[key] === "string")
              .map((key) => [key, redactQualificationText(item[key])]),
          ),
        ];
      });
    if (
      name === "identity" &&
      section.resources &&
      typeof section.resources === "object"
    )
      selected.resources = Object.fromEntries(
        Object.entries(section.resources)
          .filter(([key]) =>
            ["finite", "memoryMax", "pidsMax", "cpuMax"].includes(key),
          )
          .map(([key, val]) => [
            key,
            val === null || typeof val === "boolean"
              ? val
              : redactQualificationText(val),
          ]),
      );
    result[name] = selected;
  }
  return result;
}

export function sanitizeLauncherError(error) {
  const result = {
    name: LAUNCHER_NAMES.has(error?.name) ? error.name : "UnknownError",
    message: LAUNCHER_MESSAGES.has(error?.message)
      ? error.message
      : "<withheld>",
  };
  if (LAUNCHER_CODES.has(error?.code)) result.code = error.code;
  return result;
}

const SETUP_FIELDS = [
  "secure",
  "unprivileged",
  "detachedDescendantsRetired",
  "timeoutRetired",
];
const SETUP_PHASES = new Set([
  "start",
  "worker_runtime",
  "worker_gate",
  "worker_payload",
  "worker_repository",
  "worker_setpriv",
  "worker_shell",
  "worker_exit",
  "qualify_start",
  "qualify_canary",
  "qualify_identity",
  "qualify_retirement",
  "qualify_timeout",
  "qualify_cleanup",
]);
const SIGNALS = new Set([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGABRT",
  "SIGSEGV",
  "SIGPIPE",
]);
const IDENTITY_FIELDS = [
  "runtimeId",
  "manifestSha256",
  "baseCompatibilityId",
  "bootId",
  "supervisorSessionId",
  "cgroupRoot",
];
const boundedMs = (value) =>
  Number.isFinite(value) && value >= 0 && value <= 600000
    ? Math.round(value)
    : null;
const exitCode = (value) =>
  Number.isSafeInteger(value) && value >= -128 && value <= 255 ? value : null;

/** Missing JSON means unobserved checks, not four false security predicates. */
export function setupProbeResult(result, durationMs, timeoutMs) {
  let report = null;
  try {
    const value = JSON.parse(result.stdout);
    if (value && typeof value === "object" && !Array.isArray(value))
      report = Object.fromEntries(
        SETUP_FIELDS.map((key) => [
          key,
          typeof value[key] === "boolean" ? value[key] : null,
        ]),
      );
  } catch {
    /* Raw output stays private. */
  }
  return {
    exitCode: exitCode(result.status),
    signal: SIGNALS.has(result.signal) ? result.signal : null,
    errorCode: LAUNCHER_CODES.has(result.error?.code)
      ? result.error.code
      : null,
    durationMs: boundedMs(durationMs),
    timeoutMs: boundedMs(timeoutMs),
    timedOut: result.error?.code === "ETIMEDOUT",
    outputLimit: result.error?.code === "ENOBUFS",
    report,
  };
}

function projectSetupResult(value) {
  if (!value || typeof value !== "object") return undefined;
  return setupProbeResult(
    {
      status: value.exitCode,
      signal: value.signal,
      error: { code: value.errorCode },
      stdout: JSON.stringify(value.report),
    },
    value.durationMs,
    value.timeoutMs,
  );
}

function projectSetupEvent(value) {
  if (
    !value ||
    !["phase", "error", "result", "identity"].includes(value.kind) ||
    value.component !== "setup" ||
    !["qualify", "worker", "probe"].includes(value.mode) ||
    !SETUP_PHASES.has(value.phase)
  )
    return null;
  const result = {
    kind: value.kind,
    component: "setup",
    mode: value.mode,
    phase: value.phase,
    durationMs: boundedMs(value.durationMs),
  };
  if (value.error) result.error = sanitizeLauncherError(value.error);
  if (value.result) result.result = projectSetupResult(value.result);
  if (value.identity)
    result.identity = Object.fromEntries(
      IDENTITY_FIELDS.map((key) => [key, value.identity[key] === true]),
    );
  if (value.canary)
    result.canary = Object.fromEntries(
      ["exitZero", "ready", "timedOut", "overflow"].map((key) => [
        key,
        value.canary[key] === true,
      ]),
    );
  if (value.observed) result.observed = projectMetadata(value.observed);
  if (Array.isArray(value.sites))
    result.sites = value.sites
      .filter(
        (site) =>
          SOURCES.has(site?.source) &&
          /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(site.function ?? "") &&
          !/(?:gh[spou]_|github_pat_|condw_|sk[_-])/.test(site.function) &&
          Number.isSafeInteger(site.line) &&
          site.line > 0 &&
          site.line < 100000,
      )
      .slice(0, 8)
      .map((site) => ({
        source: site.source,
        function: site.function,
        line: site.line,
      }));
  return result;
}

function projectAttester(value) {
  if (!value || typeof value !== "object") return undefined;
  return {
    stages: (Array.isArray(value.stages) ? value.stages : [])
      .slice(0, STAGES.size)
      .filter(
        (item) =>
          STAGES.has(item?.stage) &&
          ["passed", "failed", "running", "not_reached"].includes(item.outcome),
      )
      .map((item) => ({
        stage: item.stage,
        outcome: item.outcome,
        durationMs: boundedMs(item.durationMs),
        failedChecks: (Array.isArray(item.failedChecks)
          ? item.failedChecks
          : []
        )
          .filter((check) => V4_CHECKS.has(check))
          .slice(0, 32),
      })),
    ...(value.setup ? { setup: projectSetupResult(value.setup) } : {}),
    events: (Array.isArray(value.events) ? value.events : [])
      .slice(0, 64)
      .map(projectSetupEvent)
      .filter(Boolean),
    ...(value.truncated === true ? { truncated: true } : {}),
  };
}

/** Add observations only, on the same source lines. No admission predicate,
 * timeout, command, payload, identity or return value is replaced. */
export function instrumentSetupDiagnosticSource(source, name) {
  const event = (kind, expression) =>
    ` globalThis.__zerosTemplateSetupEvent?.(${JSON.stringify(kind)}, ${expression});`;
  if (name === "attest-cloud-worker.mjs") {
    source = source.replace(
      "export function cloudV4Diagnostic(error, stage) {",
      "export function cloudV4Diagnostic(error, stage) {" +
        " globalThis.__zerosTemplateSetupObserve?.(error, stage);",
    );
    return source.replace(
      /((?:let )?stage = "(validate_input|lock|verify_tree|qualify_engine|run_setup|publish_proof)";)/g,
      (match, _assignment, stage) =>
        match + event("stage", `{ stage: ${JSON.stringify(stage)} }`),
    );
  }
  if (name !== "cloud-setup-process.mjs") return source;
  source = source.replace(
    '  } finally {\n    await new CloudEngineCgroup({runtime,kind:"setup"}).retire();',
    "  } catch (error) {" +
      event("error", "{ error }") +
      ' throw error; } finally {\n    await new CloudEngineCgroup({runtime,kind:"setup"}).retire();',
  );
  const phase = (name) => event("phase", `{ phase: ${JSON.stringify(name)} }`);
  for (const [anchor, label] of [
    ["function worker() {", "worker_runtime"],
    ["if (privileged) {", "worker_gate"],
    ["const data = Buffer.alloc(MAX_DOCUMENT_BYTES + 1);", "worker_payload"],
    [
      "const encoded = Buffer.from(JSON.stringify(payload));",
      "worker_repository",
    ],
    ["export async function qualifyCloudSetupProcess() {", "qualify_start"],
    ["const command = `python3", "qualify_canary"],
    [
      'const identity = JSON.parse(readFileSync(marker, "utf8"));',
      "qualify_identity",
    ],
    ['const before = readFileSync(counter, "utf8");', "qualify_retirement"],
    ["const timeout = await runScopedCloudSetup({", "qualify_timeout"],
    [
      'await new CloudEngineCgroup({runtime,kind:"setup"}).retire();',
      "qualify_cleanup",
    ],
  ]) {
    // Function/gate anchors need the observation inside their body; other
    // statements need it before evaluation so exceptions keep the right phase.
    source = source.replace(
      anchor,
      anchor.endsWith("{") && !anchor.includes("await")
        ? anchor + phase(label)
        : phase(label) + " " + anchor,
    );
  }
  source = source.replace(
    /const runtime = (?:privileged \? resolveCloudRuntime\(\) : )?resolveCloudRuntimeChild\(\);/,
    (match) =>
      match +
      event(
        "identity",
        `{ identity: Object.fromEntries(${JSON.stringify(IDENTITY_FIELDS)}.map(key => [key, typeof runtime[key] === 'string'])) }`,
      ),
  );
  source = source.replace(
    "process.exitCode = result.status ?? 125;",
    (match) => event("result", "{ phase: 'worker_exit', result } ") + match,
  );
  source = source.replace(
    'const identity = JSON.parse(readFileSync(marker, "utf8"));',
    (match) =>
      event(
        "result",
        "{ canary: { exitZero: result.code === 0, ready: result.stdout.trim() === 'ready', timedOut: result.timedOut, overflow: result.overflow } }",
      ) + match,
  );
  return source.replace(
    '} catch {\n    process.stderr.write("Cloud setup process could not be admitted\\n");',
    "} catch (error) {" +
      event("error", "{ error }") +
      '\n    process.stderr.write("Cloud setup process could not be admitted\\n");',
  );
}

const LATER_STAGES = {
  proof_preconditions: [],
  consume_proof: ["successful_attestation"],
  serve_view: [],
  checkout_identity: [],
  checkout_branch: [],
  checkout_revision: [],
  hook_worker: [],
  checkout_fetch_and_switch: ["org_read_grant", "accepted_commit_fetch"],
  github_access: ["org_read_grant", "github_origin_fetch_and_revocation"],
  repository_hooks: ["fresh_setup_materials", "revoked_org_read_grant"],
  serve_engine: ["successful_attestation", "fresh_setup_materials"],
  preview_links: ["registered_engine", "provider_ingress"],
  engine_registration: ["fresh_setup_materials", "registered_engine"],
  engine_readiness: ["registered_engine", "readiness_token"],
};
const PRECONDITIONS = new Set(
  Object.values(LATER_STAGES)
    .flat()
    .concat(["probe_preparation", "deadline", "org_read_grant"]),
);
const LATER_CHECKS = new Set([
  "identityUnchanged",
  "namespaceUnchanged",
  "directoryWritable",
  "proofConsumed",
  "primaryProjection",
  "workerWritable",
  "originsMatch",
  "headsMatch",
  "branchValid",
  "revisionPresent",
  "workerCwd",
  "workerUid",
  "exitZero",
]);

function projectLater(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, Object.keys(LATER_STAGES).length)
    .filter(
      (item) =>
        Object.hasOwn(LATER_STAGES, item?.stage) &&
        ["passed", "failed", "precondition"].includes(item.outcome),
    )
    .map((item) => ({
      stage: item.stage,
      outcome: item.outcome,
      durationMs: boundedMs(item.durationMs),
      ...(item.error ? { error: sanitizeLauncherError(item.error) } : {}),
      ...(Array.isArray(item.requires)
        ? {
            requires: item.requires
              .filter((key) => PRECONDITIONS.has(key))
              .slice(0, 8),
          }
        : {}),
      ...(item.checks
        ? {
            checks: Object.fromEntries(
              Object.entries(item.checks).filter(
                ([key, value]) =>
                  LATER_CHECKS.has(key) && typeof value === "boolean",
              ),
            ),
          }
        : {}),
      ...(item.process ? { process: projectSetupResult(item.process) } : {}),
    }));
}

/** Independent preflights keep running after the original attestation fails.
 * Only the attester can authorize proof consumption; never synthesize proof. */
export async function runLaterSetupDiagnostics({
  imagePassed,
  operations = {},
  deadlineMs = Date.now() + 90000,
  now = Date.now,
}) {
  const results = [];
  for (const [stage, requires] of Object.entries(LATER_STAGES)) {
    const started = now();
    const entry = { stage, outcome: "precondition", durationMs: 0 };
    results.push(entry);
    if (stage === "consume_proof" && !imagePassed) entry.requires = requires;
    else if (!operations[stage])
      entry.requires = requires.length ? requires : ["probe_preparation"];
    else if (now() >= deadlineMs) entry.requires = ["deadline"];
    else
      try {
        Object.assign(entry, { outcome: "passed" }, await operations[stage]());
      } catch (error) {
        Object.assign(entry, {
          outcome: "failed",
          error: sanitizeLauncherError(error),
        });
      }
    entry.durationMs = now() - started;
  }
  return projectLater(results);
}

function projectQualification(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {
    exitCode:
      Number.isSafeInteger(value.exitCode) &&
      value.exitCode >= -128 &&
      value.exitCode <= 255
        ? value.exitCode
        : null,
    timedOut: value.timedOut === true,
    outputLimit: value.outputLimit === true,
    report: summarizeQualification(value.report),
  };
  if (value.launcherError)
    result.launcherError = sanitizeLauncherError(value.launcherError);
  if (value.launchDetail)
    result.launchDetail = projectQualification({
      ...value.launchDetail,
      launchDetail: undefined,
    });
  if (value.truncated === true) result.truncated = true;
  return result;
}

export function qualificationResult(result) {
  let report = null,
    launcherError;
  try {
    report = summarizeQualification(JSON.parse(result.stdout));
  } catch {
    /* No raw output. */
  }
  for (const line of String(result.stderr ?? "")
    .trim()
    .split("\n")
    .slice(-4)) {
    try {
      const value = JSON.parse(line);
      if (value?.schema === "zeros.template-setup-launcher-error/v1")
        launcherError = sanitizeLauncherError(value);
    } catch {
      /* CLI stderr and unknown JSON remain private. */
    }
  }
  return projectQualification({
    exitCode: result.status,
    timedOut: result.error?.code === "ETIMEDOUT",
    outputLimit: result.error?.code === "ENOBUFS",
    report,
    ...(launcherError ? { launcherError } : {}),
  });
}

export function safeProbePath(value) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^\/[A-Za-z0-9_./+@ -]*$/.test(
      value
        .replaceAll("<runtime>", "runtime")
        .replaceAll("<redacted>", "redacted"),
    ) ||
    (![
      "/srv",
      "/run",
      "/opt",
      "/home/user/.zeros-persist",
      "/sys",
      "/usr",
      "/etc",
      "/proc",
    ].some((prefix) => value === prefix || value.startsWith(prefix + "/")) &&
      value !== "/")
  )
    return "<withheld>";
  return value
    .replace(
      /\/opt\/zeros-infra\/r1-[a-f0-9]{64}/g,
      "/opt/zeros-infra/<runtime>",
    )
    .replace(
      /\b(?:gh[spou]_|github_pat_|condw_|sk[_-])[A-Za-z0-9_./+=-]*/g,
      "<redacted>",
    )
    .replace(/\b(?:[a-f0-9]{40,}|[A-Za-z0-9_+-]{80,})\b/g, "<redacted>");
}

function metadata(value, operation, filesystem = native) {
  const result = {
    path: safeProbePath(value),
    ...(OPERATIONS.has(operation) ? { operation } : {}),
  };
  try {
    const stat = filesystem.lstatSync(value);
    Object.assign(result, {
      uid: stat.uid,
      gid: stat.gid,
      mode: (stat.mode & 0o7777).toString(8).padStart(4, "0"),
      nlink: stat.nlink,
      type: stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other",
    });
    try {
      result.realpath = safeProbePath(filesystem.realpathSync(value));
    } catch {
      result.realpath = "<unavailable>";
    }
  } catch {
    result.missing = true;
  }
  return result;
}

function projectMetadata(value) {
  if (!value || typeof value !== "object") return undefined;
  // Metadata was already sanitized on the VM. Sanitize again without allowing
  // a remote field to introduce an error, URL, source content or credential.
  const safe = (item) =>
    ["<withheld>", "<unavailable>"].includes(item) ? item : safeProbePath(item);
  const result = { path: safe(value.path) };
  if (OPERATIONS.has(value.operation)) result.operation = value.operation;
  for (const name of ["uid", "gid", "nlink"])
    if (Number.isSafeInteger(value[name]) && value[name] >= 0)
      result[name] = value[name];
  if (typeof value.mode === "string" && /^[0-7]{4}$/.test(value.mode))
    result.mode = value.mode;
  if (["directory", "file", "symlink", "other"].includes(value.type))
    result.type = value.type;
  if (value.missing === true) result.missing = true;
  if (value.realpath !== undefined) result.realpath = safe(value.realpath);
  return result;
}

function projectDirectoryEntry(value) {
  if (!value || typeof value !== "object") return undefined;
  const name =
    typeof value.name === "string" &&
    /^[A-Za-z0-9_+@. [\]<>-]{1,255}$/.test(value.name)
      ? redactQualificationText(value.name, 255)
      : "<withheld>";
  const projected = projectMetadata({ ...value, path: "/" });
  return {
    name,
    ...Object.fromEntries(
      Object.entries(projected).filter(([key]) =>
        ["uid", "gid", "mode", "type", "missing"].includes(key),
      ),
    ),
  };
}

function projectDirectoryListing(value) {
  if (!DIRECTORY_ROOTS.includes(value?.path) || !Array.isArray(value.entries))
    return undefined;
  return {
    ...projectMetadata(value),
    entries: value.entries
      .slice(0, 64)
      .map(projectDirectoryEntry)
      .filter(Boolean),
    truncated: value.truncated === true || value.entries.length > 64,
    ...(value.unavailable === true ? { unavailable: true } : {}),
  };
}

export function collectProbeDirectories({ filesystem = native } = {}) {
  return DIRECTORY_ROOTS.map((directory) => {
    const listing = {
      ...metadata(directory, undefined, filesystem),
      entries: [],
      truncated: false,
    };
    if (listing.type !== "directory") return listing;
    let handle;
    try {
      handle = filesystem.opendirSync(directory);
      for (let index = 0; index <= 64; index++) {
        const entry = handle.readSync();
        if (!entry) break;
        if (index === 64) {
          listing.truncated = true;
          break;
        }
        const file = path.join(directory, entry.name);
        let observed;
        try {
          const stat = filesystem.lstatSync(file);
          observed = {
            uid: stat.uid,
            gid: stat.gid,
            mode: (stat.mode & 0o7777).toString(8).padStart(4, "0"),
            type: stat.isDirectory()
              ? "directory"
              : stat.isFile()
                ? "file"
                : stat.isSymbolicLink()
                  ? "symlink"
                  : "other",
          };
        } catch {
          observed = { missing: true };
        }
        listing.entries.push(
          projectDirectoryEntry({ name: entry.name, ...observed }),
        );
      }
    } catch {
      listing.unavailable = true;
    } finally {
      handle?.closeSync();
    }
    listing.entries.sort((a, b) => a.name.localeCompare(b.name));
    return listing;
  });
}

export function sanitizeProbeReport(value) {
  if (
    value?.schema !== "zeros.template-setup-probe/v1" ||
    !Array.isArray(value.checks) ||
    value.checks.length < 1 ||
    value.checks.length > CHECKS.size ||
    !Array.isArray(value.paths) ||
    value.paths.length > 100
  )
    throw new Error("probe_invalid");
  const checks = value.checks.map((item) => {
    if (!CHECKS.has(item?.check) || typeof item.ok !== "boolean")
      throw new Error("probe_invalid");
    const result = { check: item.check, ok: item.ok };
    if (Array.isArray(item.sites))
      result.sites = item.sites
        .slice(0, 12)
        .filter(
          (site) =>
            SOURCES.has(site?.source) &&
            /^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(site.function ?? "") &&
            !/(?:gh[spou]_|github_pat_|condw_|sk[_-])/.test(site.function) &&
            Number.isSafeInteger(site.line) &&
            site.line > 0 &&
            site.line < 100000,
        )
        .map(({ source, function: name, line }) => ({
          source,
          function: name,
          line,
        }));
    if (item.observed) result.observed = projectMetadata(item.observed);
    if (item.gates && typeof item.gates === "object")
      result.gates = Object.fromEntries(
        Object.entries(item.gates).filter(
          ([key, val]) => GATES.has(key) && typeof val === "boolean",
        ),
      );
    if (STAGES.has(item.stage)) result.stage = item.stage;
    if (Array.isArray(item.failedChecks))
      result.failedChecks = item.failedChecks
        .filter((check) => V4_CHECKS.has(check))
        .slice(0, 32);
    if (item.check === "image")
      for (const key of ["qualification", "attesterQualification"])
        if (item[key]) result[key] = projectQualification(item[key]);
    if (item.check === "image" && item.attester) result.attester = projectAttester(item.attester);
    return result;
  });
  return {
    schema: value.schema,
    checks,
    paths: value.paths.map(projectMetadata).filter(Boolean),
    ...(Array.isArray(value.later) ? { later: projectLater(value.later) } : {}),
    ...(Array.isArray(value.directories)
      ? {
          directories: value.directories
            .slice(0, DIRECTORY_ROOTS.length)
            .map(projectDirectoryListing)
            .filter(Boolean),
        }
      : {}),
  };
}

/** Preserve check/failure evidence first; optional filesystem snapshots yield
 * to the commands API's 64 KiB stdout budget. */
export function serializeProbeReport(value) {
  const report = sanitizeProbeReport(value);
  let output = JSON.stringify(report) + "\n";
  while (Buffer.byteLength(output) > 65536) {
    const trace = report.checks.flatMap(item => (item.attester?.events ?? [])
      .filter(event => event.observed || event.sites?.length)
      .map(event => ({ attester: item.attester, event })))[0];
    if (report.paths.length) report.paths.pop();
    else if (trace) {
      if (trace.event.observed) delete trace.event.observed;
      else trace.event.sites.pop();
      trace.attester.truncated = true;
    }
    else {
      const listing = report.directories?.reduce(
        (largest, item) =>
          !largest || item.entries.length > largest.entries.length
            ? item
            : largest,
        undefined,
      );
      if (listing?.entries.length) {
        listing.entries.pop();
        listing.truncated = true;
      } else {
        // B4 can include 128 detailed checks per section. Preserve secure/error
        // fields and drop optional detail/check tails only if the API requires it.
        const qualification = report.checks
          .flatMap((item) => [
            item.qualification,
            item.attesterQualification,
            item.qualification?.launchDetail,
          ])
          .filter(Boolean);
        const details = qualification.flatMap((value) =>
          QUALIFICATION_SECTIONS.flatMap((name) =>
            (value.report?.[name]?.checks ?? [])
              .filter(
                (item) =>
                  item &&
                  typeof item === "object" &&
                  Object.hasOwn(item, "detail"),
              )
              .map((item) => ({ value, item })),
          ),
        );
        if (details.length) {
          delete details[0].item.detail;
          details[0].value.truncated = true;
        } else {
          const section = qualification
            .flatMap((value) =>
              QUALIFICATION_SECTIONS.filter((name) => name !== "identity").map(
                (name) => ({ value, section: value.report?.[name] }),
              ),
            )
            .filter(({ section: item }) => item?.checks?.length)
            .sort(
              (a, b) => b.section.checks.length - a.section.checks.length,
            )[0];
          if (!section) throw new Error("probe_invalid");
          section.section.checks.pop();
          section.value.truncated = true;
        }
      }
    }
    output = JSON.stringify(report) + "\n";
  }
  return output;
}

/** Observe the original fs calls, preserving their arguments/results/errors.
 * The last operation and a filtered stack locate a compound failing predicate. */
export function installFilesystemTrace() {
  let last;
  const descriptors = new Map();
  for (const name of Object.keys(native))
    fs[name] = (...args) => {
      const file =
        typeof args[0] === "number" ? descriptors.get(args[0]) : args[0];
      if (typeof file === "string") last = { file, operation: name };
      const result = native[name](...args);
      if (name === "openSync") descriptors.set(result, file);
      if (name === "closeSync") descriptors.delete(args[0]);
      return result;
    };
  syncBuiltinESMExports();
  return {
    observed: () => (last ? metadata(last.file, last.operation) : undefined),
    restore: () => {
      Object.assign(fs, native);
      syncBuiltinESMExports();
    },
  };
}

export function probeFailureSites(error) {
  return String(error?.stack ?? "")
    .split("\n")
    .flatMap((line) => {
      const match =
        /at (?:(?:[A-Za-z_][A-Za-z0-9_]*\.)?([A-Za-z_][A-Za-z0-9_]*) \()?.*\/([^/():]+\.mjs):(\d+):\d+\)?$/.exec(
          line.trim(),
        );
      return match && SOURCES.has(match[2])
        ? [
            {
              source: match[2],
              function: match[1] ?? "anonymous",
              line: Number(match[3]),
            },
          ]
        : [];
    })
    .slice(0, 12);
}

const self = fileURLToPath(import.meta.url),
  traceFile = self + ".attester.json",
  qualificationFile = self + ".qualification.json",
  eventsFile = self + ".events.jsonl",
  setupResultFile = self + ".setup.json";
const observerUrl = pathToFileURL(self).href + "?observer";

function observeAttester() {
  const trace = installFilesystemTrace();
  const started = performance.now();
  let phase = "start";
  const mode =
    process.argv[2] === "--worker"
      ? "worker"
      : process.argv[2] === "--qualify"
        ? "qualify"
        : "probe";
  const append = (value) => {
    try {
      fs.appendFileSync(eventsFile, JSON.stringify(value) + "\n", {
        mode: 0o600,
      });
    } catch {
      /* Observation cannot change a result. */
    }
  };
  globalThis.__zerosTemplateSetupEvent = (kind, value = {}) => {
    if (kind === "stage") {
      if (STAGES.has(value.stage) && process.argv.length === 4)
        append({
          component: "attester",
          kind,
          stage: value.stage,
          atMs: Date.now(),
        });
      return;
    }
    if (SETUP_PHASES.has(value.phase)) phase = value.phase;
    const projected = projectSetupEvent({
      ...value,
      kind,
      component: "setup",
      mode,
      phase,
      durationMs: performance.now() - started,
      ...(value.error
        ? { sites: probeFailureSites(value.error), observed: trace.observed() }
        : {}),
      ...(value.result
        ? {
            result: setupProbeResult(
              value.result,
              performance.now() - started,
              undefined,
            ),
          }
        : {}),
    });
    if (projected) append(projected);
  };
  globalThis.__zerosTemplateSetupObserve = (error, stage) => {
    if (process.argv.length === 4)
      append({
        component: "attester",
        kind: "completion",
        stage: STAGES.has(stage) ? stage : "done",
        atMs: Date.now(),
        failedChecks: error
          ? [V4_CHECKS.has(error.check) ? error.check : "diagnostic_missing"]
          : [],
      });
    if (!error) return;
    try {
      fs.writeFileSync(
        traceFile,
        JSON.stringify({
          sites: probeFailureSites(error),
          observed: trace.observed(),
          ...(STAGES.has(stage) ? { stage } : {}),
          ...(V4_CHECKS.has(error.check)
            ? { failedChecks: [error.check] }
            : {}),
        }),
        { mode: 0o600 },
      );
    } catch {
      /* Observation never changes the admission result. */
    }
  };
  // Add an observer to the installed attester's diagnostic boundary in memory.
  // No source file or manifest is rewritten, and no predicate is changed.
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (
        url.startsWith("file:///opt/zeros-infra/") &&
        ["attest-cloud-worker.mjs", "cloud-setup-process.mjs"].some((name) =>
          url.endsWith("/lib/zeros/" + name),
        )
      ) {
        const source =
          typeof result.source === "string"
            ? result.source
            : Buffer.from(result.source).toString("utf8");
        return {
          ...result,
          source: instrumentSetupDiagnosticSource(source, path.basename(url)),
        };
      }
      return result;
    },
  });
  const spawnSync = processes.spawnSync;
  processes.spawnSync = (file, args, options) => {
    // The attester's locked child has an intentionally minimal environment.
    // Pass the observer as Node flags; process.argv and isolation stay intact.
    const index = args?.indexOf(process.execPath) ?? -1;
    if (
      file === "/usr/bin/flock" &&
      index >= 0 &&
      args[index + 1]?.endsWith("/attest-cloud-worker.mjs")
    )
      args = [
        ...args.slice(0, index + 1),
        "--import",
        observerUrl,
        ...args.slice(index + 1),
      ];
    const setup =
      file === process.execPath &&
      args?.[0]?.endsWith("/cloud-setup-process.mjs") &&
      args[1] === "--qualify";
    const started = performance.now();
    const result = spawnSync(
      file,
      setup ? ["--import", observerUrl, ...args] : args,
      options,
    );
    if (setup) {
      try {
        fs.writeFileSync(
          setupResultFile,
          JSON.stringify(
            setupProbeResult(
              result,
              performance.now() - started,
              options?.timeout,
            ),
          ),
          { mode: 0o600 },
        );
      } catch {
        /* Original result stays intact. */
      }
    }
    if (file === "/usr/bin/setpriv" || file === "/bin/bash")
      globalThis.__zerosTemplateSetupEvent("result", {
        phase: file === "/usr/bin/setpriv" ? "worker_setpriv" : "worker_shell",
        result,
      });
    if (
      file === process.execPath &&
      args?.[0]?.endsWith("/cloud-engine-launcher.mjs") &&
      args[1] === "--qualify"
    ) {
      try {
        fs.writeFileSync(
          qualificationFile,
          JSON.stringify(qualificationResult(result)),
          { mode: 0o600 },
        );
      } catch {
        /* Observation cannot alter the original gate. */
      }
    }
    return result;
  };
  const spawn = processes.spawn;
  processes.spawn = (file, args, options) =>
    spawn(
      file,
      file === process.execPath &&
        args?.[0]?.endsWith("/cloud-setup-process.mjs") &&
        args[1] === "--worker"
        ? ["--import", observerUrl, ...args]
        : args,
      options,
    );
  syncBuiltinESMExports();
}

function readAttesterDetails() {
  let events = [],
    setup;
  try {
    const bytes = native.readFileSync(eventsFile, "utf8");
    if (Buffer.byteLength(bytes) <= 256 * 1024)
      events = bytes
        .trim()
        .split("\n")
        .slice(0, 256)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
  } catch {
    /* Never copy raw child output. */
  }
  try {
    setup = JSON.parse(native.readFileSync(setupResultFile, "utf8"));
  } catch {
    /* A skipped probe is explicit. */
  }
  const stageEvents = events.filter((event) => event.component === "attester");
  const stages = [
    "validate_input",
    "lock",
    "verify_tree",
    "qualify_engine",
    "run_setup",
    "publish_proof",
  ].map((stage) => {
    const index = stageEvents.findIndex(
      (event) => event.kind === "stage" && event.stage === stage,
    );
    const start = stageEvents[index],
      end = stageEvents[index + 1];
    const failedChecks = end?.kind === "completion" ? end.failedChecks : [];
    return {
      stage,
      outcome: !start
        ? "not_reached"
        : !end
          ? "running"
          : failedChecks.length
            ? "failed"
            : "passed",
      durationMs: start && end ? end.atMs - start.atMs : null,
      failedChecks,
    };
  });
  return projectAttester({
    stages,
    setup,
    events: events.filter((event) => event.component === "setup"),
  });
}

export function runQualificationDiagnostics(
  runtime,
  {
    execute = processes.spawnSync,
    now = Date.now,
    deadlineMs = now() + 400000,
  } = {},
) {
  const run = (mode) => {
    const seconds = Math.min(330, Math.floor((deadlineMs - now()) / 1000) - 25);
    if (seconds < 1)
      return projectQualification({ timedOut: true, report: null });
    const result = execute(
      "/usr/bin/python3",
      [
        "-I",
        path.join(path.dirname(self), "template-setup-qualification.py"),
        runtime.root,
        self,
        mode,
        String(seconds),
      ],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/root" },
        encoding: "utf8",
        timeout: (seconds + 20) * 1000,
        maxBuffer: 1024 * 1024,
      },
    );
    if (result.status === 0 && !result.error && !result.signal) {
      try {
        return projectQualification(JSON.parse(result.stdout));
      } catch {
        /* Closed capture failure below. */
      }
    }
    return qualificationResult(result);
  };
  const result = run("qualify");
  if (!result.report && !result.timedOut && !result.outputLimit)
    result.launchDetail = run("launch_detail");
  return result;
}

function exposeSetupHelpers() {
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.startsWith("file:///opt/zeros-infra/") && url.endsWith("/lib/zeros/cloud-computer-checkout.mjs"))
        return { ...result, source: String(result.source) + "\nexport { identity as s1RepositoryIdentity };\n" };
      if (
        url.startsWith("file:///opt/zeros-infra/") &&
        url.endsWith("/lib/zeros/setup-cloud-workspace.mjs")
      ) {
        const source =
          typeof result.source === "string"
            ? result.source
            : Buffer.from(result.source).toString("utf8");
        // These are the installed helper's private functions, exported only in
        // this diagnostic process. Their bodies and original line numbers stay intact.
        return {
          ...result,
          source:
            source +
            "\nexport { assertRootDirectory as s1AssertRootDirectory, prepareSupervisor as s1PrepareSupervisor, atomicWrite as s1AtomicWrite, removeRootRuntimeFile as s1RemoveRootRuntimeFile };\n",
        };
      }
      return result;
    },
  });
}

function laterOperations(
  runtime,
  material,
  setup,
  attester,
  computer,
  initialBinding,
  deadlineMs,
) {
  const primaryRepo = material.computer.template.repositoryManifest.find(
    (repo) => repo.id === material.computer.primaryRepositoryId,
  );
  const primary = `/srv/zeros/files/repos/${primaryRepo.owner}/${primaryRepo.name}`;
  const run = (file, args, timeout = 15000) => {
    timeout = Math.min(timeout, deadlineMs - Date.now());
    if (timeout < 1)
      throw Object.assign(new Error("probe_command_failed"), {
        code: "ETIMEDOUT",
      });
    const started = performance.now();
    const result = processes.spawnSync(file, args, {
      cwd: "/",
      encoding: "utf8",
      timeout,
      maxBuffer: 65536,
      env: {
        PATH: `${runtime.binRoot}:/usr/bin:/bin`,
        HOME: "/srv/zeros/home/agent",
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return {
      result,
      process: setupProbeResult(result, performance.now() - started, timeout),
    };
  };
  const git = async (directory, args) => {
    const { result } = run("/usr/bin/setpriv", [
      "--no-new-privs",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--reuid=10001",
      "--regid=10001",
      "--clear-groups",
      "/usr/bin/git",
      "-C",
      directory,
      "-c",
      "credential.helper=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.allow=never",
      ...args,
    ]);
    if (result.status !== 0 || result.error || result.signal)
      throw new Error("repository_revision_invalid");
    return result.stdout.trim();
  };
  return {
    proof_preconditions: () => {
      const current = attester.verifyCloudV4Installation();
      const checks = {
        identityUnchanged: [...IDENTITY_FIELDS, "installerReceiptSha256"].every(
          (key) => runtime[key] === current[key],
        ),
        namespaceUnchanged:
          JSON.stringify(attester.cloudV4LaunchBinding()) ===
          JSON.stringify(initialBinding),
        directoryWritable: false,
      };
      attester.requireCloudV4AdmissionDirectory();
      const file = `/run/zeros/zeros-v2-test-proof-${randomUUID()}.json`;
      try {
        setup.s1AtomicWrite(file, '{"diagnostic":true}\n', { mode: 0o400 });
        checks.directoryWritable = true;
      } finally {
        fs.rmSync(file, { force: true });
      }
      return {
        outcome: Object.values(checks).every(Boolean) ? "passed" : "failed",
        checks,
      };
    },
    consume_proof: () => {
      const result = run(
        "/usr/bin/flock",
        [
          "--no-fork",
          "--nonblock",
          "--conflict-exit-code",
          "75",
          "/run/zeros/engine.lock",
          runtime.node,
          runtime.helpers.consumeAdmission,
        ],
        30000,
      );
      const proofConsumed =
        result.result.status === 0 &&
        !result.result.error &&
        !result.result.signal;
      return {
        outcome: proofConsumed ? "passed" : "failed",
        checks: { proofConsumed },
        process: result.process,
      };
    },
    serve_view: async () => {
      const launcher = await import(pathToFileURL(runtime.helpers.launcher));
      const view = await import(
        pathToFileURL(`${runtime.libRoot}/cloud-engine-view.mjs`)
      );
      const source = {
        ZEROS_CLOUD_RUNTIME_B64: Buffer.from(
          JSON.stringify({
            execution: material.execution,
            engine: { instanceId: material.engine.instanceId },
          }),
        ).toString("base64url"),
      };
      const profile = launcher.prepareCloudEngineView(runtime, source, "serve");
      try {
        const args = view.cloudEngineViewArguments(
          "serve",
          4,
          runtime,
          profile.viewDirectory,
          profile.primaryRepository,
        );
        view.cloudEngineViewEnvironment(source, "serve", runtime);
        const writable = run("/usr/bin/setpriv", [
          "--reuid=10001",
          "--regid=10001",
          "--clear-groups",
          "/usr/bin/test",
          "-w",
          primary,
        ]);
        const checks = {
          primaryProjection:
            profile.primaryRepository === primary && args.includes(primary),
          workerWritable:
            writable.result.status === 0 &&
            !writable.result.error &&
            !writable.result.signal,
        };
        return {
          outcome: Object.values(checks).every(Boolean) ? "passed" : "failed",
          checks,
        };
      } finally {
        profile.releaseView?.();
      }
    },
    checkout_identity: async () => {
      for (const repo of material.computer.template.repositoryManifest) {
        const directory = `/srv/zeros/files/repos/${repo.owner}/${repo.name}`;
        const head = await computer.s1RepositoryIdentity(
          directory,
          { cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git` },
          git,
        );
        if (
          head !== repo.sha &&
          !(
            repo.id === material.computer.primaryRepositoryId &&
            head === material.repository.revision
          )
        )
          throw new Error("repository_revision_invalid");
      }
      return { checks: { originsMatch: true, headsMatch: true } };
    },
    checkout_branch: async () => {
      const requested = material.computer.requestedRevision;
      const branch = requested.startsWith("refs/heads/")
        ? requested.slice(11)
        : /^[a-f0-9]{40}$/.test(requested) || requested.startsWith("refs/")
          ? null
          : requested;
      if (branch) await git(primary, ["check-ref-format", "--branch", branch]);
      return { checks: { branchValid: true } };
    },
    checkout_revision: async () => {
      try {
        await git(primary, [
          "cat-file",
          "-e",
          `${material.repository.revision}^{commit}`,
        ]);
      } catch {
        return {
          outcome: "precondition",
          checks: { revisionPresent: false },
          requires: ["org_read_grant"],
        };
      }
      return { checks: { revisionPresent: true } };
    },
    hook_worker: async () => {
      if (deadlineMs - Date.now() < 20000)
        return { outcome: "precondition", requires: ["deadline"] };
      const setupProcess = await import(
        pathToFileURL(runtime.helpers.setupProcess)
      );
      const started = performance.now();
      const result = await setupProcess.runScopedCloudSetup({
        version: 1,
        environment: {},
        timeoutMs: 10000,
        command: `test "$(id -u)" = 10001 && test "$PWD" = '${primary}' && printf zeros-template-hook-ok`,
      });
      const ok =
        result.code === 0 &&
        !result.signal &&
        !result.timedOut &&
        !result.overflow &&
        result.stdout === "zeros-template-hook-ok";
      return {
        outcome: ok ? "passed" : "failed",
        checks: { workerCwd: ok, workerUid: ok, exitZero: result.code === 0 },
        process: setupProbeResult(
          {
            status: result.code,
            signal: result.signal,
            error: {
              code: result.timedOut
                ? "ETIMEDOUT"
                : result.overflow
                  ? "ENOBUFS"
                  : undefined,
            },
          },
          performance.now() - started,
          10000,
        ),
      };
    },
  };
}

async function main() {
  process.umask(0o077);
  const deadlineMs = Date.now() + 400000;
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 65536) throw new Error("input_invalid");
  }
  const material = JSON.parse(input),
    trace = installFilesystemTrace();
  const report = {
    schema: "zeros.template-setup-probe/v1",
    checks: [],
    paths: [],
    directories: collectProbeDirectories(),
  };
  let imagePassed = false, operations = {};
  const step = async (check, run) => {
    const entry = { check, ok: false };
    report.checks.push(entry);
    try {
      const value = await run(entry);
      entry.ok = true;
      return value;
    } catch (error) {
      entry.sites ??= probeFailureSites(error);
      entry.observed ??= trace.observed();
      throw error;
    }
  };
  try {
    const lib = native.realpathSync("/opt/zeros/current") + "/lib/zeros";
    const runtime = await step("runtime", async () => {
      const { resolveCloudRuntime } = await import(
        pathToFileURL(`${lib}/cloud-runtime-root.mjs`)
      );
      const value = resolveCloudRuntime();
      if (value.profile !== "v4" || process.geteuid?.() !== 0)
        throw new Error("runtime_invalid");
      return value;
    });
    const nestedMounts = native
      .readFileSync("/proc/self/mountinfo", "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[4])
      .filter((value) => typeof value === "string")
      .map((value) =>
        value.replace(/\\([0-7]{3})/g, (_match, octal) =>
          String.fromCharCode(parseInt(octal, 8)),
        ),
      )
      .filter((value) => value.startsWith("/srv/zeros/files/"))
      .slice(0, 16);
    for (const file of [
      "/srv/zeros/files",
      "/home/user/.zeros-persist/files",
      "/srv/zeros/files/repos",
      "/srv/zeros/repos",
      "/srv/zeros/computer-template.json",
      "/run/zeros/computer-workspace.json",
      ...nestedMounts,
      runtime.node,
      runtime.root,
      runtime.startEngine,
      runtime.engineNamespace,
      ...Object.values(runtime.helpers),
      ...material.computer.template.repositoryManifest.flatMap((repo) => {
        const checkout = `/srv/zeros/files/repos/${repo.owner}/${repo.name}`;
        return [
          path.dirname(checkout),
          checkout,
          checkout + "/.git",
          checkout + "/.git/config",
        ];
      }),
    ].slice(0, 100))
      report.paths.push(metadata(file));
    await step("runtime_pin", () => {
      if (
        !["runtimeId", "manifestSha256", "baseCompatibilityId"].every(
          (name) => runtime[name] === material.runtimePin[name],
        )
      )
        throw new Error("runtime_pin_mismatch");
    });
    observeAttester();
    exposeSetupHelpers();
    const setup = await import(
      pathToFileURL(`${lib}/setup-cloud-workspace.mjs`)
    );
    const profileModule = await import(
      pathToFileURL(`${lib}/cloud-runtime-profile.mjs`)
    );
    const profile = await step("host_profile", () =>
      profileModule.ensureCloudHostRuntimeDirectory(
        profileModule.readCloudHostRuntimeProfile(),
      ),
    );
    await step("setup_directory", () =>
      setup.s1AssertRootDirectory(profile.setupDirectory, 0o700),
    );
    await step("supervisor", () => setup.s1PrepareSupervisor());
    const computer = await import(
      pathToFileURL(`${lib}/cloud-computer-checkout.mjs`)
    );
    await step("template", () =>
      computer.verifyCloudComputerTemplate(
        material.computer,
        material.repository,
      ),
    );
    await step("admission", () => {
      const value = computer.createCloudComputerWorkspaceAdmission(
        material,
        runtime,
      );
      setup.s1AtomicWrite(
        computer.CLOUD_COMPUTER_WORKSPACE_ADMISSION,
        JSON.stringify(value) + "\n",
        { mode: 0o600 },
      );
    });
    await step("admission_roundtrip", () =>
      computer.readCloudComputerWorkspaceAdmission(runtime),
    );
    await step("credential_residue", () => {
      for (const name of [
        "github-credential.json",
        "github-credential-refresh.json",
      ]) {
        const file = path.join(profile.runtimeDirectory, name);
        setup.s1RemoveRootRuntimeFile(file, profile.engineUid);
      }
    });
    const attester = await import(
      pathToFileURL(`${lib}/attest-cloud-worker.mjs`)
    );
    await step("v4_installation", () => attester.verifyCloudV4Installation());
    const initialBinding = attester.cloudV4LaunchBinding();
    // Construct operations without executing any later stage yet.
    operations = laterOperations(runtime, material, setup, attester, computer, initialBinding, deadlineMs);
    const spawn = processes.spawn;
    processes.spawn = (file, args, options) =>
      spawn(
        file,
        file === runtime.node && args[0] === runtime.helpers.attester
          ? ["--import", observerUrl, ...args]
          : args,
        options,
      );
    syncBuiltinESMExports();
    // No credential is issued. attestImage reads only the expiry bounds and
    // the allocation contract; admission contains only the original repo fields.
    material.repository.credential = { expiresAtMs: Date.now() + 3600000 };
    material.engine.registration = { expiresAtMs: Date.now() + 3600000 };
    await step("image", async (entry) => {
      try {
        await setup.attestImage(material, profile, (gates) => {
          entry.gates = gates;
        });
        imagePassed = true;
      } catch (error) {
        try {
          Object.assign(
            entry,
            JSON.parse(native.readFileSync(traceFile, "utf8")),
          );
        } catch {
          /* Closed setup gates remain. */
        }
        if (entry.stage === "qualify_engine" && entry.failedChecks?.includes("containment_smoke")) {
          entry.qualification = runQualificationDiagnostics(runtime, {
            deadlineMs: deadlineMs - 60000,
          });
        }
        throw error;
      } finally {
        entry.attester = readAttesterDetails();
        try { entry.attesterQualification = projectQualification(JSON.parse(native.readFileSync(qualificationFile, "utf8"))); }
        catch { /* The original launcher may have returned no report. */ }
      }
    });
  } catch {
    /* First failed original check is the result; no raw error output. */
  } finally {
    report.later = await runLaterSetupDiagnostics({ imagePassed, operations, deadlineMs });
    trace.restore();
  }
  process.stdout.write(serializeProbeReport(report));
}

if (new URL(import.meta.url).searchParams.has("observer")) observeAttester();
else if (process.argv[1] && path.resolve(process.argv[1]) === self)
  main().catch(error => {
    const name = ["Error", "TypeError", "SyntaxError", "RangeError", "ReferenceError"].includes(error?.name) ? error.name : "Error";
    const code = ["ERR_MODULE_NOT_FOUND", "ERR_UNKNOWN_BUILTIN_MODULE", "ERR_REQUIRE_ESM"].includes(error?.code) ? error.code : "probe_failed";
    process.stderr.write(JSON.stringify({ schema: "zeros.template-setup-error/v1", phase: "probe", name, code }) + "\n");
    process.exitCode = 1;
  });
