// ──────────────────────────────────────────────────────────
// Key glyphs — the macOS modifier and arrow symbols, as drawings
// ──────────────────────────────────────────────────────────
//
// Paths from Phosphor Icons, Bold weight (@phosphor-icons/core 2.1.1,
// assets/bold/*-bold.svg), copyright 2023 Phosphor Icons, under MIT; the
// license is preserved at third_party/phosphor-icons/LICENSE. Copied
// unmodified onto Phosphor's 256 grid.
//
// One family for every key: ⌘ ⌥ ⇧ ⌃ at the height of a capital, a 24/256
// line that matches the stems of the 11px Geist medium letters beside them.
// Filled outlines, not strokes, so the global lucide stroke rule never thins
// them. Geist has no ⌘ ⌥ ⌃ ⌫, so text symbols would mix fonts.
// ──────────────────────────────────────────────────────────

export const KEY_GLYPH_PATHS = {
  // command
  "⌘": "M180,140H164V116h16a40,40,0,1,0-40-40V92H116V76a40,40,0,1,0-40,40H92v24H76a40,40,0,1,0,40,40V164h24v16a40,40,0,1,0,40-40ZM164,76a16,16,0,1,1,16,16H164ZM60,76a16,16,0,0,1,32,0V92H76A16,16,0,0,1,60,76ZM92,180a16,16,0,1,1-16-16H92Zm24-64h24v24H116Zm64,80a16,16,0,0,1-16-16V164h16a16,16,0,0,1,0,32Z",
  // option
  "⌥": "M236,192a12,12,0,0,1-12,12H160.94a19.89,19.89,0,0,1-17.88-11.06L92.58,92H32a12,12,0,0,1,0-24H95.06a19.89,19.89,0,0,1,17.88,11.06L163.42,180H224A12,12,0,0,1,236,192ZM152,92h72a12,12,0,0,0,0-24H152a12,12,0,0,0,0,24Z",
  // arrow-fat-up
  "⇧": "M232.48,111.51l-96-96a12,12,0,0,0-17,0l-96,96A12,12,0,0,0,32,132H68v76a20,20,0,0,0,20,20h80a20,20,0,0,0,20-20V132h36a12,12,0,0,0,8.48-20.49ZM176,108a12,12,0,0,0-12,12v84H92V120a12,12,0,0,0-12-12H61l67-67,67,67Z",
  // control
  "⌃": "M208.49,128.49a12,12,0,0,1-17,0L128,65,64.49,128.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,128.49Z",
  // arrow-elbow-down-left
  "↵": "M204,32V176a12,12,0,0,1-12,12H77l27.52,27.51a12,12,0,0,1-17,17l-48-48a12,12,0,0,1,0-17l48-48a12,12,0,1,1,17,17L77,164H180V32a12,12,0,0,1,24,0Z",
  // backspace
  "⌫": "M216,36H68.53a20.09,20.09,0,0,0-17.15,9.71L5.71,121.83a12,12,0,0,0,0,12.34l45.67,76.12A20.09,20.09,0,0,0,68.53,220H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36Zm-4,160H70.8L30,128,70.8,60H212ZM103.51,143.51,119,128l-15.52-15.51a12,12,0,0,1,17-17L136,111l15.51-15.52a12,12,0,0,1,17,17L153,128l15.52,15.51a12,12,0,0,1-17,17L136,145l-15.51,15.52a12,12,0,0,1-17-17Z",
  // arrow-left
  "←": "M228,128a12,12,0,0,1-12,12H69l51.52,51.51a12,12,0,0,1-17,17l-72-72a12,12,0,0,1,0-17l72-72a12,12,0,0,1,17,17L69,116H216A12,12,0,0,1,228,128Z",
  // arrow-right
  "→": "M224.49,136.49l-72,72a12,12,0,0,1-17-17L187,140H40a12,12,0,0,1,0-24H187L135.51,64.48a12,12,0,0,1,17-17l72,72A12,12,0,0,1,224.49,136.49Z",
  // arrow-up
  "↑": "M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z",
  // arrow-down
  "↓": "M208.49,152.49l-72,72a12,12,0,0,1-17,0l-72-72a12,12,0,0,1,17-17L116,187V40a12,12,0,0,1,24,0V187l51.51-51.52a12,12,0,0,1,17,17Z",
  // arrow-up-left
  "↖": "M200.49,200.49a12,12,0,0,1-17,0L76,93v75a12,12,0,0,1-24,0V64A12,12,0,0,1,64,52H168a12,12,0,0,1,0,24H93L200.49,183.51A12,12,0,0,1,200.49,200.49Z",
  // arrow-down-right
  "↘": "M204,88V192a12,12,0,0,1-12,12H88a12,12,0,0,1,0-24h75L55.51,72.48a12,12,0,0,1,17-17L180,163V88a12,12,0,0,1,24,0Z",
} as const satisfies Record<string, string | readonly string[]>;

export type KeyGlyph = keyof typeof KEY_GLYPH_PATHS;

/** The characters drawn as glyphs, for splitting a shortcut into keys. */
export const KEY_GLYPH_SPLIT = new RegExp(`([${Object.keys(KEY_GLYPH_PATHS).join("")}])`);

export function isKeyGlyph(part: string): part is KeyGlyph {
  return Object.hasOwn(KEY_GLYPH_PATHS, part);
}

/** One key symbol at `className`'s size (11px in Kbd), in currentColor. */
export function KeyGlyphIcon({ glyph, className }: { glyph: KeyGlyph; className?: string }) {
  const paths: readonly string[] = [KEY_GLYPH_PATHS[glyph]].flat();
  return (
    <svg
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      data-key-glyph={glyph}
      className={className}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
