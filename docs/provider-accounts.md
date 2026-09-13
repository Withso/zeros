# Provider accounts

Settings → Providers supports Account, CLI, and API for Claude and Codex, and
Account and API for Cursor. Selecting a method is configuration, not evidence of
authentication. The connection row requires both the native subscription status
and the engine's authentication verdict. A real provider rejection survives an
ordinary refresh; another account's CLI credential change cannot clear it.

Account supports up to 20 saved entries per provider. Add account creates a new
profile and activates it only after successful browser authentication. Cancel,
timeout, and failed verification preserve the existing selection. Selecting a
saved account verifies that exact profile; removing the selected account leaves
the method unconnected rather than selecting another account automatically.

## Storage and isolation

Electron main owns `provider-accounts-<provider>` in the encrypted secret store.
The blob contains stable UUIDs, the active selection, connection metadata and,
for Cursor, the SDK-issued expiring credential. Updates use the store's existing
cross-process compare-and-swap. The renderer receives only UUIDs, email,
plan/team, expiry and connection state. Paths, OAuth URLs, tokens and API keys
are not included in account status IPC.

Claude and Codex profiles live beside `secrets.json`, under
`provider-accounts/<provider>/<uuid>`, with owner-only directory permissions.
Using the shared secrets directory also keeps profile paths stable across dev
instances. Main selects `CLAUDE_CONFIG_DIR` or `CODEX_HOME`; a renderer or
repository cannot supply an account profile. Claude's default host OAuth token
callback is disabled for an isolated profile so it cannot return the device
account's token. Native providers retain ownership of refresh and keychain use.

These are separate native profiles. New profiles start with provider defaults;
Zeros settings and repository instructions still apply. Existing native personal
settings remain with the device CLI account; the app does not copy credential
helpers, environment overrides or private native configuration into a different
account. Removing an isolated account invokes native logout in that profile;
its transcript directory remains available for history.

For compatibility, an existing device subscription can appear as **Device
account**. This entry follows the device CLI login, including changes made
outside Zeros. New entries made with Add account are isolated. Removing the
device entry does not log out the user's CLI. Cursor's legacy subscription
credential is retained under its original secret key for this migration.
After a provider rejection, a device entry can recover when that device's native
credential changes. Isolated entries still ignore changes to another CLI account.

## Switching and conversations

Selection changes are serialized with native status reads and pending sign-ins.
The engine receives credentials and identity from the same native snapshot over
private stdin. Main waits for an acknowledgment from that exact engine generation
on the private control pipe before completing a switch. Shared-store changes
invalidate active settings views; hidden views do not poll.

An in-flight turn finishes under its original account. Before accepting its next
message, the engine retires a process whose authentication identity has changed.
The existing chat resumes under the current account. When native history is
unavailable in the new profile, a bounded text replay supplies conversation
context; queued messages and provider tool outputs are excluded. Blocked prompts
and available attachments are included with the user's next ordinary message.
Sign-in never automatically sends a prompt.
The engine retains the empty-session marker across renderer reloads until the
first completed provider prompt, then clears it so later reloads do not repeat
the replay.

Live model capabilities and pending model discovery belong to the selected
authentication identity. Switching accounts clears the old model snapshot;
responses from an older account or an older admission cannot repopulate it.

The new PTY login selector and transcript metadata are optional wire fields.
Existing messages retain their meaning, and native account IPC is local to the
matching app build. The protocol file-diff check reports its advisory because
these files changed; the protocol version is intentionally unchanged.

## Evidence and verification

