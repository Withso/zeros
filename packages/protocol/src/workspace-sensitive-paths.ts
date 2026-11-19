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
  // Normalize before classification so the path check agrees with the path the file reader resolves.
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
  // Keep public .env templates shareable even though they match the .env prefix.
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
