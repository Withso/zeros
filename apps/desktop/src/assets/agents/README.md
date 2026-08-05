# Bundled agent icons

These SVGs are vendored from `@lobehub/icons-static-svg@1.94.0` so the desktop
renderer can display agent marks offline and under its Content Security Policy.

| Local file     | Upstream asset       |
| -------------- | -------------------- |
| `claude.svg`   | `icons/claude.svg`   |
| `codex.svg`    | `icons/openai.svg`   |
| `cursor.svg`   | `icons/cursor.svg`   |
| `opencode.svg` | `icons/opencode.svg` |

The files are exact upstream SVG content (ignoring a final newline). Lobe Icons
is MIT licensed; attribution and the license text are preserved in the root
[`THIRD-PARTY-NOTICES.md`](../../../../../THIRD-PARTY-NOTICES.md). Product names
and marks remain the property of their respective owners and do not imply
endorsement.

When updating an icon, pin and record the source package version, compare the
vendored bytes, and update the third-party notice in the same change.
