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
