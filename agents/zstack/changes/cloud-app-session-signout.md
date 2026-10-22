# Keep device sign-out scoped to the app session

One device signing out closed every cloud connection for the same creator.
The relay had dropped the verified WorkOS session ID, and the migration treated
a session event as a workspace-wide access generation change.

Carry the session through the ticket and app admission, revalidate it against
durable authentication state, and detach only its clients and queued work.
An absent session ID is not authority to revoke other devices. Revalidate a
delayed admission before it can change a shared worker connection.
Notification callbacks belong to the relay's async context, not a pooled
socket's earlier provider-lock context. Keep the provider-lock guard intact.

Encoded in the cloud access integration and relay suites, the 0201 migration
ladder regression, and its exact expand-exception guard. The positive control
is another already-open session of the same creator with a turn still running;
account and membership loss retain their complete revocation tests.
