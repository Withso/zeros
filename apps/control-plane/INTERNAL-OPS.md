# Zeros Internal MCP

Development agents inspect Zeros infrastructure through the Zeros Internal MCP,
`https://internal.zeros.build/mcp` (streamable HTTP). They do not read provider
keys from `.env.agent`, environment variables or the checkout. The private
Zeros-Internal repository owns the service, its provider adapters, its
deployment and its secret store.

## Access

The endpoint sits behind Cloudflare Access. You connect by signing in as a
Zeros Internal person: the client opens the Access OAuth sign-in in a browser
and keeps the resulting token in its own private store. Nothing to copy, and no
credential in the checkout, a project `.mcp.json`, command text or chat output.

Unattended runners that cannot sign in interactively: ask an owner.

## Connect a client

Name the server `zeros-internal` in every client so instructions match.

**Conductor workspaces.** The workspace owner adds the URL once in Conductor
Settings → MCP with OAuth and signs in. New workspaces, local or cloud, pick
up the server from those settings; sign in again if one prompts. The repository tracks no `.mcp.json`, and `.worktreeinclude`
copies nothing into new worktrees.

**Claude Code outside Conductor.** Add the server, then run `/mcp` in a session,
choose `zeros-internal` and authenticate:

```sh
claude mcp add --transport http zeros-internal https://internal.zeros.build/mcp
```

**Codex.** Add the server, then sign in:

```sh
codex mcp add zeros-internal --url https://internal.zeros.build/mcp
codex mcp login zeros-internal
```

**Other clients.** Register the URL as a streamable HTTP server with OAuth and
sign in when the client prompts.

## Verify

Call `whoami` first to confirm the identity Access admitted. Then call the
`check_*` tools for the providers the task needs; they replace the provider half
of `pnpm agent:check`. A refused `whoami` means the sign-in is missing or expired:
authenticate again, ask an owner if access is still refused, and do not fall
back to copying provider keys.

## Tools

Tools act on Alpha unless their description says otherwise. Read the server's
tool list for the current set and each tool's arguments.

| Area | Tools |
|---|---|
| Identity and health | `whoami`, `check_*` |
| Railway | `railway_deployments`, `railway_logs` |
| Database | `db_query`, `planetscale_branch`, `planetscale_backups`, `planetscale_insights` |
| Boat | `boat_inventory`, `boat_cleanup_*` |
| Cloudflare | `r2_list_objects`, `r2_folder_summary`, `r2_put_object`, `r2_delete_objects`, `cloudflare_storage`, `pages_deployments` |
| WorkOS | `workos_user`, `workos_organization`, `workos_membership` |
| Costs and incidents | `cloud_costs`, `incidents_list` |
| Connections and approvals | `connection_request`, `connection_status`, `approval_status`, `approval_resume` |

Write tools (`r2_put_object`, `r2_delete_objects`, `boat_cleanup_*`) change
Alpha state. Use them only when the task calls for that change, and follow any
approval the tool requests. More Alpha write tools are being added.

## Operator fixtures

gate0, the Alpha rehearsal, local fixture seeding and the native Alpha check
still read operator fixture fields from a private `.env.agent` in a trusted
checkout (template: `.env.agent.example`). Workspace setup refuses a
`.env.agent` copied into a new worktree or Conductor workspace. An operator
imports one deliberately with
`node scripts/dev-environment/agent-env.mjs import <file>`, and
`pnpm agent:check` warns about any linked worktree that holds provider keys.
