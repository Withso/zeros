# Check every runtime consumer when a provider field becomes a union

- Symptom: a Codex upgrade broke desktop typechecking because image generation
  no longer always carries an inline result; the standalone worker still pinned
  the older runtime and read-side type. Packaging tests also expected removed zsh
  files and an old version inside an escaped native-smoke regex.
- Cause: regenerated desktop bindings exposed an attachment-store/inline union,
  while copied worker shapes and package resource assertions did not move with
  the runtime. A plain version-string search did not find the escaped regex.
- Rule: compare every consumed wire variant in both placements, retain a typed
  fixture for each union branch, and run the relocated package smoke against the
  installed binary after a frozen install. Stage the actual pinned resource
  tree, including notices; explicitly record any decision to defer exclusions.
- Encoded in desktop `transcript-fidelity.test.ts`, worker Codex parity streams
  and `package.test.ts`, both typechecks, and `stage-codex-cli.test.ts`. The
  protocol coverage manifest and complete surface inventory make unconsumed
  additions explicit without claiming product support.
