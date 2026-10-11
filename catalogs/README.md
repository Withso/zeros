# Model catalogs

The versioned files in this directory define the models Zeros presents for each
agent family. They are bundled application data, not a remote registry.

## Files

- `models-v1.json` is the curated catalog used by the desktop renderer and
  engine.
- `models-v1.schema.json` documents and validates its serialized shape.

Each family entry owns the exact provider model identifier, display label,
supported effort levels, fast-mode support, and any minimum CLI version. The
`modelEnvVars` map identifies the environment variable used at the agent
boundary.

An optional `defaultEffort` chooses a model's initial effort when the user has
not remembered a valid effort for that exact model. It must belong to the
model's effort ladder; live empty or narrower ladders remain authoritative.

## Runtime contracts

- The curated catalog is authoritative for which model rows are displayed. For
  an exact model match, live `effortLevels` and `supportsFast` values are
  authoritative for what the installed runtime and current account can execute;
  explicit `[]` and `false` must override bundled fallback capabilities.
- `label` is authoritative here for **every** family and is never taken from
  live discovery. Each provider brands the same wire identifier its own way and
  rebrands on CLI or account updates — the pinned Claude CLI reports
  `claude-opus-5[1m]` as "Opus (1M context)", and Codex `model/list` and the
  Cursor SDK carry their own `displayName` values. An advertised `label` is
  advisory: it names a row only for a family with no curated entries at all.
  `overlayLiveCapabilities` in `model-catalog.ts` enforces this with an
  allowlist of overlayable fields, so renaming a model in the picker means
  editing this file. A curated `description` is likewise never overwritten;
  live copy only fills a row that leaves it unset.
- An adapter therefore advertises a capability only when its provider actually
  answered. Omit the field when the response never addressed it — a missing
  field is "unknown" and keeps the curated fallback, while `[]`/`false` mean
  "this runtime says no" and strip the control. Never normalize an absent
  field into an empty answer.
- `liveRequired: true` marks account-dependent compatibility data. The row is
  selectable only after exact live discovery marks it selectable; it stays out
  of cold/current-account menus otherwise. Persisted exact IDs and aliases still
  retain their identity and catalog label while hidden, and live qualification
  treats only these explicitly marked rows as optional. Cursor Grok 4.5 uses
  this contract because availability differs across accounts; it is never
  aliased or retargeted to Grok 4.6.
- `defaultFavorites` and `aliases` participate in persisted model selection.
  Do not retarget them silently. Add a compatibility migration and regression
  test if an existing selection must resolve differently.
- Optional `defaultEffort` supplies a model's born effort only without a valid
  remembered exact-model choice. It must belong to that model's effort ladder;
  narrower live capabilities remain authoritative.
- Model identifiers are provider wire values. Preserve suffixes such as
  Claude's `[1m]`; they are not display decoration.
- Labels do not claim a context-window size. Runtime-reported context sizes are
  preferred, while shared static fallbacks live in
  `packages/protocol/src/model-context.ts`.
- Cursor effort and fast controls map to the selected SDK model's native
  parameters. Cursor's canonical `default` model and its `auto` alias identify
  the same Auto router and remain compatible with saved selections. Codex's
  `max` tier maps to native `max`; the Zeros `ultracode` display tier maps to
  Codex's native `ultra` effort.
- `minCliVersion` is a build-time compatibility gate. It does not hide a model
  at runtime, so a catalog entry and the pinned SDK that supports it must ship
  together. For a selected model in a cloud workspace, an advertised installed
  CLI version below that floor shows the existing runtime-update-on-next-wake
  note. Unknown versions retain the existing required-update verdict; Local
  workspaces keep their existing picker behavior.

