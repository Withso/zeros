# Zeros browser service

Zeros provides browser automation as a product-owned capability shared by all
agent adapters. The browser is not a Codex thread feature, a provider session,
or a marketplace MCP server.

## Ownership and identity

The service receives only Zeros identities:

| Identity                   | Owner               | Lifetime                 | Browser use                          |
| -------------------------- | ------------------- | ------------------------ | ------------------------------------ |
| `workspaceId`              | Zeros               | durable                  | scopes the workspace and upload root |
| `conversationId`           | Zeros               | durable                  | owns one browser resource            |
| `browserSessionId`         | Zeros main process  | one app-service lifetime | opaque browser lease handle          |
| `executionId`              | Zeros engine        | one live agent execution | never a browser key                  |
| `ProviderBinding.resumeId` | Codex/Claude/Cursor | provider-defined         | never sent to the browser service    |

Acquiring again for the same workspace and conversation returns the same
process-local browser session. Agent restart, provider resume, and provider
switch therefore do not change browser ownership. Deleting the Zeros
conversation detaches its browser resource; ending an execution does not.
After an app restart the same durable owner acquires a newly minted opaque
browser session because isolated Chromium profile data is intentionally
ephemeral.

The workspace path is upload-boundary metadata, not identity. If restore moves
the same `workspaceId` to a new on-disk path, reacquisition keeps the browser
session and replaces its canonical upload root with the engine-authoritative
workspace path. A different `workspaceId` always receives a different browser
resource.

## Process boundary

Electron main owns Chromium `WebContentsView` instances and exposes a small
loopback HTTP service to the engine. The service binds to `127.0.0.1` on a
random port and requires a random per-boot bearer token. Main starts it before
the engine, couriers the endpoint and token only into the engine process, and
clears both on shutdown. Provider subprocesses and renderer code never receive
the credential.

The engine contract is versioned independently at
`@zeros/protocol/browser-tools`. It has three operations:

1. acquire an opaque session for `{ workspaceId, conversationId,
workspaceRoot }`;
2. invoke one action from the canonical manifest; and
3. detach the session when its conversation is deleted.

Requests and responses are bounded. Actions for one browser session are
serialized, while different conversations may run independently. The service
keeps at most eight idle-bounded sessions and evicts the least recently used
record when that bound is reached.

## Canonical tools and adapters

`BROWSER_TOOL_DEFINITIONS` is the one inventory and schema authority:

`open`, `snapshot`, `click`, `type`, `upload`, `resize`, `back`, `forward`,
`reload`, `screenshot`, `trace`, and `close`.

Adapters translate that same manifest into the extension point their provider
supports:

- Codex advertises a `zeros_browser` dynamic-tool namespace and handles typed
  `item/tool/call` requests in the app-server harness.
- Claude attaches in-process Agent SDK callback tools under `zeros_browser`.
  The SDK happens to encode callbacks with its private SDK-MCP transport; this
  is an adapter implementation detail, not a Zeros MCP registration.
- Cursor attaches prefixed in-process `local.customTools`. Cursor likewise
  represents custom callbacks internally through its SDK tool machinery.

No adapter creates or owns a browser session. Browser tools do not appear in
Zeros' MCP registry, MCP gateway, app/plugin marketplace, or user MCP files.
There is no product MCP fallback. A provider that gains a better native custom
tool API can replace only its translation layer.

Codex can attach new dynamic tools only at `thread/start`. Threads created with
this service retain their tool declaration on native resume; an older rollout
created before browser tools existed cannot be retrofitted by
`thread/resume`. If that rollout is missing and the adapter performs its
documented fresh-thread fallback, the new thread receives the current manifest.

## Isolation and policy

Each lease uses a fresh in-memory Electron partition with cache disabled,
Chromium sandboxing enabled, context isolation enabled, Node integration off,
web security on, insecure mixed execution disabled, and popups denied. Closing
a lease clears its storage. The page lives in a hidden parking window; it
cannot cover the trusted renderer confirmation dialog.

The public tool contract intentionally excludes raw CDP and host-computer
control. A narrow internal CDP call exists only to set an already-validated
file input, because Electron does not expose an equivalent semantic API.
Uploads must resolve to a non-empty regular file below the owning workspace's
real path, including symlink resolution. Before confirmation, the host freezes
the candidate through a checked file handle into a private staging file; the
page never receives the mutable workspace path. Downloads, staged uploads, and
artifacts use private, bounded session buckets.

Zeros applies main-process confirmation gates to recognized consequential
action classes before execution:

- authentication and password entry;
- payments, purchases, and transfers;
- publishing or destructive controls;
- external form submission, detected from both text and DOM structure;
- file upload and download; and
- browser/device permissions.

There is no auto-approve mode. Sensitive decisions are always one-shot.
Only a host-created browser-permission scope may be allowed for a site, and
that approval remains scoped to the opaque browser session, origin, category,
and exact permission. Closing the trusted Zeros window revokes those grants,
denies pending work, and destroys every live page lease (while retaining each
opaque conversation-owned record), so a hidden page cannot retain device or
network activity without a confirmation surface. Missing renderer, queue
overflow, timeout, malformed response, and session teardown all fail closed.

Classification is defense in depth, not a semantic proof of arbitrary page
JavaScript. DOM structure catches form submissions and bounded host heuristics
recognize common account, payment, publish, destructive, and send controls, but
any page event can itself initiate network activity. This is why this phase has
no shared authenticated profile, blocks popups and host-computer control, and
gives every conversation an ephemeral isolated profile. A future stronger
policy may confirm every mutation or interpose at the network layer without
changing the Zeros identity or adapter contract.

## Artifacts and settings

Screenshots and JSON traces are stored below the channel/instance-specific
Zeros data directory in `browser-artifacts/`. Diagnostic URLs drop credentials,
queries, and fragments. Trace, console, network, download, annotation, and
response collections are bounded.

The durable setting belongs to the engine settings model, not renderer
`localStorage`:

```toml
[browser]
enabled = true
provider = "isolated"
```

`browser` is user/managed-only and is rejected from committed, repo-local, and
workspace-local files so a cloned repository cannot enable or replace a
privileged browser backend. `isolated` is the only provider in this phase.

## Deliberate exclusions

This service does not implement shared-profile Chrome attachment, cloud
browsers, system-computer control, raw developer CDP, provider-specific browser
settings, visible workbench browser tabs, marketplace distribution, plugins,
apps, skills, or MCP discovery. Those require separate product and trust-model
decisions. They must consume the Zeros ownership contract rather than adding
provider-authoritative session or lifecycle state.
