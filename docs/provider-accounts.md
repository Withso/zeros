# Provider accounts

Settings → Providers supports Account, CLI, and API for Claude and Codex, and
Account and API for Cursor. Selecting a method is configuration, not evidence of
authentication. The connection row requires both the native connection status
and the engine's authentication verdict. A real provider rejection survives an
ordinary refresh; another account's CLI credential change cannot clear it.

Account supports up to 20 saved entries per provider. Add account creates a new
profile and activates it only after successful browser authentication. Cancel,
timeout, and failed verification preserve the existing selection. Selecting a
saved account verifies that exact profile; removing the selected account leaves
the method unconnected rather than selecting another account automatically.
Expired or disconnected entries offer **Sign in**, which renews that saved entry
without adding another row. Cancellation leaves the current selection intact.

Connected methods show one sentence: **email is connected** when that exact
connection supplies an email. Credentials without identity metadata use
**CLI is connected**, **API key is connected**, or **Account is connected**.
API mode never borrows an email from a saved subscription. Cloud connections
use their own selected credential's name; device identity is never substituted.

For Local agents, API settings use the engine's selected key source as well as
saved-key presence. An inherited key is labeled with its environment variable
(for example, **Cursor API key provided by CURSOR_API_KEY**) and can show
**Connected via API** without a saved key in this app. Remove applies only to a
key saved in the current secret store; the input never displays an existing key.
Pending or failed storage reads are not reported as a missing key. This also
applies to organization-local workspaces. Cloud connections retain their own
credential selection. Local, hosted Dev, Alpha, Beta and production stores stay
isolated; checkouts in the same development mode keep their existing shared store.
Returning to Settings revalidates the engine registry so a credential change in
another instance cannot remain hidden behind a recently cached connection status.

Selecting CLI reads the existing device authentication without starting a login,
terminal or model session. Claude uses `auth status --json`; Codex uses native
`account/read`. CLI detection also recognizes a native saved API credential;
browser Account sign-in still requires a subscription. Open terminal remains
available as an explicit action. Cursor supports Account and API, not CLI.
The settings card labels this method **Connected via CLI**, without assuming
that the CLI uses a subscription rather than an API credential.
The local engine also asks Claude's native status command for its authentication
verdict. Claude and Codex probes resolve the same configured or bundled runtime
as chats, so an absent or different global CLI cannot contradict a working
connection. Cloud workers keep their own existing probe and credential path.

Visible connection surfaces share status reads. Returning from an external
terminal or revealing the window revalidates the native identity, including
logout and account changes. An invalidation during a slow read gets a catch-up
read; hiding Settings retires queued work without marking skipped reads fresh.
Hidden surfaces start no probes. CLI connections without a confirmed email
cannot request or restore another account's subscription usage.

## Storage and isolation

Electron main owns `provider-accounts-<provider>` in the encrypted secret store.
The blob contains stable UUIDs, the active selection, connection metadata and,
for Cursor, the SDK-issued expiring credential. Updates use the store's existing
cross-process mutation lock. Selection and credential generations live in an
encrypted companion entry committed in the same transaction, keeping the strict
version-1 account record readable by older development worktrees. The renderer receives only UUIDs, email,
plan/team, expiry and connection state. Paths, OAuth URLs, tokens and API keys
are not included in account status IPC.

Claude and Codex profiles live beside `secrets.json`, under
`provider-accounts/<provider>/<uuid>`, with owner-only directory permissions.
Using the shared secrets directory also keeps profile paths stable across dev
instances. Main selects `CLAUDE_CONFIG_DIR` or `CODEX_HOME`; a renderer or
repository cannot supply an account profile. Claude's default host OAuth token
callback is disabled for an isolated profile so it cannot return the device
account's token. Native providers retain ownership of refresh and keychain use.
On macOS, new Zeros-managed Codex profiles set
`cli_auth_credentials_store = "keyring"`; existing profiles and external CLI
configuration retain their storage choice. Claude owns its native Keychain
entries. Cursor subscription credentials and all three API keys use Electron
`safeStorage` encryption, whose macOS encryption key is held in Keychain.
They are not stored in renderer preferences or repository files.

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
on the private control pipe before completing a switch or API-key change.
Explicit native method selection takes precedence over stale per-checkout user
preferences; managed policy retains precedence. An empty background subscription
probe cannot disable an existing Cursor API connection. Shared-store changes
invalidate active settings views; hidden views do not poll.

