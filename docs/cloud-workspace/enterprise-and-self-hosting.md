# Enterprise and self-hosting

Enterprise support should extend the same workspace protocol and data model,
not fork the product into a separate implementation.

## Control-plane and data-plane separation

- The control plane owns identity integration, authorization policy, workspace
  intent, orchestration, audit, and product entitlements.
- The customer data plane may own execution environments, the durable workspace
  record, object storage, Git remotes, network policy, and encryption keys.
- Every endpoint for the durable record, provider, storage service, and identity
  issuer must be configuration, never a hard-coded vendor URL.

The same migrations, protocol versions, reconciliation logic, and security
tests must run in hosted and customer-managed modes.

## Deployment progression

1. **Hosted SaaS:** Zeros operates control and data planes.
2. **Customer data plane:** Zeros operates orchestration while execution and
   durable data stay in the customer's cloud account.
3. **Self-hosted:** the customer operates both planes from documented release
   artifacts.
4. **Restricted/offline:** supported only after dependency, update, identity,
   model access, and license workflows work without an undeclared public
   network dependency.

Do not advertise a rung until installation, upgrade, backup/restore, audit,
support, and security-response procedures are tested for it.

## Seams to preserve now

- configurable identity issuer and JWKS;
- configurable durable-record and object-storage endpoints;
- provider-neutral execution lifecycle interface;
- user/Organization-owned provider connections behind encrypted references;
- tenant-scoped encryption and audit context;
- versioned repository/environment/settings snapshots with the same resolver in
  hosted and customer-managed deployments;
- separate PostgreSQL metadata and S3-compatible encrypted blob/checkpoint
  interfaces;
- portable export and deletion;
- no renderer dependency on operator credentials or internal deployment URLs;
- externally documentable health, migration, backup, and upgrade commands; and
- version negotiation across clients, control plane, engine, and record schema.

## Enterprise security expectations

Support least-privilege service identities, customer-managed network controls,
regional placement, retention policies, audit export, key rotation, incident
response, and data deletion. SSO/SCIM or compliance claims require their own
implemented controls and evidence; repository architecture alone is not such
evidence.
