# Coherent catalog consumer ownership

- **Symptom.** A naive consumer could publish a terminal partial packet or a
  mixed-revision chain, and logical cancellation could hide still-executing
  staging/response ownership. A completed result could also outlive its caller's
  publication signal.
- **Cause.** Packet validity, whole-sequence completeness, exact-lifetime
  publication and actual resource settlement are different contracts. Reusing a
  whole catalog object across new intents could revive an old publication even
  when the descriptor contents were unchanged.
- **Rule.** Begin at zero and validate contiguous ranges, stable headers,
  cross-packet uniqueness and opaque cursor progress before publishing a
  distinct coherent type. Retain exact-key presentation during refresh, but
  gate membership actions on current coherent authority. Give each successful
  new intent a fresh catalog publication identity while reusing unchanged
  descriptor/page arrays, and keep cancellation ownership exact on cached hits.
  Keep retired producers
  and their staged payloads/reservations charged until their callback settles.
- **Encoded in.** The catalog adapter suite exercises the real passive workspace
  facade with Local Personal, organization-local and cloud-shaped owners, held
  ABA/cancellation replies, malformed coverage and explicit resource limits.
  Its naive-prototype red is feature-model evidence, not an escaped-mainline bug
  or an import failure counted as a catch.
