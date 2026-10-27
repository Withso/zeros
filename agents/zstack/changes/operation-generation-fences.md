# Fence an operation by its generation, not by state and resource identity

- **Symptom.** A stalled save from an earlier Stop replaced the checkpoint of
  a later Stop and then retired it. A late create reply from an earlier
  restore attempt took a later attempt's slot, so the later VM was never
  tracked.
- **Cause.** The compare-and-set checked workspace, sandbox and state. States
  cycle (stopping → stopped → running → stopping), so an old operation looked
  current again. One shared "upload until" time also let a later success
  clear an earlier unresolved upload.
- **Rule.** Give each operation an immutable generation and require it in
  every record, completion and destructive step: here a `stop_generation`
  bumped on each entry into stopping, and a restore `attempt`. Track
  uncertainty per operation, and clear an entry only on evidence that its own
  operation is over.
- **Encoded in.** "refuses a late save from an earlier stop" and the
  attempt/upload-intent cases in
  `apps/control-plane/src/cloud/store.integration.test.ts`, plus "leaves the VM
  to a later stop once this one has been replaced" in `lifecycle.test.ts`.
