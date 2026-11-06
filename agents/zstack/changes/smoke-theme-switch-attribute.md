# A smoke switches themes through `data-theme`, never a class on `<html>`

Target: `skills/zstack-verify` (UI smoke evidence) and `playbooks/ui-design.md`
step 7 ("Look at the result … in both themes").

**Symptom.** While widening chat tabs to 176px, the draft-indicators smoke
was found to loop over `["dark", "light"]` by setting
`document.documentElement.className = theme`. Every one of its "light"
checks had been re-checking Dark: no stylesheet in `styles/` matches a theme
class, and the harness never reads one. A scratch capture made the same way
also stayed Dark until it set the attribute.

**Cause.** The app resolves its appearance with `data-theme` on the
document element (`shared/theme/derive.ts`, `styles/semantic-tokens.css`
`[data-theme="light"]`). A class looks plausible, throws nothing and leaves
every assertion that ignores color passing, so the gap only shows when a
check reads a themed value.

**Rule.** In a smoke or capture, switch themes with
`document.documentElement.dataset.theme = theme`, and make each theme pass
assert at least one resolved token (`getComputedStyle` of a
`var(--bg1)` probe) so a switch that did not happen fails instead of
re-checking the default.

**Encoded in.** This fragment; `scripts/ui-smoke-draft-indicators.mjs` and
`scripts/ui-smoke-chat-surfaces.mjs` (which compares the fills it reads with
the resolved `bg1` and `sidebar-bg` of each pass).
