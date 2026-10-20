# Retire event capture before cloud shutdown notifications

- Symptom: a cloud engine's terminal shutdown triggered another uncaught event
  capture failure in late promise and timer producers, hiding the first cause.
- Cause: the router kept its closed durable journal while producers were still
  stopping. A generic authority-retirement log discarded the initiating site
  and code, so a later lease expiry looked like the initiating event.
- Rule: retire cloud capture before closing its journal. Late producers cannot
  fan out uncaptured events. Preserve the first closed failure site and code
  before cleanup; shutdown errors remain separate and never expose raw payloads.
- Encoded in real engine stop/authority-loss, router and registration tests,
  including Local Personal, organization-local, sibling cloud isolation,
  synchronous failure, timer/promise tails and accepted-response refusals.
- Diagnose the first failure independently of the last stack. A retained
  history-capture conflict can leave a writer live; do not infer retirement
  from an incomplete history marker or eventual control-plane lease expiry.
