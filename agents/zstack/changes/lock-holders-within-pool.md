# Size long-held lock connections to the pool

- **Symptom.** Raising Cloud Computer build concurrency to three looked safe in
  tests, but the worker role's pool holds only two connections. Each running
  build keeps one dedicated advisory-lock connection for its whole run, so two
  builds left none for their own queries or the lifecycle.
- **Cause.** Tests used a larger pool and one queued build at a time; nothing
  exercised several organizations' builds against the production pool size.
- **Rule.** Before raising the concurrency of work that holds a connection
  across provider I/O, read the role's pool size (`createPool` workload
  defaults) and keep at least one connection free for everything else. Test
  concurrent jobs against that size, not the fixture's pool.
