// ──────────────────────────────────────────────────────────
// Editor Shiki-language resolver
// ──────────────────────────────────────────────────────────
//
// Maps a file path to a SHIKI bundled language id for the editor's color layer
// (the hybrid: Lezer for structure, Shiki for exact color). Broader than
// syntax.ts getLang (the curated code-block set) because the editor opens
// arbitrary files — including the long tail the user cares about (Swift, …).
// highlightToTokens loads the grammar on demand; an unknown extension returns
// null → no Shiki color, but the editor still works (plain text + Lezer
// structure). An id that doesn't exist in shiki's bundle also degrades
// gracefully (loadLanguage fails → null tokens).
// ──────────────────────────────────────────────────────────

const EXT_TO_SHIKI: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "proto",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  dart: "dart",
  lua: "lua",
  r: "r",
  scala: "scala",
  clj: "clojure",
  cljs: "clojure",
  hs: "haskell",
  ml: "ocaml",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  pl: "perl",
  ini: "ini",
  diff: "diff",
  patch: "diff",
};

/** Resolve a file path to a Shiki bundled language id, or null when unknown. */
export function shikiLangForPath(path: string | undefined): string | null {
  if (!path) return null;
  const base = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  // Extension-less, well-known filenames.
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "docker";
  if (base === "makefile") return "make";
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_TO_SHIKI[base.slice(dot + 1)] ?? null;
}
