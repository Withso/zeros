# Cloud workspace security

Cloud workspaces execute untrusted repositories and agent-generated commands on
internet-connected infrastructure. The execution environment, repository,
agent output, browser content, network peers, and client input are all untrusted
boundaries.

## Required authorization layers

1. The client authenticates to the control plane.
2. Every workspace API authorizes the actor against the workspace's current
   organization, organization membership and role, and any narrower child-team
   grant. Personal must fail closed for cloud placement.
3. Provisioning credentials remain server-side and are never returned to a
   renderer or placed in a sandbox.
4. A remote engine connection uses a short-lived grant bound to account,
   workspace, audience, expiry, and protocol purpose.
5. The engine validates that binding before accepting privileged bridge
   messages.

The current validation harness uses a provider preview token and a separate
Zeros bridge token. That is adequate only for an operator-controlled,
single-purpose experiment. A shared bridge token without account/workspace
binding is a production blocker.

## Sandbox requirements

- Isolate tenants at the provider's strongest supported compute boundary.
- Run as a non-root user with the minimum filesystem and process privileges.
- Deny inbound traffic except the intended bridge/health boundary.
- Restrict outbound destinations where the supported agent and package-manager
  workflows permit it; log policy decisions without logging credentials.
- Do not mount control-plane credentials, signing keys, production database
  credentials, or broad Git tokens in the environment.
- Destroy ephemeral credentials on stop/delete and verify resource deletion
  through reconciliation.
- Treat snapshots and caches as sensitive copies subject to encryption,
  retention, and deletion policy.

## Repository and agent credentials

Prefer short-lived, repository-scoped grants. Separate clone/fetch permissions
from branch-limited push permissions where possible. Never pass a user's broad
personal token to an untrusted workspace merely because the local application
already has it.

Agent authentication and redistribution terms are independent release gates.
A technically functioning runtime must not ship until its supported
authentication flow, license, and redistribution rights are approved.

## Bridge and protocol

- Use TLS end to end across every non-local hop.
- Keep credentials in headers or an equivalent protected handshake; do not put
  them in URLs, analytics, or logs.
- Enforce message schemas, size limits, backpressure, and authorization at the
  receiving boundary.
- Rate-limit connection attempts and privileged operations.
- Fail closed on protocol, account, workspace, or capability mismatch.
- Resume from bounded acknowledged state; never trust an arbitrary client
  revision without server validation.

## Multi-tenant data

All control-plane and durable-record queries require tenant-scoped
authorization. Database row-level controls supplement application checks; they
do not replace them. Background workers must set an explicit tenant/system
context and keep audit records for privileged operations.

## Release blockers

- no account/workspace-bound engine grant;
- unverified tenant isolation or deletion behavior;
- secrets appearing in images, snapshots, URLs, logs, or transcripts;
- provider lifecycle races that can expose or orphan a workspace;
- missing backup restoration and disaster-recovery exercise;
- unsupported agent/runtime redistribution or authentication;
- unresolved high-impact reachable dependency findings; or
- no signed/notarized client validation for the platform being released.
