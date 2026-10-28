# Root-equivalent sandbox users read mode-000 files

A checkpoint test made a session file `chmod 000` to exercise the "a part
cannot be read" path; the file stayed readable because this sandbox's user
holds every capability, `CAP_DAC_OVERRIDE` included, while its uid is not 0.
Test a read-failure path by failing the reader itself: the checkpoint test
puts a `node` wrapper on `PATH` that refuses only the digest script. Encoded
in `zstack-verify` and `apps/control-plane/src/cloud/checkpoint.test.ts`.
