// ──────────────────────────────────────────────────────────
// changelog.ts — load the curated changelog entries
// ──────────────────────────────────────────────────────────
//
// Entries are hand-written Markdown files with simple frontmatter, authored
// via `pnpm changelog:new` (repo root) and committed under
// src/content/changelog/<version>.md. Cloudflare Pages rebuilds this site on
// push, so adding an entry + pushing publishes it. Because the entries are
// committed source files, the changelog keeps building even after the repo
// goes private.
// ──────────────────────────────────────────────────────────

export interface ChangelogEntry {
  version: string;
  date: string; // ISO yyyy-mm-dd
  title: string;
  summary: string;
  body: string; // markdown (frontmatter stripped)
}

/** Parse flat `key: "value"` frontmatter. Intentionally tiny — entries only
 *  carry version/date/title/summary, so no YAML dependency is needed. */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) return { data: {}, body: raw };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) data[key] = value;
  }
  return { data, body: match[2] };
}

/** Comparable numeric key for "MAJOR.MINOR.PATCH" (newest = highest). */
function semverKey(v: string): number {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : -1;
}

// Eagerly inline every entry's raw markdown at build time.
const modules = import.meta.glob("../content/changelog/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

let cached: ChangelogEntry[] | null = null;

/** All entries, newest version first. */
export function getChangelogEntries(): ChangelogEntry[] {
  if (cached) return cached;

  cached = Object.entries(modules)
    .map(([path, raw]) => {
      const { data, body } = parseFrontmatter(raw);
      const fallbackVersion = path.split("/").pop()?.replace(/\.md$/, "") ?? "0.0.0";
      return {
        version: data.version || fallbackVersion,
        date: data.date || "",
        title: data.title || `v${data.version || fallbackVersion}`,
        summary: data.summary || "",
        body: body.trim(),
      };
    })
    .sort((a, b) => semverKey(b.version) - semverKey(a.version));

  return cached;
}
