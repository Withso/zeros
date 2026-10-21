# Allow the engine's own periodic checkpoints before a first Delete capture

Migration 0179 let an accepted Delete that raced initial setup bind its first
live source, but required that the workspace had no checkpoints at all. The
live fixture (`baaf9349`) wrote one ordinary periodic checkpoint five minutes
after its Delete was accepted, so the repair stayed ineligible and
`final_save_blocked` persisted.

Migration 0180 replaces only that clause: durable, uninvalidated periodic
checkpoints of generation 1, under the current authority epoch and created by
this engine's lifetime, no longer refuse. Every other checkpoint reason,
checkpoint request, proof and source condition still refuses, and the Delete
still needs its own `before_delete` capture. Encoded in
`manage-cloud-initial-delete-capture.integration.test.ts` (live-shape red plus
manual/before_stop/before_delete/older-periodic controls) and
`migration-expand-exceptions-0180.test.ts`.
