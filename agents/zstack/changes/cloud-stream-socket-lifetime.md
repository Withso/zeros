Fence a transport wrapper before its validation side effects.

- Symptom: a retired stream's delayed ready or invalid frame stops its valid
  replacement, even though the SDK ignores events from retired connections.
- Cause: native validation can stop the client before the SDK's own connection
  guard runs. Account lifetime alone does not identify the current socket.
- Rule: retire the wrapper on local close as well as the remote close callback;
  ignore its later events before parsing, validation or connection mutations.
- Encoded in the retained ready/session regression and local/remote-close
  malformed, oversized and invalid-known-frame tests in the native stream suite.
