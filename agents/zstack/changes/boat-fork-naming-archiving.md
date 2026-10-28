# Qualify a provider call live before trusting its fixture

The checkpoint retry's unit tests assumed Boat applies the `name` requested
for a fork and that a stopped VM can be forked at once. A live run on Alpha
showed both were wrong: Boat names every fork "<source name> fork", and its
stop returns while the VM is still `archiving` (about ten seconds), refusing a
fork with `409 fork_failed` until it is `archived`. Name-based recovery and the
Dev drain would never have found a fork. The retry now inspects the source,
forks only an archived VM, requests and records Boat's own fork name, and
treats `fork_failed` as nothing created. Encoded in `boat.test.ts`,
`lifecycle.test.ts` and docs/cloud-workspaces.md; the review checklist already
asks for one real response per provider-shaped fixture.
