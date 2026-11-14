import { DESIGN_FRAME_AUTHORING_INSTRUCTION } from "@zeros/protocol/composer-mode";

export const LEGACY_DESIGN_RULES = `# Zeros Design
This is a Design directory; design.toml identifies it and stores its shared metadata.
Commit this folder and design.toml together. Do not gitignore them.
Edit through Zeros Settings or Design mode using the Design API.
Code agents may read this folder but must not create, edit, move, delete, stage, or commit its files through generic tools.
`;
/** Exact previously generated content is a migration/cleanup compatibility contract. */
export const PREVIOUS_NATIVE_DESIGN_RULES = `# Zeros Design
design.toml registers this directory; canvas.json owns its canvas metadata. Commit this folder together. Do not gitignore it.
In Design mode, use normal Read, Write, Edit, patch or Bash tools to author HTML, CSS, assets and canvas.json. No API apply or publish is required.
Code agents may inspect this folder; switch to Design mode only for user-authorized Design edits. Provider permissions and Plan still apply.
Create a frame by writing a complete HTML file and adding a stable ID to canvas.json frames and pages[0].frames. Example frame: {"kind":"html","source":"home.html","title":"Home","x":0,"y":0,"width":390,"height":844}.
Keep existing IDs and unrelated metadata. Patch existing source; canvas dimensions set its viewport. HTML uses normal browser layout. Only listed HTML files are frames; one page is supported.
Use Zeros Settings or Design mode lifecycle tools for directory registration and design.toml. Design API inspect, styles, validate and capture are optional helpers; visual controls edit the same source.
Save sources before canvas references. Re-read changed files before edits; do not overwrite concurrent work. Normal authorized Git operations publish these checkout files; saving never auto-commits.
`;
export const ROOT_DESIGN_RULES = `# Zeros Design
design.toml registers this directory; canvas.json owns its canvas metadata. Commit this folder together. Do not gitignore it.
For authorized local Design edits, use normal Read, Write, Edit, patch or Bash tools to author HTML, CSS, assets and canvas.json. No API apply, publish or mode switch is required. Cloud executions follow their composer authoring policy.
Code agents may inspect or edit this folder when the user's request calls for it. The Design tag sets the default editing target; an attached frame in Code context is normally a reference for application implementation. Provider permissions and Plan still apply.
Create a frame by writing a complete HTML file and adding a stable ID to canvas.json frames and pages[0].frames. Example frame: {"kind":"html","source":"home.html","title":"Home","x":0,"y":0,"width":390,"height":844}.
Keep existing IDs and unrelated metadata. Patch existing source; canvas dimensions set its viewport. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} Only listed HTML files are frames; one page is supported.
Use Zeros Settings or Design mode lifecycle tools to create, migrate or remove directory registration. Preserve directory and frame IDs when repairing existing source conflicts. Design API inspect, styles, validate and capture are optional helpers; visual controls edit the same source.
Save sources before canvas references. Re-read changed files before edits; do not overwrite concurrent work. Normal authorized Git operations integrate these same checkout files; saving never auto-commits.
`;
/** Paged rules as shipped with the directory-wide frame limit. */
export const PREVIOUS_PAGED_DESIGN_RULES = `# Zeros Design
meta/design.toml registers this directory; meta/canvas.json owns its pages and canvas metadata. Commit this folder together. Do not gitignore it.
For authorized local Design edits, use normal Read, Write, Edit, patch or Bash tools to author HTML, CSS, assets and meta/canvas.json. No API apply, publish or mode switch is required. Cloud executions follow their composer authoring policy.
Code agents may inspect or edit this folder when the user's request calls for it. The Design tag sets the default editing target; an attached frame in Code context is normally a reference for application implementation. Provider permissions and Plan still apply.
Each page has its own folder. Create a frame by writing <page.folder>/<name>.html and adding its stable ID to meta/canvas.json frames and that page's frames array. Example frame: {"kind":"html","source":"page-1/home.html","title":"Home","x":0,"y":0,"width":390,"height":844}.
Add a page natively by appending a page record to meta/canvas.json pages and create the folder at the Design root. Example: {"id":"checkout","title":"Checkout","folder":"checkout","frames":[]}. Use a unique stable ID and title; folder must be one portable segment (1-64 letters, digits, dots, underscores or hyphens; start with a letter or digit, no trailing dot). A lowercase slug is recommended. Folder names must be unique case-insensitively, must not be meta, assets or components in any case, and must not collide with another root entry. Keep 1-64 pages and at most 256 frames across the whole directory. Each frame ID belongs to exactly one page and its source stays inside that page's folder. Page rename changes the title only; preserve its folder.
Keep directory, page and frame IDs and unrelated metadata. Patch existing source; canvas dimensions set its viewport. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} Only listed HTML files are frames. Shared tokens.css, components and assets stay at the Design root; link ../tokens.css from a page's HTML frame. Resolve frame HTML and CSS references relative to the containing source file; component HTML references stay relative to the Design root.
Use Zeros Settings or Design mode lifecycle tools to create, migrate or remove registration. Preserve IDs when repairing existing source conflicts. Design API inspect, styles, validate and capture are optional helpers; visual controls edit the same source.
Save sources before canvas references. Re-read changed files before edits; do not overwrite concurrent work. Normal authorized Git operations integrate these same checkout files; saving never auto-commits.
`;
/** Paged rules as shipped with the per-page frame limit, before the authoring
 * contract. */
