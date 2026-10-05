# Organization MCP and skills

Organization Settings has **MCP servers** and **Skills** sections. Administrators
can edit organization defaults; each member can edit their own override. The
control plane authorizes every read and write against current membership.
Device preferences and Local customization continue to use their existing local
storage. No Mac HOME configuration is imported into a cloud workspace.

Cloud admission merges organization servers, the executing member's servers,
and repository declarations, in that order. A later entry replaces the whole
server with that name; it never inherits the earlier entry's credentials.
Repository sources, in increasing precedence, are `.codex/config.toml`
`[mcp_servers]`, `.cursor/mcp.json`, and `.mcp.json`. Reads are bounded regular
files inside the checkout; symlinks that escape it are rejected. These reads
run on the Linux worker. Product names, including `design-draft` and
`cloud-computer`, remain reserved. [Computer agent tools](computer-tools.md) are
admitted separately for the immutable creator of a marked admin workspace.

Stdio servers run as children of the provider inside its existing VM execution
boundary and UID. Streamable HTTP and legacy SSE accept literal header maps;
Codex uses an in-boundary stdio relay for SSE. Remote URLs cannot embed
credentials, query strings or fragments. OAuth and implicit environment-variable
imports are unsupported and produce an explicit error. Secrets belong in the
dedicated environment/header field, not in commands or arguments.

The control plane encrypts complete customization documents and execution
snapshots using tenant/owner/revision-bound AES-GCM envelopes. Settings reads
return environment/header key names and opaque server IDs, never their values.
Omitting a secret map preserves it only when the server's name, transport and
endpoint/command are unchanged; `{}` removes it. Public grant digests bind
configuration metadata, secret references and revisions without hashing secret
values. Repository equality uses a domain-separated HMAC bound to the lease,
actor, organization and encryption-key version.

Admission pins and freezes the resolved snapshot. Updating, removing or rotating
customization releases affected leases; the existing renewal/deadline mechanism
retires their process domains within the lease's bounded lifetime (at most 45
seconds). Another actor cannot reuse a customized grant. Execution-local output
redaction removes known environment/header values, including split text/stderr
chunks. Providers and their stdio children share the active actor's trust; this
is not a separate sandbox between an MCP server and its provider.

Skills retain a name, discovery description and Markdown body. Member skills
override organization skills by name. Before launch, the engine writes the
snapshot into root-owned files and mounts it read-only at `.agents/skills`,
`.claude/skills`, `.codex/skills` and `.cursor/skills` in the execution's private
HOME. Claude and Cursor use the explicit private user setting source. Cursor
account/team settings and provider plugins are not imported; the UI reports
that limitation. Repository skills remain subject to each provider's existing
native discovery and workspace policy; this feature does not copy Local plugins
or entire account configuration directories.

Migration **0115** is additive and uses forced system-only RLS. Roll out the
migration/control plane before the new worker image. Older requests without the
optional customization capability keep their original admission behavior. New
customization requests require the exact image/provider/credential qualification
to have `mcp_qualified=true`. Version-3 native qualification requires a successful
call to a tiny stdio MCP server, canonical native tool evidence, and an independent
VM-side proof file check. Older version-1/2 evidence stays readable but cannot
enable customization. A locally passing test suite does not qualify a live image.

Customization capability version 2 also admits an engine-only, workspace-scoped
history encryption authority. The engine stores the historical literal filter
in an authenticated encrypted file outside the provider's native-history mount,
before the provider starts. Secret removal and rotation therefore keep old
native transcript values redacted across restarts. Encryption-key rotation must
retain old key versions until those histories are re-sealed. An unavailable or
invalid history envelope fails closed.

Native history is bound to the customization owner. An owner change clears the
previous raw provider store under the conversation lock and starts a fresh native
binding with bounded scrubbed conversation context. A durable reset marker makes
an interrupted handoff retry safely. Purging the raw files does not clear that
marker: only the engine's successful durable binding write acknowledges it,
including a binding emitted later by native initialization. Failed or missing
writes preserve the fresh-session requirement and scrubbed context for retry.
Acknowledgements and retirement serialize under the history lock, so a late
callback cannot clear a later owner's marker. Native forks copy the protected metadata
alongside their private history; the destination still needs its own admission.
Legacy native stores without metadata receive the same fresh-session treatment.

Codex reads only admitted MCP definitions: its user and system configuration
namespaces are immutable mounts, and the process override suppresses repository
config layers even if files change after admission. Repository declarations are
read once by the engine's bounded reader. Claude's strict MCP config and Cursor's
explicit settings sources retain their existing admitted behavior.

Publication filtering preserves protocol identities and permission choices,
withholds incomplete literals in text and cumulative tool snapshots, and scrubs
startup/resume/prompt errors before teardown. Field names and protocol identities
stay intact even when a configured value matches a nested field name. Ambiguous
trailing prefixes are redacted at termination, including diagnostic line ends
and stack headers. Native image qualification additionally exercises
secret rotation, removal and an owner handoff through real provider resumes;
those paid image checks must be run before rollout.