Successful renewal advances the selected account's private credential generation,
so a rejection of its previous credentials cannot block the new login. Late
verification results cannot overwrite an A → B → A selection. Removing an
account during sign-in prevents it from being re-added and cleans up credentials
written by a late native login.

An in-flight turn finishes under its original account. In a Local workspace the
next message then runs under the current connection with no reconnect, chat
restart or engine restart: the gateway hands the live execution the new API key,
CLI login or saved account at that turn boundary. Claude and Codex restart only
their native process and resume the same conversation (`resume`,
`thread/resume`); Cursor resumes the same agent under the new key
(`Agent.resume`). A tool-connection read adopts the
connection the same way; concurrent callers share one restart. Background work
owned by the old process ends with it. When the new connection uses another
native root (`CLAUDE_CONFIG_DIR` or `CODEX_HOME`), the conversation's history
file is first copied there once no process is still writing it. The source stays
in place and a newer copy is never replaced, so A → B → A keeps the latest turns.
An adapter without this capability keeps the previous retire-and-reconnect path.
Cloud executions keep the credential their admission minted.
Stop also applies while a send waits for the native process to restart. That
send stays cancelled when the restart completes; a later send can use the new
connection. Authentication failures are attributed to the attempted connection,
so a late rejection cannot mark a newer selected account as requiring sign-in.

When native history is still unavailable in the new profile (the copy failed),
Claude falls back to a bounded text replay that supplies conversation context;
queued messages and provider tool outputs are excluded. Codex starts a new
thread, publishes its binding with an optional `resumedFresh` marker, and routes
the pending send through the existing bounded conversation replay before native
dispatch. Blocked prompts and available attachments are
included with the user's next ordinary message. Sign-in never automatically
sends a prompt. A forced registry refresh after a connection change waits for
any earlier in-flight read, so the composer's sign-in check never keeps a
verdict from before the change.
The engine and renderer retain the empty-session marker across renderer reloads,
Stop and further account switches until a prompt completes on that thread.
Cancellation or completion on an older thread cannot acknowledge its history.
After successful replay, later reloads do not repeat it. The new binding-update
field is optional: legacy notifications retain their existing behavior, and
older consumers still recover through `AGENT_SESSION_LOADED.resumedFresh`.

Live model capabilities and pending model discovery belong to the selected
authentication identity. Switching accounts clears the old model snapshot;
responses from an older account or an older admission cannot repopulate it.

The new PTY login selector and transcript metadata are optional wire fields.
Existing messages retain their meaning, and native account IPC is local to the
matching app build. The protocol file-diff check reports its advisory because
these files changed; the protocol version is intentionally unchanged.

## Evidence and verification

### Cursor credential lifetime

The selected Cursor API key and the SDK's short-lived access token have separate
lifetimes. Browser sign-in returns a revocable API key (90-day default TTL in the
installed `auth/login.d.ts` contract). Main owns its encrypted storage and expiry;
the engine never substitutes an ambient credential for an expired selected key.
Renewing an access token does not renew that account key. An expired or revoked
account key uses the existing sign-in / update-key recovery in Settings.

The pinned `@cursor/sdk` 1.1.0 owns access-token refresh, including during active
local runs. This incorporates the refresh correction documented in the
[1.0.30 changelog](https://cursor.com/docs/sdk/changelog). Do not add a competing
Zeros refresh timer or restart a healthy execution just to renew its token.
Credential replacement resumes the same agent under the new key before its next
run; late success or failure from a run under the old key cannot change the
replacement credential's authentication verdict.

Qualification of 1.0.31 found that a failed local token exchange can reach
`run.wait()` without its error code, while the native run store retains only the
SDK's error string. The adapter recognizes the SDK-owned server/connection
exchange prefixes as transport failures only when native code/status and TLS
evidence do not already determine recovery. Provider details are preserved.
Authentication, rate limits, permission errors and certificate failures retain
their existing behavior; these cases use the current recovery UI.

Native authenticated runs verified refresh between turns, refresh within an
active turn, recovery after an injected exchange outage, and resume in a fresh
process. Expiry was accelerated with a process-local clock; 503 and revoked-key
401 responses were injected at the exchange boundary. This qualifies those
paths, not a real-time soak or real account revocation. Retained regressions
cover erased-code failures, native-code precedence, account expiry, replacement
credentials, and late authentication verdicts.

### Provider evidence

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

Chat initialization and transient reconnects do not emit generic provider-error
toasts. Terminal startup failures stay in the affected chat, prompt failures
retain their turn notice, and authentication failures retain their Sign in
action. Opening or revealing a chat does not replay an error notification.

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
