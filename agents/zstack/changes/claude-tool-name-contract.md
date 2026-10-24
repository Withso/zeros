# Claude tool-name contract

- Symptom: a provider tool rename can leave a native transcript on the generic
  fallback while declaration and fixture tests still pass.
- Cause: locally written matchers and alias pairs can drift from the installed
  SDK; a copied test inventory can drift with them.
- Rule: compare the names in actual routing expressions with the SDK's runtime
  inventory, retain an explicit retired-name compatibility list, and resolve
  supported aliases through the SDK without rewriting persisted identities.
  An accepted legacy spelling must also have its canonical target covered;
  alias membership alone would still miss live calls after a rename.
  Scope source assertions to tool inputs; context category names and chat titles
  are different data. Keep other providers' title exceptions tied to their files.
- Encoded in desktop, renderer and cloud `tool-name-contract` suites and the
  `claude-tool-name-contract` seeded eval. Mocked SDK removal must fail the real
  contract tests before a runtime upgrade is considered qualified.