- Anthropic documents `CLAUDE_CONFIG_DIR` as a separate configuration root,
  including multiple-account use: [environment variables](https://code.claude.com/docs/en/env-vars).
- OpenAI documents `CODEX_HOME`, credential storage and refresh behavior:
  [Codex authentication](https://developers.openai.com/codex/auth/).
  Its [native storage implementation](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/storage.rs)
  namespaces keyring entries by the canonical home directory.
- The installed official `@cursor/sdk` 1.0.31 `auth/login.d.ts` documents
  `store: null`, returning the minted key, email and expiry. Zeros stores those
  credentials separately instead of using the SDK's ambient singleton store.

Mac checks with the installed pinned runtimes confirmed that two empty Claude
profiles and two empty Codex profiles remain signed out, even with an existing
device login. Automated tests cover account switching, stale reads, failed login,
removal, engine-generation acknowledgments, credential projection and browser
flows for all three providers. Completing live browser sign-in with two distinct
real accounts requires those accounts; automated fixtures do not prove that step.

## Connection controls and usage

Settings lists saved accounts as a nested radio group under Account. Each row's
ellipsis menu disconnects that account; disconnecting an inactive account does
not select it or change the active one. The device-account marker remains wire
metadata for compatibility and is no longer displayed.

The `zeros.agent.enabledAgents` preference is retired and ignored by current
clients, without rewriting it for older clients. Composer models require a
confirmed connection. An existing chat retains its provider identity and can
recover through Settings. A connected provider takes priority over an unavailable
auth probe when creating a chat.

The information card below the provider connection displays provider, plan, email and
available organization metadata. Native `provider_subscription` usage reads are
local, read-only, bounded, and checked against the selected method/account both
before and after the provider request. Credentials and provider response bodies
never cross IPC. The renderer caches by provider, method, account, identity and
authentication generation, retains exact-key data on refresh errors, and stops
refreshing hidden surfaces. The first read displays the shared Zeros loader with
"Loading usage limits" instead of empty quota bars. Returning to a provider tab
refreshes the retained snapshot, with a rotating refresh icon; further automatic
refreshes run every 30 minutes while visible. Focus only revalidates stale data.
Failed automatic requests back off for five minutes; manual refresh bypasses
that backoff.

Normalized usage snapshots persist locally under `zeros-provider-usage-v1`,
outside synced personal preferences. A maximum of 32 snapshots is retained for
35 days, keyed by provider, connection method, saved-account UUID and identity.
The transient authentication generation is excluded from this durable key so a
restart immediately restores the matching snapshot with its original fetch time.
Malformed, future-dated, and mismatched data is ignored; removing a saved account
prunes its durable usage and prevents an older response from restoring it. A CLI
connection without confirmed identity never restores a prior device login's usage.
Usage requests and results carry the confirmed identity as well as the selected
method and account UUID. Legacy CLI cache records without a verified result
identity are discarded from the existing storage key.

- Claude reads its OAuth usage endpoint for `five_hour` and `seven_day`. The
  profile and usage requests use the same captured OAuth token, so cached CLI
  identity metadata cannot misattribute a different account's quota. Both reads
  must succeed before a snapshot is published. The keychain namespace follows
  the pinned CLI's hash of `CLAUDE_CONFIG_DIR`;
  refresh uses the existing compare-and-swap and process lock for that exact
  namespace. Missing reset timestamps remain unavailable.
- Codex uses the pinned app server's `account/read` and `account/rateLimits/read`
  in the selected `CODEX_HOME`, checking identity before and after the quota read.
  Window duration identifies the five-hour and weekly quotas; their ordering
  is not assumed.
- Cursor follows the pinned SDK's `auth/exchange_user_api_key` flow, then reads
  `DashboardService.GetMe`, `GetCurrentPeriodUsage` and the native
  `auth/full_stripe_profile` endpoint. The short-lived access token stays within
  the native read. `autoPercentUsed` / `apiPercentUsed` represent the two monthly
  Cursor / third-party pools. Team identity comes from `GetMe`, not an arbitrary
  first team. A pooled total never substitutes for unavailable individual pools.

Native provider endpoints are compatibility dependencies, not promises of a
public API. Unknown or missing quotas are shown as unavailable, never zero. API
connections do not imply a subscription quota. Reset timestamps retain the
provider's value and expose both relative time and an exact-date tooltip.

The quota schemas were checked against the installed official Claude CLI,
`@cursor/sdk` 1.0.31 and the pinned Codex app-server protocol. The live Mac readers
returned Claude session/weekly windows, Codex's available weekly window, and
Cursor's plan plus both monthly pools and reset timestamps. Supporting provider
documentation: [Codex account rate limits](https://learn.chatgpt.com/docs/app-server),
[Claude rate-limit fields](https://code.claude.com/docs/en/statusline), and
[Cursor's two monthly pools](https://prod.cursor.com/help/models-and-usage/usage-limits).
