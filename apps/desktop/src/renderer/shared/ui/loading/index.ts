// ──────────────────────────────────────────────────────────
// Loaders — canonical loading UI primitives
// ──────────────────────────────────────────────────────────
//
// Single home for every reusable loader component in Zeros.
//
// A side-by-side showcase page lives under styles/Artifacts/ as a tracked
// design reference; it is not imported by the application or shipped bundle.
// ──────────────────────────────────────────────────────────

export { ActivityShimmer, type ActivityShimmerProps } from "./activity-shimmer";
export {
  ZerosSpinner,
  type ZerosSpinnerProps,
  type ZerosSpinnerVariant,
  type ZerosSpinnerTone,
} from "./zeros-spinner";
export {
  LiveDuration,
  DurationChip,
  WorkingDuration,
  formatElapsed,
  formatWorkingElapsed,
} from "./live-duration";
export { PuzzleSquare, type PuzzleSquareProps } from "./puzzle-square";
export { RunStream, type RunStreamProps } from "./run-stream";