The minimum Claude CLI versions recorded by the catalog are 2.1.170 for
Fable 5, 2.1.206 for Sonnet 5, 2.1.219 for Opus 5, 2.1.257 for Fable 5.1,
2.1.280 for Opus 5.5, 2.1.284 for Sonnet 5.5, and 2.1.293 for Haiku 5.5.
The Fable 5.1 floor follows the official
[model configuration requirement](https://code.claude.com/docs/en/model-config#work-with-fable);
the model ID and persisted aliases are unchanged.

## October 2026 qualification

Catalog version 13 ships with Claude Agent SDK 0.3.293 / Claude Code 2.1.293,
Codex 0.161.0, and Cursor SDK 1.0.37. Existing saved defaults and persisted aliases
remain unchanged. Version-specific `opus-5.5` and `sonnet-5.5` aliases resolve
to their own model IDs. The new `haiku-5.5` alias resolves to `claude-haiku-5-5`;
`haiku` continues to resolve to Haiku 4.5.

| Model | Effort controls | Fast |
| --- | --- | --- |
| GPT-6 Sol, GPT-6.1 Sol | Low, Medium, High, Extra High, Max, Ultra | Yes |
| GPT-6 Luna | Low, Medium, High, Extra High, Max | Yes |
| Claude Opus 5.5 | Low, Medium, High, Extra High, Max, Ultracode | Yes |
| Claude Sonnet 5.5 | Low, Medium, High, Extra High, Max | No |
| Claude Haiku 5.5 | Low, Medium, High, Extra High, Max | No |
| Grok 4.7 | Low, Medium, High, Extra High | Yes |

Haiku 5.5 follows Sonnet 5 and precedes Haiku 4.5 in the Claude catalog. The
official [model configuration](https://code.claude.com/docs/en/model-config)
documentation and bundled 2.1.293 CLI confirm its identifier, minimum version,
and native Medium default. Its 1M context is the default, so its ID has no
`[1m]` suffix. Exact live capabilities can narrow its effort controls, and a
remembered per-model effort wins over the catalog default.

Anthropic's [Fast mode contract](https://code.claude.com/docs/en/fast-mode)
supports the listed Opus models, not Sonnet. Sonnet 5.5 must not acquire a Fast
or synthetic Ultracode control merely because another Claude model supports
it. The SDK's exact-model capabilities still narrow the bundled controls.

Cursor's authenticated `models.list` response uses `reasoning_effort` for
Grok 4.7 and `effort` for Grok 4.6; both use the string-valued `fast` parameter.
These wire names apply to cold create/send/resume as well as live discovery.
Keep other native default parameters, such as Grok 4.7's `context`, when
applying a user's effort and Fast selection. Grok 4.6's display label is
**Grok 4.6**; its serialized `grok-4.6` ID has not changed.

Qualification used native Codex `model/list`, Claude `supportedModels`, and
Cursor `models.list`, plus the provider model documentation:
[Codex](https://learn.chatgpt.com/docs/models),
[Claude](https://code.claude.com/docs/en/model-config), and
[Cursor](https://cursor.com/docs/models-and-pricing).
Discovery proves advertised availability, not permission to run every model
on every account. Preserve exact-model live restrictions after discovery.

### New chat default policy

With no saved default, new chats prefer confirmed Claude connections (Opus 5.5,
Medium), then Codex (GPT-6.1 Sol, Max), then Cursor (Grok 4.7, Extra High).
When none are connected, the same order applies through the existing runnable,
installed and enabled tiers. Local and organization-owned Local workspaces use
the confirmed device verdict; cloud workspaces use the actor's qualified
credential grants and keep exact model consent. Settings and the catalog star
share the provider chain and preserve a saved default's identity; an ungranted
saved model remains unavailable while cloud births use the delegated fallback.
Users who never saved a default receive this chain without an implicit preference
being written. Saved defaults and aliases stay intact; exact-model remembered
effort wins, and Fast starts off unless that exact model has a remembered Fast
choice. Existing chats retain their models; legacy null-model rows freeze the
prior explicit favorite or Opus 5 / GPT-5.6 Sol / Composer 2.5 at hydration.
Legacy effort/Fast fields migrate onto those prior selections instead of the
new catalog defaults.

## Updating the catalog

1. Confirm the exact identifier and capabilities against the pinned provider
   runtime. Bump the SDK and lockfile in the same change when required.
2. Preserve persisted aliases and defaults unless the change includes an
   explicit compatibility migration.
3. Run `pnpm models:verify` for structural and pin checks.
4. Run `pnpm models:verify --live` and `pnpm models:list <agent>` when provider
   authentication is available.
5. Run the adjacent catalog tests before committing.

Live discovery can differ by account, CLI, and availability. It replaces
bundled capability fallbacks for exact matches while the checked-in catalog and
tests continue to own display compatibility and cold-start behavior.
