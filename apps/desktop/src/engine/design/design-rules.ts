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
export const DESIGN_RULES = `# Zeros Design
meta/design.toml registers this directory; meta/canvas.json owns its pages and canvas metadata. Commit this folder together. Do not gitignore it.
For authorized local Design edits, use normal Read, Write, Edit, patch or Bash tools to author HTML, CSS, assets and meta/canvas.json. No API apply, publish or mode switch is required. Cloud executions follow their composer authoring policy.
Code agents may inspect or edit this folder when the user's request calls for it. The Design tag sets the default editing target; an attached frame in Code context is normally a reference for application implementation. Provider permissions and Plan still apply.
Each page has its own folder. Create a frame by writing <page.folder>/<name>.html and adding its stable ID to meta/canvas.json frames and that page's frames array. Example frame: {"kind":"html","source":"page-1/home.html","title":"Home","x":0,"y":0,"width":390,"height":844}.
Add a page natively by appending a page record to meta/canvas.json pages and create the folder at the Design root. Example: {"id":"checkout","title":"Checkout","folder":"checkout","frames":[]}. Use a unique stable ID and title; folder must be one portable segment (1-64 letters, digits, dots, underscores or hyphens; start with a letter or digit, no trailing dot). A lowercase slug is recommended. Folder names must be unique case-insensitively, must not be meta, assets or components in any case, and must not collide with another root entry. Keep 1-64 pages and at most 256 frames across the whole directory. Each frame ID belongs to exactly one page and its source stays inside that page's folder. Page rename changes the title only; preserve its folder.
Keep directory, page and frame IDs and unrelated metadata. Patch existing source; canvas dimensions set its viewport. ${DESIGN_FRAME_AUTHORING_INSTRUCTION} Only listed HTML files are frames. Shared tokens.css, components and assets stay at the Design root; link ../tokens.css from a page's HTML frame. Resolve frame HTML and CSS references relative to the containing source file; component HTML references stay relative to the Design root.
Use Zeros Settings or Design mode lifecycle tools to create, migrate or remove registration. Preserve IDs when repairing existing source conflicts. Design API inspect, styles, validate and capture are optional helpers; visual controls edit the same source.
Save sources before canvas references. Re-read changed files before edits; do not overwrite concurrent work. Normal authorized Git operations integrate these same checkout files; saving never auto-commits.
`;

export const GENERATED_DESIGN_RULES = [
  DESIGN_RULES,
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
