# Verify

Check frames with the native command your context supplies, and match the effort to the change.

## Commands

Use the exact command and URL from your context:

```sh
<engine-command> design list     --url <url>
<engine-command> design styles   --url <url>
<engine-command> design validate --url <url> --frame <page.folder>/<name>.html
<engine-command> design capture  --url <url> --frame <page.folder>/<name>.html --output <png-path> [--theme <name>]
<engine-command> design preview  --url <url> --frame <page.folder>/<name>.html [--theme <name>]
```

- `styles` reports every style source, App fonts and the themes list with status and messages, and exits non-zero on errors.
- `validate` reports file and line diagnostics and exits non-zero on errors. Fix every error.
- `unknown-class` is a warning: a class has no definition in that frame's own or expanded component styles, linked Design CSS, or selected imported sources. It reports each name once at its first `class` attribute, at most 50 per frame: past 50 classes, 49 names and a remaining-count warning. These warnings do not change the exit status. If a received stylesheet cannot be read or classified (including a missing build output or Tailwind dependency), a component the frame places has an error, or the frame has more distinct classes than Tailwind classifies (4,096), this check is skipped for that frame while other rules still run; use `styles` to diagnose unavailable sources.
- Three more warnings check the authoring contract (`SKILL.md`). Each reports a finding once with its first few lines, at most 10 per frame (20 for literal colours), and none changes the exit status. All three skip markup under a `data-zd-captured` root; on `<html>` or `<body>` that is the whole frame, its `<style>` elements included. Other rules, `unknown-class` among them, still check captured markup:
  - `repeated-inline-style`: the same set of two or more inline declarations (custom properties aside) on three or more elements. Move it into a class.
  - `literal-token-value`: a hex, `rgb()` or `hsl()` colour in the frame's `<style>` or `style` attributes equals the default-theme value of a token in `tokens.css` or the frame's style sources. Write `var(--token)`. Custom property declarations and `url()` are not checked; named colours and lengths are not compared.
  - `repeated-markup`: the same tree of tags and classes (state classes such as `is-active` aside, text and other attributes ignored), at least four elements and two levels deep, appears three or more times. Make it a component. Component instances, inline `<svg>` and shadow content are not compared, and a repeat inside a reported repeat is not reported again.
- `capture` writes a PNG with animations stopped, scaled into 2048 × 2048 at most. Open the PNG and look at it: a capture is not a visual review.
- Without `--theme`, capture and preview show the default theme. `--theme <id>` shows a theme the canvas Themes menu offers — one the `themes` list names, tokens.css declares or an imported style source maps — by setting `data-zd-theme` on the frame's `<html>`, as the canvas does. Capture every theme the design supports. An unknown id fails and lists the available themes. The revision stays the same: a theme is a view of the same source.
- `preview` returns an HTTP URL for a browser your provider actually offers. Never use `file://`.
- Add `--revision <rev>` to require the exact revision you validated. URLs expire 30 minutes after the context was issued; ask for fresh context when one expires.
- If the supplied command cannot start (for example, `Script not found "design"`), check that exact command with `--help`. Use an available Design API or HTTP preview for verification if the context exposes one, and report the failing command or unverified step. Keep the authored draft; a frame-editing task does not require searching or repairing the Zeros installation. Do that only when the user requests troubleshooting.

The optional Design API (`design_capabilities`, `design_document_open`, `design_lint`, `design_render`, `design_capture`, `design_transaction_apply`, …) inspects and edits the same local files; native authoring does not need it, and it does not depend on the 30-minute verification URL. `design_capture` takes an optional `theme` (like `--theme`) and defaults `width`/`height` to the frame's canvas size, scaling a frame larger than 2048 × 2048 into one raster as the native capture does.

## Verify in proportion

- **One frame or a few.** Validate each one, capture it in every theme the design supports, and look at each PNG.
- **Many frames** (a generated catalog, a state matrix, a page of variants):
  - validate every frame; it is fast and reports file and line errors;
  - capture a representative sample: one frame per template or generator path, each distinct layout, the largest and the smallest, and every frame `validate` flagged;
  - capture the sample in each supported theme.
- **After a fix,** capture again only the frames the fix touched.
- **Report** which frames you validated, which you captured and looked at, and which you did not check.

## Troubleshooting

- **Frame missing from the canvas:** its ID is not in `frames` and in exactly one page's `frames` array, or its `source` is outside that page's folder.
- **Unstyled frame:** the `<link>` path is wrong for the file's location (page frames use `../tokens.css`), or a style source has an error in the theme editor (`design styles` lists it).
- **One rule or font missing:** the frame's HTML does not use the class, id or element the rule's selector needs, or no kept rule names the font family; frames receive only what they use.
- **Fallback font instead of a Google font:** the download is pending or failed; the theme editor says which, and Update retries.
- **Theme has no effect:** the token is missing from that `[data-zd-theme]` block, or the style source's `themes` selector does not match its CSS.
- **A declared build never runs:** the Design tab must be open; the theme editor says whether it is waiting for setup, failed, or turned off by `repository_style_builds = false`.
- **Pages unavailable:** `meta/canvas.json` is unreadable or conflicted. Repair it with normal tools and keep its IDs; do not recreate registration.
