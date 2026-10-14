API and durable worker traffic shared one pool, and each serving replica
started more workers. Separate pool factories alone cannot isolate them:
provider operation stores, Computer services, blob services and setup
dependencies retain the pool used at construction. WorkOS also holds a session
lock while its callback needs another query slot; leadership cannot reserve
one of the two worker slots.

Test the actual boot composition as well as pool saturation. Give DB-bound
workers separate dependencies, keep API-local caches on their owning process,
and use the driver's native acquire deadline to remove expired waiters. A
Promise.race alone leaves a late acquisition queued. The bug-fix playbook and
the pool-ownership eval cover these boundaries, including callback/query
acquires, retry responses, role gates and orderly drain. Budget listener
capacity per process and deployment overlap explicitly.
