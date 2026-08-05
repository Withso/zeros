// ──────────────────────────────────────────────────────────
// Build srcdoc HTML for a static variant preview iframe
// ──────────────────────────────────────────────────────────
//
// The viewport width is the iframe's layout width — identical
// to a real browser tab with width=device-width. No artificial
// max-width clamps that would break responsive layouts.

export function buildVariantSrcdoc(html: string, css: string): string {
  const importLines: string[] = [];
  const ruleLines: string[] = [];
  const linkTags: string[] = [];
  const rawCss = css || "";

  const rules = rawCss.split(/\n(?=[@.#[:*a-zA-Z])/);

  for (const rule of rules) {
    const trimmed = rule.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("@import ")) {
      const hrefMatch = trimmed.match(/@import\s+url\(["']?([^"')]+)["']?\)/);
      if (hrefMatch?.[1]) {
        linkTags.push(
          `<link rel="stylesheet" href="${hrefMatch[1].replace(/"/g, "&quot;")}">`,
        );
      } else {
        importLines.push(trimmed);
      }
    } else if (
      !trimmed.includes("[data-Zeros") &&
      !trimmed.includes(".react-flow") &&
      !trimmed.includes("--xy-") &&
      !trimmed.includes("--zeros-")
    ) {
      ruleLines.push(trimmed);
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${linkTags.join("\n")}
<style>${importLines.join("\n")}</style>
<style>*,*::before,*::after{box-sizing:border-box;}
html{height:100%;}
body{margin:0;padding:0;width:100%;height:100%;overflow-x:hidden;overflow-y:auto;-webkit-text-size-adjust:100%;}
.zeros-variant-viewport{width:100%;}
${ruleLines.join("\n")}</style>
</head>
<body><div class="zeros-variant-viewport">${html}</div></body>
</html>`;
}
