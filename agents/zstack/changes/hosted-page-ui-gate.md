# Classed HTML outside the renderer must be named in check:ui's exemptions

**Symptom.** The first Web app round pushed three control-plane files
(`hosted-page.ts`, `github.ts`, `workos-browser-sessions.ts`) whose pages carry
class names, and `pnpm check:ui` failed each as "class names compiled by
nothing". The same push broke the root suite's
`scripts/__tests__/web-shell-tokens.test.ts`: it pinned the shell's palette by
regex-parsing `page.ts`, and the palette had moved into an exported object.
Only lint and the secret scan had run before that push.

**Cause.** check:ui treats classed markup outside the Tailwind `@source` roots
as unstyled app markup unless `SOURCE_EXEMPT` names it. These pages style
themselves with one inline stylesheet, like `apps/web`'s pages, which were
already exempt; the control plane had never served classed HTML before.

**Rule.** When server code starts emitting classed HTML, add those files to
`SOURCE_EXEMPT` with the reason, naming files rather than the package so
Tailwind markup added there later is still caught. Never add an `@source` for
markup Tailwind should not compile: it would ship stray utilities to the app.
A test that pins another module's values imports its exports instead of
parsing its source text, so a restructure cannot blind it. Run every handoff
gate in `AGENTS.md` before each push, not a subset: `pnpm test:git` runs the
root suite.

**Encoded in.** The control-plane entry in `SOURCE_EXEMPT`
(`scripts/check-ui-consistency.mjs`) and eval case `hosted-page-ui-gate`, fixed
by commit d136d382; `web-shell-tokens.test.ts`, which now imports
`SHELL_TOKENS`, and eval case `web-shell-tokens-exports`.
