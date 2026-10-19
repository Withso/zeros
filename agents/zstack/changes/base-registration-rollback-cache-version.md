The base recipe and shared protocol gained an optional rollback-cache version,
but the control plane's independently mirrored strict schema did not. This
would refuse a newly built base before registration. The publication HTTP suite
now reads the current recipe contract and exercises both raw-only and parsed
echo requests through the real route up to a deliberate database barrier. It
also keeps legacy absence, unsupported-version refusals and raw/echo identity
checks. The regression and replay case are
`runtime-publication-routes.test.ts` and
`base-registration-rollback-cache-version`.
