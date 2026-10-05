// Operator-only payload, copied into the disposable fork's private /run tree.
// Import the installed helpers; never replace a runtime file or change a gate.
import {
  createRequire,
  registerHooks,
  syncBuiltinESMExports,
} from "node:module";
import path from "node:path";
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
  "ERR_MODULE_NOT_FOUND",
  "ERR_INVALID_ARG_TYPE",
  "ERR_DLOPEN_FAILED",
]);
const LAUNCHER_MESSAGES = new Set([
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
    return result;
  });
  return {
    schema: value.schema,
    checks,
    paths: value.paths.map(projectMetadata).filter(Boolean),
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
    if (report.paths.length) report.paths.pop();
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
  qualificationFile = self + ".qualification.json";
const observerUrl = pathToFileURL(self).href + "?observer";

function observeAttester() {
  const trace = installFilesystemTrace();
  globalThis.__zerosTemplateSetupObserve = (error, stage) => {
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
        url.endsWith("/lib/zeros/attest-cloud-worker.mjs")
      ) {
        const source =
          typeof result.source === "string"
            ? result.source
            : Buffer.from(result.source).toString("utf8");
        const anchor = "export function cloudV4Diagnostic(error, stage) {";
        return {
          ...result,
          source: source.replace(
            anchor,
            anchor + " globalThis.__zerosTemplateSetupObserve?.(error, stage);",
          ),
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
    const result = spawnSync(file, args, options);
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
  syncBuiltinESMExports();
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
      } catch (error) {
        try {
          Object.assign(
            entry,
            JSON.parse(native.readFileSync(traceFile, "utf8")),
          );
        } catch {
          /* Closed setup gates remain. */
        }
        if (
          entry.stage === "qualify_engine" &&
          entry.failedChecks?.includes("containment_smoke")
        ) {
          try {
            entry.attesterQualification = projectQualification(
              JSON.parse(native.readFileSync(qualificationFile, "utf8")),
            );
          } catch {
            /* The original launcher may have returned no report. */
          }
          entry.qualification = runQualificationDiagnostics(runtime, {
            deadlineMs,
          });
        }
        throw error;
      }
    });
  } catch {
    /* First failed original check is the result; no raw error output. */
  } finally {
    trace.restore();
  }
  process.stdout.write(serializeProbeReport(report));
}

if (new URL(import.meta.url).searchParams.has("observer")) observeAttester();
else if (process.argv[1] && path.resolve(process.argv[1]) === self)
  main().catch(() => {
    process.stderr.write("probe_failed\n");
    process.exitCode = 1;
  });