export const PREVIOUS_PER_PAGE_DESIGN_RULES = `# Zeros Design
meta/design.toml registers this directory; meta/canvas.json owns its pages and canvas metadata. Commit this folder together. Do not gitignore it.
For authorized local Design edits, use normal Read, Write, Edit, patch or Bash tools to author HTML, CSS, assets and meta/canvas.json. No API apply, publish or mode switch is required. Cloud executions follow their composer authoring policy.
Code agents may inspect or edit this folder when the user's request calls for it. The Design tag sets the default editing target; an attached frame in Code context is normally a reference for application implementation. Provider permissions and Plan still apply.
Each page has its own folder. Create a frame by writing <page.folder>/<name>.html and adding its stable ID to meta/canvas.json frames and that page's frames array. Example frame: {"kind":"html","source":"page-1/home.html","title":"Home","x":0,"y":0,"width":390,"height":844}.
Add a page natively by appending a page record to meta/canvas.json pages and create the folder at the Design root. Example: {"id":"checkout","title":"Checkout","folder":"checkout","frames":[]}. Use a unique stable ID and title; folder must be one portable segment (1-64 letters, digits, dots, underscores or hyphens; start with a letter or digit, no trailing dot). A lowercase slug is recommended. Folder names must be unique case-insensitively, must not be meta, assets or components in any case, and must not collide with another root entry. Keep 1-64 pages and at most 1,000 frames per page; the directory has no separate frame limit. Each frame ID belongs to exactly one page and its source stays inside that page's folder. Page rename changes the title only; preserve its folder.
Keep directory, page and frame IDs and unrelated metadata. Patch existing source; canvas dimensions set its viewport. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} Only listed HTML files are frames. Shared tokens.css, components and assets stay at the Design root; link ../tokens.css from a page's HTML frame. Resolve frame HTML and CSS references relative to the containing source file; component HTML references stay relative to the Design root.
Use Zeros Settings or Design mode lifecycle tools to create, migrate or remove registration. Preserve IDs when repairing existing source conflicts. Design API inspect, styles, validate and capture are optional helpers; visual controls edit the same source.
Save sources before canvas references. Re-read changed files before edits; do not overwrite concurrent work. Normal authorized Git operations integrate these same checkout files; saving never auto-commits.
`;
/** The first authoring contract, whose rule 8 made repeats components/ files. */
export const PREVIOUS_CONTRACT_DESIGN_RULES = `# Zeros Design
meta/design.toml registers this directory; meta/canvas.json owns its pages and canvas metadata. Commit this folder together. Do not gitignore it.
For authorized local Design edits, use normal Read, Write, Edit, patch or Bash tools to author HTML, CSS, assets and meta/canvas.json. No API apply, publish or mode switch is required. Cloud executions follow their composer authoring policy.
Code agents may inspect or edit this folder when the user's request calls for it. The Design tag sets the default editing target; an attached frame in Code context is normally a reference for application implementation. Provider permissions and Plan still apply.
Each page has its own folder. Create a frame by writing <page.folder>/<name>.html and adding its stable ID to meta/canvas.json frames and that page's frames array. Example frame: {"kind":"html","source":"page-1/home.html","title":"Home","x":0,"y":0,"width":390,"height":844}.
Add a page natively by appending a page record to meta/canvas.json pages and create the folder at the Design root. Example: {"id":"checkout","title":"Checkout","folder":"checkout","frames":[]}. Use a unique stable ID and title; folder must be one portable segment (1-64 letters, digits, dots, underscores or hyphens; start with a letter or digit, no trailing dot). A lowercase slug is recommended. Folder names must be unique case-insensitively, must not be meta, assets or components in any case, and must not collide with another root entry. Keep 1-64 pages and at most 1,000 frames per page; the directory has no separate frame limit. Each frame ID belongs to exactly one page and its source stays inside that page's folder. Page rename changes the title only; preserve its folder.
Keep directory, page and frame IDs and unrelated metadata. Patch existing source; canvas dimensions set its viewport. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} Only listed HTML files are frames. Shared tokens.css, components and assets stay at the Design root; link ../tokens.css from a page's HTML frame. Resolve frame HTML and CSS references relative to the containing source file; component HTML references stay relative to the Design root.
Use Zeros Settings or Design mode lifecycle tools to create, migrate or remove registration. Preserve IDs when repairing existing source conflicts. Design API inspect, styles, validate and capture are optional helpers; visual controls edit the same source.
Save sources before canvas references. Re-read changed files before edits; do not overwrite concurrent work. Normal authorized Git operations integrate these same checkout files; saving never auto-commits.
Authoring contract. design validate warns when a frame breaks rule 3, 4 or 8; warnings never block a save.
1. One class vocabulary per directory: reuse the classes its stylesheets and style sources define, and never invent a second name for one. Example: every frame's cards use .card, none adds .tile.
2. Draw a state on the same markup with an attribute or a state class, never a second copy. Example: <button data-state="open"> or .btn.is-active, not a second .btn-active button.
3. Write token values as var(--name); no literal where a token holds that value. Example: color: var(--fg2), not the hex it resolves to.
4. Inline style is for one-off values and people's Style panel edits; declarations used on several elements belong in a class. Example: .row { display: flex; gap: var(--space-2); }.
5. data-oid is optional: keep existing values and add stable ones only where selection must survive a restructure. Component definitions use data-zid.
6. Give meaningful layers a data-name (up to 80 characters). Example: <section data-name="Pricing table">.
7. Mark markup captured or pasted from a site or an app with data-zd-captured on its root, optionally naming its source, and do not adopt its classes as this directory's vocabulary; a title such as "Settings — captured" tells people. The contract checks skip marked markup, so mark only markup that really came from elsewhere, never this directory's own. Example: <main data-zd-captured="zeros renderer">.
8. Markup repeated three or more times becomes a component: components/<name>.html with <slot> and data-zd-attr. Example: <zd-card title="Plans">Body</zd-card>.
`;
export const DESIGN_RULES = `# Zeros Design
meta/design.toml registers this directory; meta/canvas.json owns its pages and canvas metadata. Commit this folder together. Do not gitignore it.
For authorized local Design edits, use normal Read, Write, Edit, patch or Bash tools to author HTML, CSS, assets and meta/canvas.json. No API apply, publish or mode switch is required. Cloud executions follow their composer authoring policy.
Code agents may inspect or edit this folder when the user's request calls for it. The Design tag sets the default editing target; an attached frame in Code context is normally a reference for application implementation. Provider permissions and Plan still apply.
Each page has its own folder. Create a frame by writing <page.folder>/<name>.html and adding its stable ID to meta/canvas.json frames and that page's frames array. Example frame: {"kind":"html","source":"page-1/home.html","title":"Home","x":0,"y":0,"width":390,"height":844}.
Add a page natively by appending a page record to meta/canvas.json pages and create the folder at the Design root. Example: {"id":"checkout","title":"Checkout","folder":"checkout","frames":[]}. Use a unique stable ID and title; folder must be one portable segment (1-64 letters, digits, dots, underscores or hyphens; start with a letter or digit, no trailing dot). A lowercase slug is recommended. Folder names must be unique case-insensitively, must not be meta, assets or components in any case, and must not collide with another root entry. Keep 1-64 pages and at most 1,000 frames per page; the directory has no separate frame limit. Each frame ID belongs to exactly one page and its source stays inside that page's folder. Page rename changes the title only; preserve its folder.
Keep directory, page and frame IDs and unrelated metadata. Patch existing source; canvas dimensions set its viewport. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} Only listed HTML files are frames. Shared tokens.css and assets stay at the Design root; link ../tokens.css from a page's HTML frame. Resolve HTML and CSS references relative to the containing source file; an existing components/<name>.html file resolves its references from the Design root.
Use Zeros Settings or Design mode lifecycle tools to create, migrate or remove registration. Preserve IDs when repairing existing source conflicts. Design API inspect, styles, validate and capture are optional helpers; visual controls edit the same source.
Save sources before canvas references. Re-read changed files before edits; do not overwrite concurrent work. Normal authorized Git operations integrate these same checkout files; saving never auto-commits.
Authoring contract. design validate warns when a frame breaks rule 3, 4 or 8; warnings never block a save.
1. One class vocabulary per directory: reuse the classes its stylesheets and style sources define, and never invent a second name for one. Example: every frame's cards use .card, none adds .tile.
2. Draw a state on the same markup with an attribute or a state class, never a second copy. Example: <button data-state="open"> or .btn.is-active, not a second .btn-active button.
3. Write token values as var(--name); no literal where a token holds that value. Example: color: var(--fg2), not the hex it resolves to.
4. Inline style is for one-off values and people's Style panel edits; declarations used on several elements belong in a class. Example: .row { display: flex; gap: var(--space-2); }.
5. data-oid is optional: keep existing values and add stable ones only where selection must survive a restructure. A main frame's data-oid values name the parts its instances override, so keep them stable. Existing components/<name>.html files use data-zid and stay valid.
6. Give meaningful layers a data-name (up to 80 characters). Example: <section data-name="Pricing table">.
7. Mark markup captured or pasted from a site or an app with data-zd-captured on its root, optionally naming its source, and do not adopt its classes as this directory's vocabulary; a title such as "Settings — captured" tells people. The contract checks skip marked markup, so mark only markup that really came from elsewhere, never this directory's own. Example: <main data-zd-captured="zeros renderer">.
8. Markup repeated three or more times becomes a component: a main frame whose meta/canvas.json record adds "component":"card". Declare its options in <head><template data-zd-options>, one per line, and use them as {{ name }}. Example: <zd-option name="heading" type="text" default="Untitled"></zd-option> with <h2 data-oid="heading">{{ heading }}</h2>. A slot is a frame marked data-zd-slot="body"; what it holds is the default. Other frames place <zd-card data-oid="plans" heading="Plans"><p data-oid="plans-copy" slot="body">Body</p></zd-card>. Never add components/<name>.html; Move main to canvas turns an existing one into a main.
`;

export const GENERATED_DESIGN_RULES = [
  DESIGN_RULES,
  PREVIOUS_CONTRACT_DESIGN_RULES,
  PREVIOUS_PER_PAGE_DESIGN_RULES,
  PREVIOUS_PAGED_DESIGN_RULES,
  ROOT_DESIGN_RULES,
  PREVIOUS_NATIVE_DESIGN_RULES,
  LEGACY_DESIGN_RULES,
];

export function upgradedDesignRules(
  source: string | null,
  canvasVersion: 1 | 2 = 1,
): string {
  const current = canvasVersion === 2 ? DESIGN_RULES : ROOT_DESIGN_RULES;
  if (source === null) return current;
  const generated = GENERATED_DESIGN_RULES.find((rules) =>
    source.startsWith(rules),
  );
  return generated ? current + source.slice(generated.length) : source;
}
