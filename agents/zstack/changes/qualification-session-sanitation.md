# Qualification cleanup before snapshot sanitation

- Symptom: the saved template retained nonempty synthetic session metadata even
  though the qualifier retired and the live sanitizer passed.
- Cause: the ordinary Host cleanup unlinked the session before the sanitizer
  could overwrite it. Incremental capture can retain deleted child entries;
  a parent directory mtime is not a sanitation completion timestamp.
- Rule: exercise the actual producer retirement before sanitation and model a
  saved tree retaining deleted children. Select bookkeeping retention only in
  the fixed qualifier, keep native cleanup/proofs and saved-tree rejection,
  and bound the remaining empty footprint. Do not broaden generic session GC.
- Checks: the Cloud execution-boundary regression runs real Host process
  retirement and the Python sanitizer, then checks captured-byte replacement,
  unchanged ordinary cleanup, dead-owner GC and retirement refusal. The
  qualification composition test pins the explicit caller.
- Diagnostic lesson: retain the closed failed-check vocabulary before builder
  deletion. The real-Postgres worker suite rejects unknown fields/checks and
  verifies that reporting failure cannot replace the original build failure.
