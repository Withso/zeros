# Guard the complete engine source closure

- Symptom: source-engine qualification could not load a verifier that worked
  in the checkout and bundled CLI.
- Cause: the verifier and its contract lived outside the staged source slices.
- Rule: compare the engine's transitive source import graph, including lazy
  imports, with the runtime staging inventory before publication.
- Encoded in `scripts/__tests__/cloud-runtime-bundle-closure.test.ts`, also
  exercised by the existing `runtime-source-import-closure` eval.
