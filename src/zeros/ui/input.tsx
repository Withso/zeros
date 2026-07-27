// ============================================================
// Input / Textarea — wrap-style migration to v0 (Phase 9.B step 7)
//
// The legacy implementations rendered `<input>` / `<textarea>`
// with `.zeros-ui-input` / `.zeros-ui-textarea` classes from
// primitives.css. They're replaced by thin re-exports of the v0
// versions, which paint via Tailwind utilities reading v0
// tokens (border-border3, bg-transparent, focus-visible:ring-highlighted-bright,
// placeholder:text-fg2, etc.).
//
// 30 <Input> sites + 4 <Textarea> sites across the app keep
// their imports unchanged — the prop shape is identical
// (React.InputHTMLAttributes / React.TextareaHTMLAttributes
// passed through to the underlying element, className merged).
//
// Legacy Label had zero consumers and is dropped. If a future
// caller needs a label primitive, import from
// `@/zeros/ui/primitives/label` (Radix-based, auto-associates with the
// nearest input via `htmlFor`).
// ============================================================
export { Input } from "./primitives/input";
export { Textarea } from "./primitives/textarea";
