Dev webhook delivery alerts continued after normal shutdown and failed startup
because the launcher stopped its tunnel without pausing its owned endpoint.
Provisioning success is not service readiness. Resume delivery only after public
readiness, pause before stopping services, and keep a retryable cleanup receipt
when provider confirmation fails. A provider outage must not prevent local
processes from draining.

Keep the endpoint ID, signing key and immutable URL owner across restart. Verify
the complete identity before every mutation, and serialize an idle cleanup with
a new start. Preserve the Events API cursor and repair path for security events
missed while the transport is paused. The launcher lifecycle regression suite
drives lost responses, failed startup, cancellation, provider failure, replaced
identities and stale stop callers through the real supervisor functions.

For native qualification, distinguish a product startup defect from local DNS
failure. Compare the same hostname through the system and a public resolver
without printing provider credentials or weakening TLS. Native harnesses must
also allow OS-injected environment metadata while asserting that every selected
value and security-sensitive exclusion survives the actual packaged supervisor.
