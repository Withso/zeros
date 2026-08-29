# Third-party notices

The repository-owned Zeros source is distributed under the MIT License in
[`LICENSE`](LICENSE). Dependencies, generated code, fonts, and bundled runtimes
remain subject to their respective authors' licenses and terms.

[`THIRD-PARTY-LICENSES.txt`](THIRD-PARTY-LICENSES.txt) is the distributable,
machine-generated inventory for the locked root workspace, control-plane, and
standalone marketing production graphs. It contains each resolved
package/version, its declared license, attribution metadata, and deduplicated
license and NOTICE text. Generation first hydrates both independent pnpm
lockfiles; `pnpm check:licenses` rejects graph or bundle drift in CI and release
workflows. The web assembler publishes this notice, the repository license, and
the generated bundle with the Cloudflare Pages artifact.

## Release-blocking vendor terms

The desktop application currently depends on and packages runtime components
whose publishers do **not** grant an open-source license in their npm archives:

| Component                                                 | Published terms                                                                                                                              | Release requirement                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` and its platform runtime | © Anthropic PBC; all rights reserved; use is subject to [Anthropic's legal agreements](https://code.claude.com/docs/en/legal-and-compliance) | Obtain written confirmation that Zeros may redistribute the runtime. Anthropic's current guidance also requires third-party products to use API-key authentication and prohibits offering Claude.ai subscription login on users' behalf; remove that flow or obtain explicit authorization. |
| `@cursor/sdk` and its platform runtime                    | © Anysphere Inc.; all rights reserved; use is subject to [Cursor's Terms of Service](https://cursor.com/terms-of-service)                    | Obtain written redistribution and authentication authorization, or remove the bundled runtime before public distribution.                                                                                                                                                                   |

Their exact package license files are reproduced in
`THIRD-PARTY-LICENSES.txt`. The repository's MIT license does not override
these terms. A public source repository and a redistributable binary are
separate legal questions; do not publish a release until the project owner and
qualified counsel have closed both items.

Platform-specific optional packages use the same vendor terms as their parent
SDK. The macOS arm64 release currently stages the matching Claude and Codex
runtimes and resolves the matching Cursor runtime during packaging. Codex is
Apache-2.0 and therefore not release-blocking, but it is redistributed and is
inventoried accordingly.

## Generated and vendored code

### Codex app-server protocol bindings

- **Path:** `apps/desktop/src/engine/agents/adapters/codex/generated/`
- **Source:** [OpenAI Codex](https://github.com/openai/codex), pinned by
  `package.json#codexProtocolVersion` and the generated `.version` file.
- **License:** Apache-2.0. Exact upstream `LICENSE` and `NOTICE` files are stored
  beside the generated output and copied again into the generated bundle.
- **Generation:** `scripts/codegen-codex.mjs` exports the protocol types from
  the pinned upstream tag. Generated files are not hand-edited.

The upstream generator uses `ts-rs`, which is dual MIT/Apache-2.0. The Codex
NOTICE also records code derived from Ratatui under MIT.

### Codex native runtime

- **Path:** `Contents/Resources/codex-runtime/` in the packaged macOS app.
- **Source:** the `@openai/codex-darwin-arm64` platform package, which npm
  publishes as an alias of `@openai/codex@<version>-darwin-arm64`.
- **Staging:** `scripts/stage-codex-cli.mjs` copies the whole vendor target
  (main binary, code-mode host, vendored ripgrep, resources) at `beforePack`;
  `scripts/check-packaging-paths.mjs` fails the build if that staging or its
  `extraResources` entries go missing.
- **License:** Apache-2.0. Because these binaries are redistributed, the
  generated bundle records the platform package as its own inventory entry and
  attaches the upstream `LICENSE` and `NOTICE` (Apache-2.0 §4(d)) to it.

### UI component source

