// ──────────────────────────────────────────────────────────
// markdown-file-path — "is this inline code an openable file?"
// ──────────────────────────────────────────────────────────
//
// Pure detection + safety boundary for the clickable file references in agent
// output (see markdown.ts > linkifyFilePaths and text-message.tsx). Kept free
// of the marked / DOMPurify imports so it stays unit-testable in the node test
// env (the rest of markdown.ts can't load without a DOM).
// ──────────────────────────────────────────────────────────

// A span is treated as an openable file when it IS one of these extensions
// (optionally with a `:line[:col]` suffix). The list is kept to the source /
// config / doc files an agent actually references — deliberately NOT a
// catch-all — so prose tags like `ready` or `mcp_auth` stay plain. The optional
// leading `/` admits absolute POSIX paths, which agents reference as often as
// relative ones (e.g. a `[name](/Users/…/x.ts)` link); the workspace boundary
// for those is enforced at OPEN time, not here.
export const FILE_PATH_RE =
  /^\/?[\p{L}\p{N}_.()-]+(?:[ /][\p{L}\p{N}_.()-]+)*\.(?:tsx?|jsx?|mjs|cjs|json5?|jsonc?|md|mdx|markdown|css|s[ac]ss|less|html?|xml|svg|vue|svelte|astro|py|rb|rs|go|java|kts?|swift|c|cc|cpp|cxx|hh?|hpp|mm?|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|gql|ya?ml|toml|ini|cfg|conf|env|lock|txt|log|proto|prisma|tsv|csv|png|jpe?g|gif|webp|bmp|ico|avif|heic|heif|pdf|zip|mp[34]|wav|webm|ogg)(?::\d+(?::\d+)?)?$/iu;

/** If `raw` looks like a file reference — optionally with a `:line[:col]`
 *  suffix, a leading `./`, or a `file://` scheme — return the bare path;
 *  otherwise null. Accepts BOTH a workspace-relative path and an absolute POSIX
 *  path (agents reference files both ways). Only parent (`..`) traversal and
 *  non-file strings are rejected here. Shared by the linkifier and the chat
 *  click handler so a `[name](path)` link and an inline `` `path` `` chip
 *  resolve identically. The workspace boundary for an absolute path is enforced
 *  at OPEN time (relativised against the chat's cwd + read-gated), not here — so
 *  an out-of-workspace absolute path simply opens nothing instead of rendering
 *  as an external link that navigates the app away. */
export function fileRefPath(raw: string, explicit = false): string | null {
  let s = raw.trim();
  if (!s || s.length > 4096) return null;
  if (/^file:/i.test(s)) {
    if (!/^file:\/\/\//i.test(s)) return null;
    s = s.slice(7);
  }
  try { s = decodeURIComponent(s); } catch { return null; }
  // eslint-disable-next-line no-control-regex -- reject unsafe control bytes in native file references
  if (/[\x00-\x1f\x7f<>"\\?#]/.test(s) || s.startsWith("//")) return null;
  s = s.replace(/:\d+(?::\d+)?$/, "").replace(/^\.\//, "");
  if (s.includes(":") || s.split("/").some(seg => seg === "..")) return null;
  // Explicit links/resources may name extensionless deliverables. Inline code
  // stays conservative so identifiers and package names retain their styling.
  if (!FILE_PATH_RE.test(s) && !(explicit && /^[\p{L}\p{N}_ .()/@+%&,;=!-]+$/u.test(s))) return null;
  return s;
}
