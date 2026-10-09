/** Fixed production log contract; raw engine/provider output stays in memory. */
export function zsrAdmissionDiagnostic(logs: string) {
  const stages = new Set(["preflight", "ownership", "territory", "policy", "resources", "cloud-state", "activation", "canary"]);
  const patterns = [ ["canary_exit", /host-parity canary exited/], ["canary_timeout", /host-parity canary.*timed out/],
    ["podman_service_unready", /private Podman service did not become ready/], ["podman_service_exited", /private Podman service exited unexpectedly/],
    ["code_write_denied", /host-parity code actor cannot write code territory/], ["design_split_failed", /host-parity Design.*write split is not enforced/],
    ["host_read_denied", /host-parity cannot read the host/], ["git_read_denied", /host-parity cannot read canonical Git metadata/],
    ["environment_changed", /host-parity did not preserve the child environment|host-parity injected TLS-trust/],
    ["configuration_rejected", /generated sandbox configuration is invalid|invalid privileged cloud-worker policy|invalid cloud container-worker descriptor/],
    ["supervisor_descriptor_rejected", /(?:policy|command) descriptor (?:must be one bounded regular file|has the wrong owner|permissions are too broad|path is not canonical|must be an object|contains an unsupported field)|missing policy\/command descriptor|unsupported (?:command|policy) version/],
    ["supervisor_policy_rejected", /invalid host-parity runtime policy|policy identity is invalid|invalid command identity|command args must be bounded strings|command env must be a complete environment object|command environment (?:is too large|contains an invalid entry)|Git dispatcher configuration is invalid|container socket subtraction is invalid/],
    ["native_home_rejected", /Cloud native provider home is invalid|Cloud native home requires the admitted worker identity|Cloud native home is not privately owned|Native cloud homes require a privileged worker supervisor/],
    ["container_state_rejected", /cloud container-worker (?:launcher is outside private tools|state is not privately owned|socket is not admitted)|invalid cloud container-worker path/],
    ["sandbox_dependencies_unavailable", /Sandbox dependencies not available:/],
    ["dependency_bwrap", /Sandbox dependencies not available:.*bubblewrap \(bwrap\)/],
    ["dependency_socat", /Sandbox dependencies not available:.*socat/],
    ["dependency_ripgrep", /Sandbox dependencies not available:.*ripgrep/],
    ["dependency_seccomp", /Sandbox dependencies not available:.*apply-seccomp/],
    ["privileged_worker_rejected", /Privileged cloud-worker proxy composition is not qualified|Privileged cloud-worker mode requires (?:host parity without weaker nesting|a root supervisor)|Invalid privileged cloud-worker identity|Privileged cloud-worker setpriv must be a canonical non-writable file/],
    ["tool_not_canonical", /must be a canonical regular executable/],
    ["sandbox_cleanup_failed", /sandbox runtime cleanup failed/],
    ["container_directory_rejected", /container (?:endpoint directory|state|runtime|storage|worker directory) (?:has unsafe ownership or permissions|is not a canonical physical directory)/],
    ["container_lock_rejected", /container service lock is unsafe|container service is busy or its lock is unavailable/],
    ["container_options_rejected", /container worker options are invalid|container socket is outside its exact private endpoint|container engine is not a canonical executable/],
    ["cap_setfcap_missing", /running as uid 0 without CAP_SETFCAP/],
    ["profile_rejected", /Sandbox profile contains a path with a NUL byte|Oversized host-parity or weaker-nesting profiles cannot safely use a supervisor descriptor|Sandboxed command is too long for one shell argument/],
    ["shell_unavailable", /Shell '[^\r\n]{0,256}' not found in PATH/],
    ["profile_file_unavailable", /no unnamed file could be opened for it/],
    ["tool_unavailable", /absolute (bwrap|ripgrep) unavailable|setpriv unavailable/],
    ["descriptor_not_immutable", /cloud container-worker launcher is not immutable|must be a root-owned non-writable executable/],
    ["native_loader", /ERR_DLOPEN_FAILED|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|GLIBC_|undefined symbol/],
    ["permission_denied", /EACCES|Operation not permitted|Permission denied/],
    ["file_missing", /ENOENT|No such file or directory/], ] as const;
  const line = logs.slice(-256 * 1024).split("\n").filter(line => line.startsWith("[zsr] admission failed ") && line.length <= 8192).at(-1);
  if (!line) return undefined;
  const completed = [...line.matchAll(/([a-z-]+)=\d+ms/g)].map(match => match[1]).filter(name => stages.has(name));
  const exit = /host-parity canary exited (\d{1,3})(?::|$)/.exec(line);
  const canaryExitCode = exit && Number(exit[1]) <= 255 ? Number(exit[1]) : undefined;
  return { completed: [...new Set(completed)], reasons: patterns.filter(([, regex]) => regex.test(line)).map(([id]) => id),
    suffixPresent: /host-parity canary exited \d{1,3}:\s*\S/.test(line),
    supervisorPrefixPresent: line.includes("[zsr-supervisor]"), containerPrefixPresent: line.includes("[cloud-container-worker]"),
    ...(canaryExitCode !== undefined ? { canaryExitCode } : {}) };
}
export function cloudPreflightDiagnostic(logs: string): { code: "cloud_containment_environment_setup_failed"; reasons: string[] } | undefined {
  const reasons = new Set(["supervisor_missing", "supervisor_runtime_missing", "ripgrep_missing", "container_launcher_unavailable",
    "podman_unavailable", "process_domain_unavailable", "unsupported_platform", "probe_rejected"]);
  let result: { code: "cloud_containment_environment_setup_failed"; reasons: string[] } | undefined;
  for (const line of logs.slice(-256 * 1024).split("\n")) {
    const prefix = "[zsr] cloud preflight rejected ";
    if (!line.startsWith(prefix) || line.length > 1024) continue;
    try {
      const value = JSON.parse(line.slice(prefix.length));
      if (!value || Object.keys(value).sort().join(",") !== "code,reasons" || value.code !== "cloud_containment_environment_setup_failed" ||
        !Array.isArray(value.reasons) || !value.reasons.length || value.reasons.length > 8 ||
        new Set(value.reasons).size !== value.reasons.length || value.reasons.some((reason: unknown) => typeof reason !== "string" || !reasons.has(reason))) continue;
      result = { code: value.code, reasons: [...value.reasons] };
    } catch { /* A malformed line has no closed diagnostic evidence. */ }
  }
  return result;
}
