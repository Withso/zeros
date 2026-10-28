# Anything published on every change needs retention in the same change

- **Symptom.** The Alpha runtime bucket reached 135 GB, almost all of it v1
  runtimes, and nobody noticed until the storage bill showed it.
- **Cause.** Each publish uploaded a content-addressed archive of about
  300 MB, and nothing ever deleted one. Retiring v1 left all of its runtimes
  behind.
- **Rule.**
  - A pipeline that publishes an artifact per change ships its retention
    alongside it.
  - Keep what a live deployment may still fetch: its pin, a couple of the
    newest, and a grace window for concurrent publishers.
  - Remove indices before the archives they name.
  - Never age out a store with a lifecycle rule that cannot see the pin.
  - When a system is retired, delete its stored artifacts with its code.
- **Encoded in.** `apps/control-plane/src/cloud/runtime-retention.test.ts` and
  the retention cases in `publish-runtime.test.ts`.
