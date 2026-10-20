# Observe enqueue before comparing owner isolation

The cloud Stop A → B → A fixture passed locally but occasionally compared A's
command with an undefined B command in the full CI shard. Advancing fake time
did not join the asynchronous WebCrypto digest that produces B's command ID.

Wait for the actual enqueue before comparing identities or changing its receipt.
Keep every owner-isolation assertion and the existing test budget. The retained
fixture also holds the real command-identity boundary across the old virtual
wait; releasing it still requires observing B's queue before continuing.

Encoded in `cloud-durable-stop.test.ts`. This is a fixture correction; command,
Stop, transport, Local and cloud behavior are unchanged.
