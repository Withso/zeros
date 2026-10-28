# Cloud GitHub authority and presentation

- **Symptom:** removing GitHub access left a protected PR discussion visible.
  **Cause:** the catalog withdrew capability without retiring mounted caches,
  and a denied response used an older lifecycle timestamp than the PR metadata.
  **Rule:** withdrawing protected fields must preserve the catalog version and
  retire every affected presentation lifetime, including an A → B → A context
  change and caches whose transport snapshot has already been evicted.
  **Encoded:** cloud-workspace-catalog tests, github-composition integration
  tests, and the cloud-github-pr browser smoke's connection-loss case.
- **Symptom:** cloud PR imports broke unrelated catalog suites.
  **Cause:** importing the HTTPS client eagerly from Git closed a catalog/Git
  initialization cycle. **Rule:** keep the shared capability/context projection
  free of state imports and load the request/refresh owner at the I/O boundary.
  **Encoded:** the full catalog suite and cloud PR transport regressions.
- **Symptom:** an existing PR on another base was adopted during creation, and
  agent-created PRs waited for an unrelated refresh to appear. **Rule:** create
  or adopt the exact repository/head/base identity and trigger discovery when
  the accepted agent creation turn settles. **Encoded:** github-api tests and
  create-pr-button settlement tests; Local prompt behavior remains covered.
- **Symptom:** a browser harness in a private integration checkout was refused
  by Vite. **Cause:** the checkout lived under the intentionally private
  `.context` directory. **Rule:** use an isolated sibling checkout for browser
  qualification; never loosen serving boundaries to expose private artifacts.
  **Encoded:** zstack-verify and existing development-serving security tests.
- **Symptom:** an open PR disappeared behind a full page of newer closed PRs
  on a reused branch. **Rule:** discovery must consume bounded pagination
  before choosing an exact repository/head/base match. **Encoded:** the
  github-api pagination regression and bounded HTTP pagination tests.
- **Symptom:** a cloud workspace could receive a former repository's MCP
  secrets after its name was reused. **Rule:** pin secret scope to verified
  repository IDs, carry those IDs through runtime resolution and OAuth release,
  and notify the original workspace across renames. Never infer historical
  scope from a current name or downgrade an existing ID. **Encoded:** real
  PostgreSQL MCP, OAuth, native admission and refresh regressions. Legacy cloud
  scopes require an authorized save before they can deliver credentials.
- **Symptom:** creation authorized the build's original repository and then
  persisted a different ID from a second name lookup. **Rule:** return the
  verified target from admission and derive the persisted workspace mapping
  from the build under the active-build lock. Keep canonical display names
  separate from original checkout/recipe paths. **Encoded:** route and real
  PostgreSQL creation regressions, plus selected-connection transfer tests.
- **Symptom:** a duplicate create could return a cached response found under
  the creation lock without rechecking the original workspace's source.
  **Rule:** reauthorize the receipt after both the early lookup and the
  serialized creation path. **Encoded:** deterministic route regressions for
  both receipt locations.
- **Symptom:** a newer clean Computer could offer a replacement repository's
  setup to an older restored disk. **Rule:** select setup by the workspace's
  original source ID; a restore's current build never replaces its ledger.
  **Encoded:** the cloud GitHub composition restore regression.
- **Symptom:** enabling cloud features hid the existing Mac MCP repository
  catalog behind an unconnected cloud method. **Rule:** preserve the Local
  default and make the cloud connection an explicit selection. **Encoded:**
  the organization MCP browser smoke now exercises both catalogs.
- **Symptom:** a cloud agent PR brief or manual compare link could follow a
  stale origin or custom fork despite server-side source identity pinning.
  **Rule:** derive the PR target from a successful current authority read and
  recheck its presentation lifetime after native Git reads. Pin both the push
  URL and CLI repository, preserving custom remotes. **Encoded:** transferred
  and fork-origin regressions, connection/branch/lifetime races, missing-target
  refusal and Local remote/unknown-access compatibility cases.

These feature regressions were caught before publication. They are retained
tests, not new claims that an escaped-bug replay has passed.
