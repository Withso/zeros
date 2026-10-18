# Computer build graceful handoff

- Symptom: a control-plane deploy marked an in-flight Computer recipe as a
  failed build and cleaned its builder despite no recipe failure.
- Cause: the worker treated its own shutdown flag as loss of build authority;
  restarting the entire pipeline would also replay a non-idempotent clone and
  change the frozen helper's durable recipe identity.
- Rule: stop taking work, then yield only at an acknowledged checkpoint. Keep
  helper identity, pins, stage, original deadline and physical resource while
  advancing the process fence. An uncheckpointed crash is not adoption proof.
  Check the application's and provider's termination windows together.
- Encoded in the Computer worker and claim integration regressions, migration
  0163, and `docs/cloud-workspace/computer-template-builds.md`. Tests hold real
  worker boundaries across shutdown, race adopters, retain terminal failures,
  exercise changed runtime heads/revocations, and keep log cursors without raw
  redactor state. The frozen Python helper's idempotence test stays unchanged.
