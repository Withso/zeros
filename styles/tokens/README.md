# Zeros token source

Values are authored in [DTCG 2025.10 format](https://www.designtokens.org/tr/2025.10/format/)
and combined by a [DTCG resolver](https://www.designtokens.org/tr/2025.10/resolver/).
`base.tokens.json` contains Dark defaults and theme-independent values;
`light.tokens.json` contains only declarations present in the Light override.
`zeros.resolver.json` applies the base set, then the appearance modifier (Dark
is the default and has no overrides). Runtime System appearance resolves to
Dark or Light before applying these tokens.

Run `pnpm design:docs` after edits. It generates the marked declaration groups
in `styles/zeros-tokens.css`, the token reference and provider guidance.
`pnpm check:ui` and `pnpm check:tokens` reject stale regions or invalid sources
without writing. `pnpm tokens:build` regenerates only token declarations.

The dependency-free emitter supports the forms this palette uses: explicit or
inherited `$type`, `$description`, color (HSL or sRGB, optional alpha), dimension
(px/rem), numeric fontWeight, shadow objects/arrays and whole-token aliases.
HSL components are `[hue, saturationPercent, lightnessPercent]`; sRGB components
are normalized channels. Aliases such as `{tokens.bg1}` emit `var(--bg1)` and
resolve after appearance overrides. Shadow fields may also refer to typed
tokens. Unsupported types, group inheritance, JSON pointers, remote sources,
or resolver arrangements fail explicitly; this is not a general DTCG tool.

Every token has an `org.zeros` extension:

| Field            | Purpose                                                               |
| ---------------- | --------------------------------------------------------------------- |
| `cssName`        | Existing custom-property name, including `--`; compatibility contract |
| `section`        | Stable generated declaration-group marker in the owning CSS block     |
| `utility`        | Optional Tailwind color key, including `--color-`                     |
| `utilitySection` | Marker for that color-wiring group                                    |
| `utilityOrder`   | Existing color utility declaration order                              |
| `cssFormat`      | Optional `multiline` to preserve the established raw CSS value string |

Sections are named for the first token of the existing group; their names stay
stable when tokens are added. Reuse the appropriate section, and retain the
authored JSON token order. For a new section, add empty start/end markers inside
the existing selector without changing surrounding CSS. Light preserves each
token's CSS name, type and utility wiring; its declaration section and value
format may differ. Do not add a token without a real caller and its pairings.

Generation never flattens aliases or moves imports/selectors. Color comments
contain computed hex (including alpha when present); scalar comments retain
their dimension or weight rather than inventing a color. Shadow comments show
their first layer's color. Handwritten explanations remain outside the markers.
The resolver's `org.zeros.marketing.groups` extension lists the 26 shared colors
generated into `apps/marketing/src/index.css` by both `pnpm design:docs` and
`pnpm tokens:build`, with stale regions rejected by `pnpm check:ui` and
`pnpm check:tokens`, independent string-parity tests retained, and marketing's
art-direction tokens and selectors kept hand-written.
