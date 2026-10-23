# Cloud v2 integration lessons

- **Metadata-only writes still advance the document version.** The renderer
  orders cloud workspace documents by `updatedAt`. Archive only set a flag, so
  without an `updatedAt` advance the response looked stale and the row stayed
  "running". Advance the version and keep the lifecycle retry counters separate.
  Encoded in `store.integration.test.ts`: "versions archive metadata without
  rescheduling a stop already in progress".
- **Fake a worker with the worker's own rows.** The first gate0 fake answered
  `workspace.list` with the HTTP workspace document. The worker returns Local's
  native row (`repoSlug`/`status`, without HTTP `repository`/`state`). The
  correct fixture failed three probe stages before the probe fix landed (see
  the `gate0.test.ts` native-row case).
- **Retiring a producer rejects its persisted receipts.** v1 `lastGood`
  receipts must not report a v2 publication; the runtime delivery regression
  encodes this.
- **Dropping a test database right after `pool.end()` can race.** In the
  retained PostgreSQL fixture, `DROP DATABASE … WITH (FORCE)` immediately
  after `pool.end()` raced socket teardown. A plain `DROP` passed.
- **A wire version bump moves the runtime pin.** Removing v1 envelope members
  needed `PROTOCOL_VERSION` 21, with the minimum still 2. The worker bundles the
  protocol, so its runtime SHA-256 changed. Publish the runtime and set the Dev
  `CLOUD_V2_RUNTIME_SHA256` before gate0 (`playbooks/integrate-pr.md`).
- **A consumer scan needs barrel exports and field readers.** Direct
  module-path imports missed `CloudAgentConnectionHealthSchema` imported via
  the `@zeros/protocol` barrel. They also missed renderer reads of core fields
  such as `session.boundary?.browser`. Search for exported symbols and field
  names, then let a full typecheck confirm.
- **A shared `node_modules` can typecheck the wrong package.** A worktree whose
  `@zeros/*` links point into another checkout resolves that checkout's
  protocol, so its typecheck passes against the other checkout's code. Link
  `@zeros/*` to the worktree's own packages before trusting the run.
