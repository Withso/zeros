# A navigation link must not start work

A native chat link could reuse the ordinary navigation path, which creates a
default chat or resumes a saved provider, and an adopted worktree it pointed at
rendered with no workspace because the renderer cache did not yet know the path.

Cause: navigation identity, cached workspace ownership and provider admission
are separate lifecycles. A valid native lookup does not update shared renderer
caches, an adopt-only guard for one cwd misses sibling panes, and asynchronous
listener cleanup can disable a replacement subscriber.

Rule: for navigation-only links, resolve and publish the exact-key ownership
snapshot before one atomic route/chat selection, fence stale reads, and keep
default-tab, provider and terminal admission passive until a deliberate
interaction. Scope the guard to the workspace, and tie listener readiness to
the current subscription identity.

Encoded in `local-link-cache.test.ts`, `use-active-workspace.test.ts`,
`local-link-admission.test.ts`, `local-link-surfaces.test.ts`,
`local-links.test.ts` and the Electron local-navigation tests;
`docs/local-cli.md` (Links).
