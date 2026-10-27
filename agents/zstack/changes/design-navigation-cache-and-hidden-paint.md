# Design navigation cache and hidden paint

- Completed frames rebuilt on workspace/page return because vector ownership
  ended with the visible canvas. Background preparation also removed the last
  confirmed surfaces. Keep bounded presentation separately from document and
  editing authority; revalidation must not erase unchanged pixels. Encoded
  URLs alone still miss the return paint: test loaded element reuse, bounded
  warm eviction and encoded-only recovery. Covered by the vector-cache and
  residency suites and `ui-smoke-design-source-surfaces.mjs`.
- Ready iframes explicitly set `visibility: visible`, overriding their hidden
  retained workspace. Inherit owner visibility and give hidden decks a paint
  backstop. Assert computed descendant visibility, not only ARIA or inertness.
- Cancelling a wheel debounce on navigation left the DOM camera different
  from the stored camera and stranded the gesture marker. Preserve the last
  painted view only for its still-current page/checkout and retire gesture
  state atomically. Covered by `ui-smoke-design-hidden-documents.mjs`.
- Hidden work must stop, while completed fallback decodes can remain within
  their existing byte budget. Test navigation, 24-hour idle expiry, deletion,
  late decode and foreground pressure separately from active job cleanup.
- A directory catalog cannot evict sibling directories: only matching-directory
  membership, checkout/capability replacement or explicit workspace removal
  authorizes eviction. The sibling-directory return case is in the vector-cache
  suite.
- A replacement's HTML readiness is not image-decode readiness. Hold a failed
  generation's preview and editor requests in the browser regression: the
  confirmed outgoing vector must stay painted until its exact-generation
  fallback has decoded. Then retire both the failed document and old display;
  an initial decode failure must still release all pending source resources.
- Native driver imports must resolve to the app's loaded Vite module URL after
  hot updates. A bare import can create a second store, falsely time out on a
  rendered destination, or invalidate an unobserved cache. Browser regressions
  in `design-native-renderer.test.ts` prove readiness and mutation use the same
  versioned state that the app renders.
- CDP also permits collection of an ordinary asynchronous read/evaluation, not
  only a mutation. Retain its promise/result in the qualified document and poll
  a bounded acknowledgement. Do not retry an unknown mutation on the misleading
  “execution context was destroyed” error. A forced-GC regression covers the
  read/evaluation path alongside the existing action tests.
