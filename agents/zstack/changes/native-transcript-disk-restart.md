# Native transcript cache on restart

- Symptom: cloud chats reopened empty and filled only after remote history arrived.
- Cause: only CP projection reads reached the native disk cache. A valid native
  window was omitted when its CP capture was incomplete; startup also parked
  hydration before reading disk if the bridge was absent.
- Rule: test the real reader through disk reopen and the production hydration
  callback with revalidation held. Native observation is presentation, never CP
  completeness or write authority. Keep its original receipt through cache I/O,
  and retire it on changed source, writer, funding, owner or access.
- Encoded in `cloud-transcript-cache-native.test.ts`, including the same-head
  install race and unchanged row references after validation. Native windows
  remain bounded and scrubbed; Local owners retain their separate cache.
