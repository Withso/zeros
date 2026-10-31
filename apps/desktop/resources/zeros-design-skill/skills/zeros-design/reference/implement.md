# Implementing application code from a frame

A frame is a reference, not code to copy. Implement it with the application's own components, tokens and conventions, map frame values to the application's tokens or utilities, and run the application's checks. Keep the frame unchanged unless the user also asks for Design edits.

- Read the frame's classes and the tokens its values reference (`reference/editor.md` describes the provenance the inspector shows) and map them to the application's utilities, tokens and components. In the Zeros repository, `docs/design-system.md` maps frame values to utilities (`var(--bg2)` is `bg-bg2`) and controls to the shared primitives.
- Inline declarations on a frame element are often a person's canvas edits; carry them into the implementation as the application's own classes or tokens rather than inline styles.
