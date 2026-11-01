# Styling: style sources, themes and tokens

A frame can use any combination of the application's imported style sources, the directory's manual tokens, and its own `<style>`. The theme editor in the Design tab shows each source with its status.

When the request calls for the application's design system, prefer its own styles: sync them (below) rather than recreating tokens. Imported sources are read live from the checkout, so saved changes to the application's stylesheets, including uncommitted ones on this branch, update frames.

## Themes (`meta/canvas.json` `themes`)

A theme id is a lowercase letter, then letters, digits, `_` or `-`. Name the themes and choose the default:

```json
"themes": [
  { "id": "dark", "label": "Dark", "base": true },
  { "id": "light", "label": "Light" }
]
```

- The default theme (`"base": true`, at most one) is what frames show when no other theme is chosen. Its values are `:root`, and frames also carry `data-zd-theme="<id>"` for it, so rules a source maps to that id apply.
- Themes a source maps or `tokens.css` declares but the list omits still appear, labelled from their id. People rename themes in the theme editor; keep ids stable.
- The canvas Themes menu applies a theme by setting `data-zd-theme` on every frame root. Do not author `data-zd-theme` or a theme switch yourself.

## Manual tokens (`tokens.css`)

- `tokens.css` holds Design-only tokens: values the application lacks. A new directory starts with none; never add placeholder tokens that duplicate the application's.
- `:root` holds the default theme's values; another theme is a `[data-zd-theme="<id>"]` rule. A manual token overrides an imported one with the same name (the theme editor marks it).
- Use `var(--token)` whenever a matching token exists. Add a typed `@property` declaration before introducing a new token.
- The theme editor edits this same file. Some projects generate it; follow the directory's `rules.md`.

## Imported style sources (`meta/canvas.json` `styles`)

Style sources import a stylesheet from elsewhere in the repository, so frames use the application's real tokens, and with Tailwind its real utility classes, without copying them. Declare each once:

```json
"styles": [
  { "id": "app", "title": "App styles", "kind": "tailwind", "path": "src/styles/app.css",
    "themes": { "light": "[data-theme=\"light\"]" } },
  { "id": "brand", "title": "Brand tokens", "kind": "css", "path": "src/styles/brand.css" }
]
```

