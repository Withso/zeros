# Alpha publication and authentication acceptance

- Symptom: Alpha built and verified signed artifacts, then refused publication
  after one live API identity read timed out. The provider recorded HTTP 200
  just after that deadline. Browser-only release verification also left the
  independent Desktop application and callback untested.
- Cause: the frontier reader treated a single transport failure as final, and
  the WorkOS promotion probe exercised only browser facades. Decoding an
  emulator JWT alone did not exercise the resource server's signed-token contract.
- Rule: retry only bounded anonymous transport reads; abort each attempt,
  refuse invalid identity evidence immediately, and check recovered ancestry
  before writes. Exercise both public clients and record their evidence scope.
  A handshake or emulator pass cannot close a real user or two-person Ops ceremony.
- Encoded in `scripts/release/alpha-frontier-identity.test.ts`,
  `alpha-forward-only.test.ts`, `workos.test.ts`, and the WorkOS SDK emulator
  test, which now verifies signatures/claims, public Desktop exchange/refresh
  and independent browser/Desktop revocation. The authentication rollout guide
  keeps the remaining human acceptance requirements explicit.
- Live-campaign lesson: the server-side Magic Auth SDK sends a client secret;
  it cannot qualify the public Desktop client. Use the supported browser
  staging flow and qualify Desktop through PKCE. Scheduling account deletion
  revokes existing sessions: authenticate again before restore, and establish
  successful grace-route reads before a provider-deletion denial probe. The
  deployed-source evidence and its limits are recorded in the authentication
  rollout guide.
- Review lesson: accepting an old receipt with the new reader covers only one
  direction. The WorkOS receipt test also serializes the new optional field
  and parses it with the prior schema, proving the older reader accepts the
  artifact without acquiring the new verification claim.
