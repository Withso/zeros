# Precompiled cloud qualification roles

Symptom: loading fixed qualification roles repeatedly paid for TypeScript
transforms inside the original controller.

Cause: source execution deliberately reaps one-shot compiler children. Moving
that work to artifact construction changes module location and dependency
ownership: a package-private dependency is not necessarily visible at the
worker root, and flattened module URLs can run standalone entry guards or
misplace native helpers.

Rule: test the generated graph after relocation, with source transforms denied.
Preserve original module URLs and a single shared boundary/registry graph;
retain source compatibility without falling back from a broken built entry.
Compilation never precomputes an authority or retirement proof.

Encoded in `cloud-qualification-loader.test.ts`,
`cloud-qualification-bundle.test.ts` and the runtime publication closure probe.

Builder-stage changes also reach focused fixtures that stop before payload
staging. Run `cloud-runtime-browser-closure.test.ts` when adding a compilation
stage: its synthetic stage allowlist must cover the new compilation while its
real pinned browser CLI and headless-only assertions remain intact. Unknown
stages still fail instead of being silently mocked.

A parallel runner-qualification change added a required loader role without
adding its source to the compiled graph. Verify the combined tree after a
rebase: the artifact must load every fixed role with source transforms denied,
and missing or invalid runner exports must still refuse. The publication probe
checks every role returned by the closed loader, avoiding a third role list.
The bundle and loader suites retain these controls. When merging image-recipe
changes, strip both declared additions from the historical hash comparison;
never replace that pinned hash to accommodate a conflict resolution.
