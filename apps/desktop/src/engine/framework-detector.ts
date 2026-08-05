// ──────────────────────────────────────────────────────────
// Framework Detector — Auto-detect project framework
// ──────────────────────────────────────────────────────────
//
// Reads package.json dependencies and checks for entry files
// to determine the project's framework.
//
// ──────────────────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";

export type Framework =
  | "react"
  | "next"
  | "vue"
  | "nuxt"
  | "svelte"
  | "solid"
  | "angular"
  | "astro"
  | "unknown";

export interface DetectionResult {
  framework: Framework;
  entryFiles: string[];
  projectName: string;
}

const FRAMEWORK_DEPS: Record<string, Framework> = {
  next: "next",
  nuxt: "nuxt",
  "@angular/core": "angular",
  svelte: "svelte",
  "@sveltejs/kit": "svelte",
  vue: "vue",
  "solid-js": "solid",
  astro: "astro",
  react: "react",
};

const ENTRY_CANDIDATES: Record<Framework, string[]> = {
  next: [
    "app/page.tsx", "app/page.jsx", "app/page.js",
    "pages/index.tsx", "pages/index.jsx", "pages/index.js",
    "src/app/page.tsx", "src/pages/index.tsx",
  ],
  nuxt: [
    "pages/index.vue", "app.vue",
    "src/pages/index.vue", "src/app.vue",
  ],
  angular: [
    "src/app/app.component.ts", "src/main.ts",
  ],
  svelte: [
    "src/routes/+page.svelte", "src/App.svelte",
    "src/main.ts", "src/main.js",
  ],
  vue: [
    "src/App.vue", "src/main.ts", "src/main.js",
  ],
  solid: [
    "src/App.tsx", "src/App.jsx",
    "src/index.tsx", "src/index.jsx",
  ],
  astro: [
    "src/pages/index.astro", "src/layouts/Layout.astro",
  ],
  react: [
    "src/main.tsx", "src/main.jsx", "src/main.ts",
    "src/App.tsx", "src/App.jsx",
    "src/index.tsx", "src/index.jsx",
    "app/page.tsx", "pages/index.tsx",
  ],
  unknown: [
    "src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js",
    "src/index.tsx", "src/index.ts", "src/index.jsx", "src/index.js",
    "index.html",
  ],
};

export function detectFramework(cwd: string): DetectionResult {
  const pkgPath = path.join(cwd, "package.json");
  let projectName = path.basename(cwd);
  let framework: Framework = "unknown";

  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      projectName = pkg.name || projectName;

      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      for (const [dep, fw] of Object.entries(FRAMEWORK_DEPS)) {
        if (allDeps && allDeps[dep]) {
          framework = fw;
          break;
        }
      }
    } catch {
      // Malformed package.json — continue with unknown
    }
  }

  const candidates = ENTRY_CANDIDATES[framework] || ENTRY_CANDIDATES.unknown;
  let entryFiles = candidates.filter((f) => fs.existsSync(path.join(cwd, f)));

  if (entryFiles.length === 0 && framework !== "unknown") {
    entryFiles = ENTRY_CANDIDATES.unknown.filter((f) =>
      fs.existsSync(path.join(cwd, f))
    );
  }

  if (entryFiles.length === 0) {
    entryFiles.push(candidates[0] || "src/main.tsx");
  }

  return { framework, entryFiles, projectName };
}

/**
 * Walk up from cwd to find the nearest directory containing package.json.
 */
export function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return startDir; // fallback to start directory
}
