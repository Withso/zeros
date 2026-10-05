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

function metadata(value, operation) {
  const result = {
    path: safeProbePath(value),
    ...(OPERATIONS.has(operation) ? { operation } : {}),
  };
  try {
    const stat = native.lstatSync(value);
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
      result.realpath = safeProbePath(native.realpathSync(value));
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
    return result;
  });
  return {
    schema: value.schema,
    checks,
    paths: value.paths.map(projectMetadata).filter(Boolean),
  };
}

/** Preserve check/failure evidence first; optional filesystem snapshots yield
 * to the commands API's 64 KiB stdout budget. */
export function serializeProbeReport(value) {
  const report = sanitizeProbeReport(value);
  let output = JSON.stringify(report) + "\n";
  while (Buffer.byteLength(output) > 65536) {
    if (!report.paths.length) throw new Error("probe_invalid");
    report.paths.pop();
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
  traceFile = self + ".attester.json";
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
    return spawnSync(file, args, options);
  };
  syncBuiltinESMExports();
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
