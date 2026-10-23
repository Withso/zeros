The first live gate0 on `pnpm electron:cloud` found four defects that every
offline suite had passed. Each is now a regression.

A WorkOS user who belongs to several organizations gets
`organization_selection_required` from the password grant, with no session.
gate0 and the local seed now finish the login inside the fixture's
organization only, and check the issued session's organization.

A SECURITY DEFINER helper bypasses row-level security only if its owner does.
Alpha's schema owner (`postgres`) has BYPASSRLS. The local launcher's migrator
did not, so under FORCE RLS `app_user_org_ids()` re-entered the
`organization_members` policy until PostgreSQL ran out of stack (SQLSTATE
54001) and `/v1/me` returned 500. Give a local schema owner the same authority
as the hosted owner, and keep request roles without it.

Boat's in-VM port agent (`ascii-agent.service`) forwards the protected route by
binding the worker port on the VM's own interface addresses. A loopback check
that counts every listener on the port rejects the documented transport.
Check the worker service's own sockets, and refuse wildcard binds by anyone.

Long-running services that write to `/dev/null` turn a 500 into guesswork.
The launcher now keeps private per-service logs. Diagnose through those logs,
read-only queries and status-only probes, never by printing provider output.

Never run `git stash` in a repository whose worktrees another agent shares.
The stash list is shared, so a no-op stash followed by `pop` applies the other
agent's newest entry.