- **shadcn/ui:** Files under
  `apps/desktop/src/renderer/shared/ui/primitives/` include adapted component
  patterns from [shadcn/ui](https://github.com/shadcn-ui/ui), copyright 2023
  shadcn, under MIT. Zeros modifies and maintains its local copies; the
  upstream license is preserved at [`third_party/shadcn-ui/LICENSE`](third_party/shadcn-ui/LICENSE).
- **AI Elements:** Chat primitives under
  `apps/desktop/src/renderer/shared/ui/primitives/elements/` include source
  adapted from [AI Elements 1.9.0](https://github.com/vercel/ai-elements/tree/ai-elements%401.9.0),
  copyright 2023 Vercel, Inc., under Apache-2.0. Modified files identify their
  provenance in their source headers. The full license is preserved at
  [`third_party/ai-elements/LICENSE`](third_party/ai-elements/LICENSE).

### Agent integration marks

- **Desktop path:** `apps/desktop/src/assets/agents/*.svg`
- **Marketing path:** `apps/marketing/public/agents/*.svg`
- **Lobe Icons source:** The desktop set and the marketing Claude and Codex
  files come from `@lobehub/icons-static-svg@1.94.0`, published by
  [Lobe Icons](https://github.com/lobehub/lobe-icons). The desktop
  `codex.svg` uses upstream `openai.svg`; marketing uses upstream
  `claude-color.svg` and `codex.svg`.
- **Lobe Icons license:** MIT. The exact license is preserved at
  [`third_party/lobe-icons/LICENSE`](third_party/lobe-icons/LICENSE).
- **Cursor marketing source:** `apps/marketing/public/agents/cursor.svg` is
  Cursor's `CUBE_2D_DARK.svg` from its
  [official brand-assets archive](https://cursor.com/en-US/brand). Cursor does
  not publish that asset under an open-source license; its use remains subject
  to Cursor's brand guidance and trademark rights.
- **Detailed provenance:** File mappings and checksums are maintained in
  [`apps/marketing/public/agents/README.md`](apps/marketing/public/agents/README.md).

Product names and marks remain the property of their respective owners and do
not imply sponsorship or endorsement. Confirm each use against current brand
rules before public distribution; use plain product text if approval is not
available.

## Components with additional notice considerations

- **Electron:** MIT. Electron embeds Chromium and Node.js; packaged Electron
  distributions carry Electron's `LICENSE` and Chromium's generated
  `LICENSES.chromium.html` in addition to this bundle.
- **DOMPurify:** dual MPL-2.0 or Apache-2.0. Zeros elects the Apache-2.0 option
  for distribution; the upstream dual-license file is reproduced unchanged.
- **Geist and Geist Mono fonts:** OFL-1.1. The font license text is included in
  the generated bundle.
- **`@pierre/trees`:** Apache-2.0 and an upstream NOTICE file. Both are included
  in the generated bundle.
- **gsap (marketing site):** Standard "No Charge" GSAP License. The npm archive
  omits a standalone license file; a reviewed copy of
  [the published terms](https://gsap.com/standard-license) is stored at
  [`third_party/gsap/LICENSE`](third_party/gsap/LICENSE) and reproduced in the
  generated bundle. Marketing uses the public `gsap` package only (no Club
  plugins).

## Maintenance policy

Any change that adds, removes, upgrades, vendors, generates, or packages a
third-party component must update the lockfile and regenerate the bundle in the
same change. A new `Unknown`, `SEE LICENSE IN …`, or missing standalone license
must be reviewed explicitly; do not infer that an npm package is MIT merely
because this repository is.

The generated native inventory currently targets the only release architecture,
macOS arm64. Adding macOS x64, Windows, or Linux packaging must update
`PACKAGED_PLATFORM_PACKAGES` in `scripts/generate-third-party-licenses.mjs` and
add target-specific packaging assertions in the same change.

This file is an engineering inventory, not legal advice. The project owner is
responsible for confirming trademark, service terms, privacy obligations,
export controls, and binary redistribution rights before each public release.
