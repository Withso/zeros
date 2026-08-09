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

## Runtime contracts

- The curated catalog is authoritative for which model rows are displayed. For
  an exact model match, live `effortLevels` and `supportsFast` values are
  authoritative for what the installed runtime and current account can execute;
  explicit `[]` and `false` must override bundled fallback capabilities.
- An adapter therefore advertises a capability only when its provider actually
  answered. Omit the field when the response never addressed it — a missing
  field is "unknown" and keeps the curated fallback, while `[]`/`false` mean
  "this runtime says no" and strip the control. Never normalize an absent
  field into an empty answer.
- `defaultFavorites` and `aliases` participate in persisted model selection.
  Do not retarget them silently. Add a compatibility migration and regression
  test if an existing selection must resolve differently.
- Model identifiers are provider wire values. Preserve suffixes such as
  Claude's `[1m]`; they are not display decoration.
- Labels do not claim a context-window size. Runtime-reported context sizes are
  preferred, while shared static fallbacks live in
  `packages/protocol/src/model-context.ts`.
- Cursor effort and fast modes select concrete model identifiers. Codex's `max`
  tier maps to native `max`; the Zeros `ultracode` display tier maps to Codex's
  native `ultra` effort.
- `minCliVersion` is a build-time compatibility gate. It does not hide a model
  at runtime, so a catalog entry and the pinned SDK that supports it must ship
  together.

The current defaults are Claude Opus 5, Codex GPT-5.6 Sol, and Cursor Composer
2.5. The minimum Claude CLI versions recorded by the catalog are 2.1.170 for
Fable 5, 2.1.206 for Sonnet 5, and 2.1.219 for Opus 5.

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
