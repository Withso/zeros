# Design component model — Phase 4 spike

_2026-07-31. This is a deliberately bounded renderer experiment, not a new
document format. Plain HTML/CSS files remain authoritative._

## Decision

A component definition is `Zeros Design/components/<name>.html`. A frame uses
it with a matching custom element such as `<zd-button data-oid="cta"
label="Get started"></zd-button>`.

The engine expands instances only in the render response. It never rewrites the
authored frame, so Git retains the compact `zd-*` instance and an agent can edit
the same source it wrote. The host custom element remains the one selectable
node. Expanded internals deliberately do not receive frame-editable OIDs in
this spike; selection-to-source therefore never points at generated markup.

## Definition contract

- The component filename defines the tag: `button.html` → `zd-button`.
- The definition body is the rendered content. Head `<style>` blocks are
  injected once per used component into the frame head.
- `<slot data-zd-attr="label">Fallback</slot>` reads the named instance
  attribute as escaped text. A plain `<slot>` receives the instance's authored
  child markup.
- Instance attributes and CSS custom properties remain on the `zd-*` host, so
  component CSS can use attribute selectors and inherited `var(--...)` values.
- Components may reference other defined `zd-*` components. Expansion is
  deterministic and bounded to eight levels; cycles are rejected.

## Safety and scale boundaries

- Definitions are subject to the same HTML/CSS-only policy as frames. Authored
  scripts, event handlers, external URLs, and `javascript:` URLs are removed at
  render time and reported by lint.
- Only regular, symlink-free `.html` files directly inside `components/` are
  definitions. Each file is bounded to 512 KiB, at most 64 definitions are
  loaded, and expanded output is capped at 2 MiB.
- Undefined instances remain a stable `component-undefined` lint error. A
  cycle or malformed definition is a `component-invalid` error.
- Component expansion contributes to the frame source version, so changing a
  definition invalidates the exact rendered generation and stale inspector or
  screenshot writes are rejected.

## Explicit non-goals

- No component authoring UI, variants, overrides graph, detach operation, or
  generated source mapping in this spike.
- No JavaScript custom-element registration or shadow DOM.
- No independent selection or mutation of generated component internals.

Those require a separate design after the render-time model has proven useful
with real files and readable Git diffs.
