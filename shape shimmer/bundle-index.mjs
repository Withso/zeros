import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const directory = dirname(fileURLToPath(import.meta.url));
const indexPath = join(directory, "index.html");

function read(name) {
  return readFileSync(join(directory, name), "utf8").trim();
}

function replaceInlineSource(html, marker, source) {
  const start = `    <!-- inline-source:${marker}:start -->`;
  const end = `    <!-- inline-source:${marker}:end -->`;
  const startIndex = html.indexOf(start);
  const endIndex = html.indexOf(end);
  if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) {
    throw new Error(`Missing inline source markers for ${marker}`);
  }

  const replacement = `${start}\n    <script>\n${source}\n    </script>\n${end}`;
  return (
    html.slice(0, startIndex) + replacement + html.slice(endIndex + end.length)
  );
}

let html = readFileSync(indexPath, "utf8");
html = html.replace(
  /    <style>[\s\S]*?<\/style>/,
  `    <style>\n${read("shape-shimmer.css")}\n    </style>`,
);
html = replaceInlineSource(html, "story-poses", read("story-poses.js"));
html = replaceInlineSource(html, "story-shimmer", read("story-shimmer.js"));
html = replaceInlineSource(html, "preview", read("preview.js"));
writeFileSync(indexPath, html);
