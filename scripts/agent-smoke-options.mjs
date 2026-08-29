const MAX_ADMISSION_COPIES = 4;
const MAX_ADMISSION_FAILURE_DETAIL_BYTES = 2_000;
const MAX_SINGLE_FAILURE_DETAIL_BYTES = 500;

function safeAdmissionFailureDetail(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw
    .replace(
      /\b((?:(?:access|refresh|api|auth|oauth)[_-]?)?(?:token|key)|secret|password)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1$2[redacted]",
    )
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return (scrubbed || "unknown admission failure").slice(
    0,
    MAX_SINGLE_FAILURE_DETAIL_BYTES,
  );
}

/** Preserve actionable root causes in a concurrency failure while keeping
 * provider-controlled text bounded, de-duplicated, and credential-scrubbed. */
export function formatAdmissionFailures(failures, total) {
  const details = [...new Set(failures.map(safeAdmissionFailureDetail))];
  return `${failures.length}/${total} concurrent admission(s) failed: ${details.join(" | ")}`.slice(
    0,
    MAX_ADMISSION_FAILURE_DETAIL_BYTES,
  );
}

/** Parse the bounded same-provider concurrency used by the no-model admission
 * smoke. A small hard cap prevents an accidental CLI typo from creating an
 * unbounded fleet of local sandbox workers. */
export function parseAdmissionCopies(argv) {
  const index = argv.indexOf("--admission-copies");
  if (index < 0) return 1;
  const raw = argv[index + 1];
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
    throw new Error("--admission-copies requires an integer from 1 to 4");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_ADMISSION_COPIES) {
    throw new Error("--admission-copies requires an integer from 1 to 4");
  }
  return value;
}
