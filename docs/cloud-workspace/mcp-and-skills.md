# Organization MCP and skills

Organization Settings has **MCP servers** and **Skills** sections. Administrators
can edit organization defaults; each member can edit their own override. The
control plane authorizes every read and write against current membership.
Device preferences and Local customization continue to use their existing local
storage. No Mac HOME configuration is imported into a cloud workspace.

Cloud admission merges organization servers, the executing member's servers,
and repository declarations, in that order. A later entry replaces the whole
server with that name; it never inherits the earlier entry's credentials.
Only the requesting provider's repository source is read: Claude `.mcp.json`,
Codex `.codex/config.toml` `[mcp_servers]`, or Cursor `.cursor/mcp.json`.
Another provider's file cannot block the turn. The engine reads bounded regular
files (at most 64 KiB) from the admitted managed cwd, rejects final symlinks and
escaping descriptors, and resolves accepted
relative server cwd values against that same root after control-plane echo
validation. Product names, including `design-draft` and
`cloud-computer`, remain reserved. [Computer agent tools](computer-tools.md) are
admitted separately for the immutable creator of a marked admin workspace.

Stdio servers run as children of the provider inside its existing VM execution
boundary and UID. Streamable HTTP and legacy SSE accept literal header maps;
Codex uses an in-boundary stdio relay for SSE. Remote URLs cannot embed
credentials, query strings or fragments. OAuth and implicit environment-variable
imports are unsupported. Secrets belong in the
dedicated environment/header field, not in commands or arguments.

Optional repository configuration is tolerant. A malformed, unsafe or oversized
file contributes no servers; invalid or unsupported entries are excluded while
valid entries continue. Digit-leading names such as `0canvas` are valid. Accepted
servers are bounded to 32 and only that accepted set enters the digest and echo.
At most 16 exclusion notices carry a closed reason, fixed provider filename and
optional validated server ID of at most 64 characters, bounding serialized bytes;
they never contain config excerpts, URLs, commands,
environment values or parser errors. The transcript shows bounded counts.
Required organization policy and authority failures still fail closed with a
[typed failure](lifecycle-diagnostics.md#agent-command-failures).

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
HOME. Claude and Cursor retain the explicit private user setting source for
these admitted skills. Cursor's `.cursor` config view is engine-owned and
read-only, with separate writable history and read-only skill mounts; it cannot
acquire user MCP declarations from the checkout. Codex repository `.agents/skills`
discovery is independently tested with raw project config disabled. Other native
repository/plugin discovery is restricted unless separately proved safe. This
feature does not copy Local plugins, Mac HOME or account/team settings. Bounded
repository instruction projections are described in
[native configuration](agent-authentication-and-language-tools.md#repository-instructions-and-configuration).

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

The snapshot is exclusive at prewarm, creation, resume, prompt and rebuild,
including an empty server map. Codex's immutable user/system mounts and process
override suppress raw repository MCP; Claude uses strict MCP configuration.
Cursor's native project/plugin sources remain disabled and its private user
config is immutable. Passing `mcpServers: {}` alone is insufficient: the pinned
Cursor SDK otherwise launches project/user MCP during workspace initialization,
before its per-session override takes effect. Native marker regressions verify
excluded servers never start and admitted skills remain discoverable.

Publication filtering preserves protocol identities and permission choices,
withholds incomplete literals in text and cumulative tool snapshots, and scrubs
startup/resume/prompt errors before teardown. Field names and protocol identities
stay intact even when a configured value matches a nested field name. Ambiguous
trailing prefixes are redacted at termination, including diagnostic line ends
and stack headers. Native image qualification additionally exercises
secret rotation, removal and an owner handoff through real provider resumes;
those paid image checks must be run before rollout.
