const SENSITIVE_DIR_SEGMENTS = new Set([
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
]);
const SENSITIVE_BASENAMES = new Set([
  "zeros-dev-env.json",
  ".npmrc",
  ".netrc",
  "_netrc",
  ".pgpass",
  ".htpasswd",
  ".dockercfg",
  ".git-credentials",
  ".pypirc",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
]);
const SENSITIVE_EXTS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".keystore",
  ".jks",
  ".ppk",
  ".tfstate",
  ".ovpn",
  ".cert",
]);
// Credential-dump JSON/YAML (GCP service accounts, Firebase admin SDK, etc.).
const SENSITIVE_CRED_NAME_RE =
  /(service[-_]?account|credential|secret|gcp[-_]?key|adminsdk)/i;
const STRUCTURED_DATA_EXT_RE = /\.(json|ya?ml)$/i;
// Public templates are intentionally shareable: `.env.example` (suffix) and
// `credentials.example.json` (infix) both carry placeholder values, not secrets.
const ENV_PUBLIC_SUFFIX = /\.(example|sample|template|dist)$/i;
const PUBLIC_TEMPLATE_INFIX = /\.(example|sample|template|dist)\./i;

/** True when a repo-relative path points at a credential/secret that must
 *  never be served to a remote client (regardless of .gitignore state). */
export function isSensitiveWorkspacePath(relPath: string, normalize: (value: string) => string): boolean {
  // Collapse '.', '..' and redundant separators FIRST. readWorkspaceFile opens
  // path.resolve(cwd, rel) (which collapses these), so without normalizing here
  // a trailing './' or 'x/..' would smuggle a denied basename past the segment
  // check — a universal denylist bypass.
  let norm = (relPath ?? "").replace(/\\/g, "/");
  norm = normalize(norm);
  const segments = norm.split("/").filter((s) => s && s !== "." && s !== "..");
  for (const seg of segments) {
    if (SENSITIVE_DIR_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  if (!base) return false;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (
    SENSITIVE_CRED_NAME_RE.test(base) &&
    STRUCTURED_DATA_EXT_RE.test(base) &&
    !PUBLIC_TEMPLATE_INFIX.test(base)
  ) {
    return true;
  }
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot) : "";
  if (SENSITIVE_EXTS.has(ext)) return true;
  // Match `.env` and `.env.local` (prefix form), `prod.env`/`local.env`
  // (suffix form), and framework variants like `.flaskenv`. Public templates
  // (`.env.example`) stay shareable via the ENV_PUBLIC_SUFFIX carve-out.
  if (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".env") ||
    base === ".flaskenv"
  ) {
    return !ENV_PUBLIC_SUFFIX.test(base);
  }
  return false;
}
