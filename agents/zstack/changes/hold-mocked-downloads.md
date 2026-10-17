# A mocked download finished before the test looked

- **Symptom.** An App fonts test failed about one run in six: the frame already
  had the font the test expected to be pending.
- **Cause.** The mocked `fetch` answered in microtasks, so the background
  download sometimes landed before the next assertion.
- **Rule.** Hold mocked network or file work behind a promise the test releases
  when it is ready for the result, as with any other condition; never rely on
  background work being slower than the test.
- **Encoded in.** `apps/desktop/src/engine/design/__tests__/style-sources.test.ts`
  ("App fonts"), alongside the existing fixed-sleep lesson.
