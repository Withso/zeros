import React from "react";

// ──────────────────────────────────────────────────────────
// GithubIcon — local replacement for lucide-react's `Github`
// ──────────────────────────────────────────────────────────
//
// lucide-react dropped every brand glyph (Github, Gitlab, Twitter…)
// in its 1.x line — `import { Github } from "lucide-react"` resolves
// to `undefined`. In a production `vite build` that's a hard
// "not exported" failure; in the dev server esbuild tolerates the
// missing named export, so the app boots fine and then throws
// "Element type is invalid … got: undefined" the moment a <Github/>
// renders (Column 1's repo menu, the Open-GitHub dialog, the agents
// panel) — unmounting React to a black window.
//
// This faithfully reproduces lucide's outline Github path and default
// attributes so every existing call site stays a drop-in: it inherits
// color via `currentColor`, sizes off the Tailwind `size-*` / `w-* h-*`
// class already passed, and honours a `strokeWidth` override.
// ──────────────────────────────────────────────────────────

export function GithubIcon({
  strokeWidth = 2,
  ...props
}: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}
