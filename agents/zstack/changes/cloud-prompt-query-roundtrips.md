# Price the round trips inside a transaction

A warm durable send met its transaction budget while receipt, waiting pull,
ACK and begin still used 21/23/9/11 sequential driver calls. The HTTP/PostgreSQL
regression now measures both; a full delivery batch also has a constant bound.

Keep workspace locking and its fresh post-wait authority statement separate.
Batch dependent writes only inside that lock, preserving durable receipt,
inbox ACK and dispatch checkpoints. Held membership-loss tests cover pull,
ACK and begin without relying on a notification.

Target: principles 4, 8, 13 and 14. Enforcers: prompt-latency.integration.test.ts
and prompt-outbox.integration.test.ts. Live latency includes transport and
provider setup, so a query-count pass is not a wall-time acceptance claim.
