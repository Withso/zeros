# Worker package authentication across token rotation

- Symptom: the relocated worker package smoke intermittently marked an
  authenticated history request as unauthenticated during token rotation.
- Cause: the fixture replaced its one expected bearer before writing the new
  token file, and also compared in-flight requests after awaiting their body.
- Rule: validate overlapping requests against the exact issued credentials for
  that rotation. Keep every-request authentication and separately prove a real
  later request uses the rotated credential; accepting an old in-flight request
  must not conceal a worker that never rereads its token file.
- Regression: `apps/cloud-worker/src/__tests__/package.test.ts` holds a real
  old-token history request across the write, releases it after rotation, and
  waits for a subsequent history request authenticated with the new token.
  The old fixture fails deterministically. No sleep or timeout increase is used,
  and production authentication behavior is unchanged.
