// ──────────────────────────────────────────────────────────
// site.ts — shared constants + nav model for the marketing site
// ──────────────────────────────────────────────────────────

/**
 * Fixed URL that always serves the newest release's .dmg. No per-release edits:
 * `/releases/latest/download/` follows whatever GitHub marks Latest, and
 * .github/workflows/release.yml uploads a CONSTANT-named `Zeros-arm64.dmg`
 * alongside the version-stamped one for exactly this purpose.
 *
 * This was a Cloudflare R2 URL, on the reasoning that github.com release assets
 * "carry a per-release, version-stamped asset name". That was never true of
 * this repo — the constant-named copy has always been uploaded — and the whole
 * bucket existed only because the repo was private. Verified: HTTP 206 on a
 * Range request, anonymously.
 */
export const DOWNLOAD_URL =
  'https://github.com/Withso/zeros/releases/latest/download/Zeros-arm64.dmg'

export const GITHUB_URL = 'https://github.com/withso/zeros'

/** Docs move to Mintlify later; keep the path stable so the link survives. */
export const DOCS_URL = '/docs'

export const DOWNLOAD_META = 'Public beta · Apple Silicon · Free'

/** Primary top-nav links (right side, before the Download button). */
export const NAV_LINKS: { label: string; href: string; external?: boolean }[] = [
  { label: 'Changelog', href: '/changelog' },
  { label: 'Docs', href: DOCS_URL },
  { label: 'GitHub', href: GITHUB_URL, external: true },
]
