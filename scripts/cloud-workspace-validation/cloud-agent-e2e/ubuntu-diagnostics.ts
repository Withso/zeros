/** Apt/native bootstrap text remains private; only these fixed ids leave it. */
export function ubuntuFailureDiagnostic(error: { stdout?: unknown; stderr?: unknown }) {
  const allowedSteps = new Set(["ownership", "apt_update", "apt_install", "inventory"]);
  const patterns = [ ["file_missing", /No such file or directory/], ["permission_denied", /Permission denied|Operation not permitted/],
    ["dns_unavailable", /Temporary failure resolving|Could not resolve/], ["network_unavailable", /Network is unreachable|Connection timed out|Failed to fetch/],
    ["package_unavailable", /Unable to locate package|no installation candidate/], ["package_verification_failed", /NO_PUBKEY|not signed|signature.*invalid/i],
    ["dpkg_failed", /Sub-process.*dpkg.*error|dpkg: error/], ["private_namespace_required", /private_(mount|pid)_namespace_required|private_root_required/],
    ["native_loader", /GLIBC_|error while loading shared libraries/], ] as const;
  const text = (value: unknown) => Buffer.isBuffer(value) ? value.toString("utf8").slice(-256 * 1024) : typeof value === "string" ? value.slice(-256 * 1024) : "";
  try {
    const value = JSON.parse(text(error.stdout).trim());
    if (value.code === "ubuntu_package_install_failed" && allowedSteps.has(value.step) && Array.isArray(value.diagnostics) && value.diagnostics.length <= 8 &&
      value.diagnostics.every((id: unknown) => patterns.some(([known]) => known === id)))
      return { step: String(value.step), diagnostics: value.diagnostics as string[] };
  } catch { /* Bootstrap errors may precede the private installer protocol. */ }
  return { step: "bootstrap", diagnostics: patterns.filter(([, regex]) => regex.test(text(error.stderr))).map(([id]) => id) };
}
