# Completed Design nudge smoke synchronization

- Symptom: the canvas smoke intermittently expected one keyboard save but
  observed zero on its first run.
- Cause: a Foundation read could belong to the inspector while the completed
  keyboard gesture still awaited its iframe preview acknowledgement. The
  submitted-mutation drain could therefore return before the gesture submitted
  its transaction.
- Rule: await the operation's full retained completion before checking either
  its accepted save or its refusal. A populated read log or an empty downstream
  queue cannot replace that completion boundary.
- Encoded in `runDesignCompletedNudgeRuntimeSmoke`: hold a real preview reply,
  observe one retained gesture, prove the submitted queue is still empty, then
  release and join that exact completion. Keep all three exact-one positives
  and all four exact-zero owner/runtime replacement controls.
- The page replacement control starts from the fixture's resolved page and
  confirms that A-B-A changes its owner generation. Starting on a nonexistent
  synthetic page could reject the selection before a gesture existed and make
  the zero-write assertion pass without exercising a pending refusal.
- Scope: smoke instrumentation only; Local and cloud product behavior, identity
  fences, transaction semantics and timeouts stay unchanged.
