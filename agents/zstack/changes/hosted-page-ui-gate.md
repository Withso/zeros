# Classed HTML outside the renderer must be named in check:ui's exemptions

**Symptom.** The first Web app round pushed three control-plane files
(`hosted-page.ts`, `github.ts`, `workos-browser-sessions.ts`) whose pages carry
class names, and `pnpm check:ui` failed each as "class names compiled by
nothing". Only lint and the secret scan had run before that push.

**Cause.** check:ui treats classed markup outside the Tailwind `@source` roots
as unstyled app markup unless `SOURCE_EXEMPT` names it. These pages style
themselves with one inline stylesheet, like `apps/web`'s pages, which were
already exempt; the control plane had never served classed HTML before.

**Rule.** When server code starts emitting classed HTML, add those files to
`SOURCE_EXEMPT` with the reason, naming files rather than the package so
Tailwind markup added there later is still caught. Never add an `@source` for
markup Tailwind should not compile: it would ship stray utilities to the app.
Run every handoff gate in `AGENTS.md` before each push, not a subset.

**Encoded in.** The control-plane entry in `SOURCE_EXEMPT`
(`scripts/check-ui-consistency.mjs`) and eval case `hosted-page-ui-gate`.
