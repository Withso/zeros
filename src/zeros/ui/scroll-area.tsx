// ============================================================
// ScrollArea — wrap-style migration to v0 (Phase 9.B step 6)
//
// The legacy ScrollArea (inline styles consuming removed pre-shadcn
// tokens) is replaced by a thin re-export of
// the v0 / shadcn ScrollArea. Six consumer files
// (engine/zeros-engine, panels/ai-chat-panel, panels/settings-
// page, panels/style-panel, themes/theme-mode-panel, themes/
// themes-page) keep their existing
//   `import { ScrollArea } from "../ui/scroll-area"`
// or barrel imports unchanged — their `className` props still
// pass through. The visible change: scroll thumbs now render
// with v0's zinc-based `bg-border` and Tailwind utilities, so
// they tint with the user's hue / intensity sliders.
// ============================================================
export { ScrollArea } from "./primitives/scroll-area";
