# Base runner advertisement and product rollout

Symptom: runtime qualification passed on the older base and refused
`engine_lifecycle` on the new base while the runner product flag was off.

Cause established by source: installing the base support marker independently
adds mandatory native runner qualification. The first failed live runner step
was not retained, so the marker fallback does not claim a native root cause.

Rule: an off product flag does not make a base capability dormant. Trace both
qualification and runtime consumers of support markers before shipping a base.
Keep an unqualified capability unadvertised, without weakening validation of a
present marker or claiming the deferred native probe passed.

Encoded in the default `basePayload`/build recipe regression and executable
inherited-marker guards in `cloud-runtime-base-v4.test.ts`; existing
`cloud-engine-qualification.test.ts` and `cloud-runner-native.test.ts` retain
supporting-base proof requirements and corrupt-marker refusal. The new base
and runtime pair still needs live qualification before admission.
