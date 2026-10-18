Project navigation keys into closed native identities before invoking IPC.

- Symptom: cloud admission rejected ordinary parsed workspace keys.
- Cause: the parser adds a relative path; structural TypeScript types allowed
  that extra field through to a strict native target schema.
- Rule: test native entry points with the production parser's result, and
  explicitly select the permitted identity fields. Keep the native schema closed.
- Encoded in the cloud-sdk-runtime navigation-target regression and the
  stream lifecycle selection test. Local routing remains unchanged.
