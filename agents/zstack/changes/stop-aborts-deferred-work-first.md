# Stop aborts deferred work before cancelling what it waits for

- **Symptom.** Cancelling the background fetch during Stop could release a
  setup script that was waiting for it, so the script started while the
  checkpoint read the checkout.
- **Cause.** The deferred setup awaited the fetch. Cancelling the fetch first
  resolved that wait and admitted the setup.
- **Rule.** On Stop, abort deferred work first, then cancel and join what it
  waits for, then join both. Make background Git fetches disable
  auto-maintenance, so no detached child outlives the joined process group.
- **Encoded in.** The Stop and dispose integration cases in
  `apps/cloud-worker/src/__tests__/workspace-setup.test.ts`.
