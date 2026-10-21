# Cloud worker runtime

The worker is a Linux process for one organization workspace. It imports shared
protocol code, never the Local engine. Local Personal and organization-local
workspaces retain their existing runtime. Native provider fixtures and boundary
tests verify the separation; no live credentials are needed for these tests.

The renderer's cloud wire maps cloud keys to native values before requests reach
the worker. `workspace.list` returns `{ workspaces: [row] }` with the configured
workspace UUID and absolute checkout path; `workspace.get` returns that row.
File arrays and Git paths remain relative to the checkout. The worker checks both
lexical and descriptor containment, including symlinks, before file access.

Chat metadata and transcript rows are durable worker snapshots, mirrored to the
control plane. Git target metadata lives beside those snapshots in
`workspace.json`; it survives restart and repeated copies of the same config.
A changed configured base branch replaces that metadata. Target selection itself
does not rebase, stash, or change HEAD. An explicit `rebase:true` opts into rebase.

File services provide tree, ignored-directory, bounded read, atomic text write,
and directory listing operations. Git services provide status, independent
comparison counts, line totals, bounded diff, log/show, branch lists, staging,
commit, fetch/push/pull, branch operations, stash, integration and tag operations.
Git mutations share a queue; reads remain independent. Native HEAD/ref changes
and checkout file changes emit `DB_CHANGED` for the native workspace UUID.
PR metadata is cached by branch and invalidated by ref changes and Git mutations.

Unsupported operations always return `CLOUD_V2_UNSUPPORTED`. The explicit lists
in `workspace/chat-service.ts` and `workspace/git.ts` have regression tests.
Git reset/restore/clean, hunk mutations, repository creation/catalog operations,
and turn checkpoint history are deferred. No request is silently acknowledged.

Offline acceptance uses temporary Git repositories and a fake relay. Live
provider, Boat, model proxy, and private-GitHub acceptance belongs to the
integration owner; a Linux test does not establish macOS engine parity.