- `path` is repository-relative and must be a regular file inside the checkout, outside `.git` and `.zeros` (no symlinks, no `..`, at most 32 MiB). Declare at most 16 sources.
- `kind: "tailwind"` names the application's Tailwind CSS v4 entry, the stylesheet with `@import "tailwindcss"`. Zeros compiles it with its own bundled Tailwind (the theme editor names the version) for the classes each frame and its components use, so frames can use the application's utilities, `@theme` tokens, `@utility` rules and custom variants: `<main class="bg-bg2 p-3 rounded-md">`. CSS `@import`s inside the repository are followed, relative or from `node_modules` packages, including their fonts (up to 1,024 files and 64 MiB). Zeros runs its own copies of `@tailwindcss/typography`, `@tailwindcss/forms` and `tailwindcss-animate` for `@plugin`; other plugins and `@config` are not run, because they execute repository JavaScript, and what they add is missing. `@source` is ignored: frames supply their own classes. Tailwind's preflight applies, as in the application.
- With a Tailwind source, a class name that is also a Tailwind utility (`container`, `hidden`, `border`, `grid`) gets that utility. Use the application's utilities rather than inventing look-alike class names. Tailwind's rules are layered, so a frame's own unlayered CSS still overrides them.
- `kind: "sass"` names a `.scss` or `.sass` entry. Zeros compiles it with its own bundled Dart Sass; `@use`, `@forward` and `@import` resolve to partials inside the repository and to packages in `node_modules` (`pkg:`, bare names and webpack's `~name`). Nothing outside the checkout is read and no repository code runs.
- `kind: "css"` reads the file as plain CSS; nothing in the repository runs. `@import` rules and build-tool directives (`@tailwind`, `@source`, `@plugin`, `@config`, `@apply`, …) are skipped, and the theme editor notes what was skipped. Comments are dropped. Custom properties declared in Tailwind `@theme` blocks become ordinary `:root` tokens.
- **Fonts in sources.** `@font-face` rules are kept, and the `.woff2`, `.woff`, `.ttf` or `.otf` files their `src` references (relative to the stylesheet, inside the repository) are embedded, up to 16 MiB per source. A package stylesheet works once dependencies are installed, for example `"path": "node_modules/@fontsource-variable/geist/index.css"`. A Google Fonts `@import` (`fonts.googleapis.com`) is downloaded once and embedded through App fonts; other remote URLs never load.
- A `css` source does not follow `@import`. To use a file it pulls in, such as a font package, declare that file as its own source, or use a `tailwind` source for a Tailwind entry.
- `themes` maps a Design theme id to how the stylesheet expresses it: a selector such as `[data-theme="light"]` or `.dark`, or `@media (prefers-color-scheme: dark)` (or `light`) for a stylesheet that follows the system setting. Rules using it apply when the canvas shows that theme.
- **Each frame receives only what it uses.** A frame gets the rules whose selectors its classes, ids and elements can match, plus every custom property block, theme rule and other statement; font faces only for families its kept CSS names and only for the characters it shows; and keyframes only when named. A rule a frame needs must therefore match the frame's own HTML: classes that application JavaScript would add do not exist in a frame.
- **Which frames.** Every frame receives every declared source, in declaration order. A frame record may list `"styles": ["app"]` to choose its own sources, or `[]` for none.
- **Precedence.** Imported styles come first in the frame, so the frame's own `<link>` and `<style>` rules override them.
- `kind: "build"` imports the CSS file a build command writes, for stylesheets Zeros cannot compile itself (Less, PostCSS plugins, Tailwind v3 or Tailwind with other `@plugin`s or `@config`, CSS-in-JS extraction, token pipelines such as Style Dictionary). Write the output to `.zeros/design-styles/<id>.css`, which Zeros keeps out of Git in every worktree. The declaration carries the command (`"command"`, plus `"watch": true` or `"inputs"`), so each local worktree builds it automatically while the Design tab is open; builds stop 5 minutes after it is left, wait for a new worktree's setup to finish, and frames always show the last output meanwhile. A person can override the command for themselves, or turn repository builds off, in their own settings. The theme editor shows each build's state (live, building, waiting for setup, paused, or failed with its error) and whether its command came from `meta/canvas.json` or the person's settings.
- **Trust.** Opening Design runs the command a repository declares, as running its dev scripts would, including commands other people commit. Keep a declared command to the project's own build tool (`pnpm exec sass …`, `npx tailwindcss …`, a `package.json` script): no downloads, network calls, `curl | sh`, or writes outside the checkout. When a change you make, review or pull alters a declared command, tell the person.

## App fonts (`meta/canvas.json` `fonts`)

Fonts the application loads in code, such as `next/font/google` or `next/font/local` in a Next.js layout, are declared so frames get the same family and variable:

```json
"fonts": [
  { "family": "Geist", "provider": "google", "variable": "--font-geist-sans", "weights": "100..900" },
  { "family": "Geist Mono", "provider": "google", "variable": "--font-geist-mono", "weights": "100..900", "subsets": ["latin"] },
  { "family": "Brand", "provider": "local", "path": "src/fonts/Brand.woff2", "variable": "--font-brand", "weight": "400 700" }
]
```

- `provider: "google"` takes `weights` (`"400;700"` or a variable range `"100..900"`), `italic`, `subsets` (default `latin`) and `fallback`. Zeros downloads it once from `fonts.googleapis.com` and `fonts.gstatic.com` only, into one cache shared by every local workspace on this machine, and embeds it. Frames show the fallback font until it arrives; Update retries a failed download.
- `provider: "local"` names a `.woff2`, `.woff`, `.ttf` or `.otf` file inside the repository, with optional `weight` and `style`.
- `variable` sets the same custom property the application sets (next/font's `variable` option), so its Tailwind theme or CSS resolves unchanged. When the application applies a font with next/font's `className` instead, frames have no such class: give the font a `variable` and add `body { font-family: var(--font-…); }` to `tokens.css`. Frames carry a font only when their CSS names it.
- The theme editor lists them, with Google Fonts imported by sources, as **App fonts**. At most 32 fonts.

## Sync the application's styles

When the person asks you to sync, connect or use the application's styles, or Zeros sends "Set up style syncing", set it up end to end; their request is the go-ahead, and they should not need to run anything afterwards. Syncing is configuration in this repository's files: there is no sync API, and nothing syncs until a source is declared.

1. **Find the stylesheets, themes and fonts.** Read `package.json` (scripts and dependencies), the files the application entry imports (`main.tsx`, `index.tsx`, `app/layout.tsx`, `_app.tsx`, …), any `tailwind.config.*`, `postcss.config.*`, `vite.config.*`, Sass/Less entry or token pipeline, how the application switches themes (a `class`, a `data-` attribute or the system setting), and the fonts the layout loads.
2. **Choose a kind per stylesheet, preferring no build.**
   - Tailwind v4 entry (`@import "tailwindcss"`): `tailwind`. If frames need what another `@plugin` or `@config` adds, use `build` with the project's Tailwind CLI instead.
   - Sass entry: `sass`.
   - Plain CSS, including token files: `css`.
   - Anything that needs the project's own tool to produce CSS: `build`.
3. **For a `build` source, prefer the tool's watch mode** so changes appear without re-running a command: `sass --watch`, `tailwindcss --watch`, `postcss --watch`. Use the project's own binary (`pnpm exec`, `npx`, `yarn`), never a global one. Without a watch mode, use a one-shot command with `inputs` (the files or folders it reads).
4. **Write the declaration** in `meta/canvas.json` `styles`, command included, so every checkout builds it:

   ```json
   { "id": "app", "title": "App styles", "kind": "build",
     "path": ".zeros/design-styles/app.css",
     "command": "pnpm exec sass --watch src/styles/app.scss:.zeros/design-styles/app.css",
     "watch": true,
     "themes": { "light": "[data-theme=\"light\"]" } }
   ```

   For a one-shot command, drop `watch` and list what it reads in `"inputs": ["src/styles"]`; `"timeoutSeconds"` (1–600, default 120) bounds each run. The command receives `ZEROS_DESIGN_STYLE_OUTPUT` (the output path) and runs in the checkout after the workspace setup has installed dependencies. For a token pipeline (JSON to CSS), prefer a command that writes only the CSS to `.zeros/design-styles/` rather than regenerating tracked files.
5. **Map the themes and fonts.** Map each theme the stylesheet expresses in the source's `themes`, name the themes and the default in the `themes` list (the default is the theme `:root` holds, such as `"Dark"`), and declare the fonts the application loads in code in `fonts`.
6. **Keep `tokens.css` for Design-only values.** Do not copy the application's tokens into it.
7. **Personal overrides only.** A `[[design.style_builds]]` entry with the same `output` in the person's own settings (`~/.zeros/settings.toml` or the repository's `.zeros/settings.local.toml`) replaces the declared command for them. `[design] repository_style_builds = false` turns declared builds off while their own entries still run; a managed policy can enforce it. Write these only when the person asks.
8. **Check.** Run `<engine-command> design styles --url <url>`: it lists every source with its status, themes, token count and messages, and exits non-zero on errors. Fix every error and every message that asks for a declaration change; a package that is not installed yet resolves once the workspace setup finishes. Then validate and capture a frame that uses the styles in each theme you mapped.
9. **Report** which sources, themes and fonts you declared, which kinds you chose and why, the build command, and anything the person must decide (for example a plugin Zeros does not run). Add or change a build command only when the person asked you to set up or change styles: once committed, it runs in everyone's checkouts.

After syncing, the theme editor's **Update** re-reads every source from disk, reruns builds and retries font downloads, for changes Zeros cannot see (a package installed from a terminal, a failed build or download). A source whose declaration no longer matches the repository (a moved file, a theme selector the stylesheet no longer uses) shows **Ask agent to fix**, which sends you that source's status: correct its declaration, run `design styles`, and report.

## Choosing tokens

- **The catalog.** The theme editor lists every variable a frame can use: Manual (`tokens.css`) and each imported style source, with its type, group and per-theme values. `design styles` reports each source's status and token count, and the color picker's Theme tab lists the color tokens a frame resolves (`reference/editor.md`).
- **Choose by role.** Where the repository documents its tokens, pick a token by what it is for, not by a value that happens to match. In the Zeros repository that is `docs/design-system.md` (role tables for surfaces, text tiers, status families, borders, radius, spacing and controls), with values in `docs/design-tokens.md`. The directory's `rules.md` summarises the roles its frames use.
- **Write tokens as `var(--name)`** in classes, `<style>` and inline styles alike. The inspector shows the token name, and its Theme tab writes another token as a reference.
- **Values without a token.** A value the application has no token for can stay a literal in the frame's own CSS, or become a Manual token when several frames share it.
