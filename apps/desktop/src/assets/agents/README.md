# Bundled agent icons

These SVGs are vendored from `@lobehub/icons-static-svg@1.94.0` so the desktop
renderer can display agent marks offline and under its Content Security Policy.

| Local file         | Upstream asset                         |
| ------------------ | -------------------------------------- |
| `claude.svg`       | `icons/claude.svg`                     |
| `codex.svg`        | `icons/codex.svg`                      |
| `codex-color.svg`  | derived from `icons/codex.svg` (below) |
| `cursor.svg`       | `icons/cursor.svg`                     |
| `opencode.svg`     | `icons/opencode.svg`                   |

The files are exact upstream SVG content (ignoring a final newline), except
`codex-color.svg`. `codex.svg` is byte-identical to the marketing site's
`apps/marketing/public/agents/codex.svg` and is the single-colour twin that
monochrome surfaces use. `codex-color.svg` draws the same upstream path over a
white ellipse (so the `>_` prompt reads white) and fills it with the Codex app
mark's gradient, `#B1A7FF` → `#7A9DFF` → `#3941FF`, as specified by the
maintainer on 2026-09-28.

```text
codex.svg        656f91313a645926015cf6b3944a2e6b13339da5b89c5474e68b2791afe1fb70
codex-color.svg  9841d9072aa4107faf80e864678c3ed44cdc7d027322a07b12c66a16d5a38f7e
``` Lobe Icons
is MIT licensed; attribution and the license text are preserved in the root
[`THIRD-PARTY-NOTICES.md`](../../../../../THIRD-PARTY-NOTICES.md). Product names
and marks remain the property of their respective owners and do not imply
endorsement.

When updating an icon, pin and record the source package version, compare the
vendored bytes, and update the third-party notice in the same change.
