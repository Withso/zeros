# Design verification source entry

- **A simple frame edit detoured into launcher debugging.** Design verification
  treated every Bun runtime as a compiled executable, dropping the source entry
  and producing `bun design` in the person's checkout. Node source commands also
  dropped loader arguments. Share runtime resolution with the Local CLI and
  execute the advertised command from a different working directory, including
  quoted paths and compiled-entry controls (`engine/cli-invocation.ts`,
  `design/__tests__/verification-command.test.ts`, `zstack-verify`). Direct calls
  to the verification handler had bypassed the defective launcher.
- **Reference recreation became a measurement project before any HTML existed.**
  The Design skill lacked a short path for ordinary visual work and discouraged
  all absolute positioning. Produce a draft before optional precision work,
  resolve viewport intent once, allow positioned decorations, and refine visible
  differences. Keep command troubleshooting proportional to frame authoring
  (`apps/desktop/resources/zeros-design-skill/skills/zeros-design/SKILL.md`).
