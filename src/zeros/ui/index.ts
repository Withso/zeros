// ============================================================
// Zeros UI primitives barrel — import from here, not from
// the individual component files, so the module graph stays
// stable across refactors.
//
//   import { Button, Input } from "@/Zeros/ui";
//
// Phase 9.B/9.D — `primitives.css` is no longer imported.
// Every legacy primitive that used to render `.zeros-ui-*` classes
// has been wrap-migrated to v0 or retired; nothing in the app
// renders any `.zeros-ui-*` class anymore, so its 443 lines of
// CSS would be dead weight.
// ============================================================

export { cn } from "./cn";
export { Button } from "./button";
export type { ButtonProps } from "./button";
export { Input, Textarea } from "./input";
export { ScrollArea } from "./scroll-area";
export { ErrorBoundary } from "./error-boundary";
export { GithubIcon } from "./github-icon";
