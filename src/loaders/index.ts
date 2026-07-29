// ──────────────────────────────────────────────────────────
// Loaders — canonical loading UI primitives
// ──────────────────────────────────────────────────────────
//
// Single home for every reusable loader component in Zeros.
//
// A side-by-side showcase page lives under styles/Artifacts/ — a local-only
// dev design lab that is not part of a public checkout or the shipped bundle.
// ──────────────────────────────────────────────────────────

export { ActivityShimmer, type ActivityShimmerProps } from "./activity-shimmer";
export {
  ZerosSpinner,
  type ZerosSpinnerProps,
  type ZerosSpinnerVariant,
  type ZerosSpinnerTone,
} from "./zeros-spinner";
export { LiveDuration, DurationChip, formatElapsed } from "./live-duration";
export {
  RunHorseShimmer,
  type RunHorseShimmerProps,
} from "./run-horse-shimmer";
export { RunWave, type RunWaveProps } from "./run-wave";
