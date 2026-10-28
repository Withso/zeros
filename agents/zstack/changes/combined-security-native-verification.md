# Combined security and native verification

- Browser smoke probes used IPv4 while the development server could bind to
  IPv6 localhost. Pin the runner to the same loopback address and retain the
  private-file serving rules. Both browser smoke entrypoints use `ui-smoke`
  mode, with the full harness scan and HMR disabled; the configuration suite
  checks these launch contracts.
- A FIFO test failed before reading its fixture because Node 22 could not
  import a CommonJS TypeScript module's named ESM export. Use the matching
  `tsx/cjs` loader, preserve the child deadline and expose bounded diagnostics.
  Linux-specific device fixtures must explicitly select Linux and supply
  descriptor-bound mount metadata on native hosts; selecting the platform alone
  does not supply `/proc` on macOS. The separate default-host case retains real
  kernel reads on Linux.
- The packaged worker fixture compared an in-flight request against a mutable
  token expectation after reading its body. Record the header's generation,
  atomically replace the token file, and require the specifically induced new
  history mutation to use the rotated credential. Unknown credentials still
  fail authentication.
- The native media smoke attempted to run the Linux-only worker reader on
  macOS. Keep that implementation on Linux. Report the Mac cloud-response
  fixture explicitly and run both hosts so native playback and the real worker
  reader each have evidence. Do not broaden worker filesystem authority to
  make a cross-platform harness pass.
- Test subprocesses use CI's `umask 022`. A private runner may retain `077` for
  its own evidence and secrets, but that mode makes ordinary context fixtures
  private and correctly excludes them from the context graph. Preserve explicit
  private-file fixtures and every privacy assertion.
- Full migration-replay cases use the migration ladder's explicit 30-second
  test budget. A five-second unit deadline timed out while all SQL transactions
  were still progressing; keep every approval and schema assertion. Custom
  local PostgreSQL clusters must also provide the `postgres` administrative
  role that the CI service and hosted authority check expect, without granting
  it to the runtime fixture.
