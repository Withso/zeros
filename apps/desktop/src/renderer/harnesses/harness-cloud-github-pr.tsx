// Real cloud PR controls and review adapters. Only HTTPS and VM I/O are
// synthetic; the browser suite records every boundary crossing.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import type { Workspace } from "../platform/git";
import type { CloudV2Workspace } from "../platform/cloud-v2";

const userId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const ids = [
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];
const fixture = {
  workerCalls: [] as { op: string; params?: Record<string, unknown> }[],
  nativeCalls: [] as string[],
};
window.__ZEROS_NATIVE__ = {
  on: () => () => {},
  async invoke<T>(command: string): Promise<T> {
    fixture.nativeCalls.push(command);
    if (command === "auth_get_access_token")
      return { access_token: "synthetic-cloud-session" } as T;
    if (command === "auth_get_session_user")
      return {
        sub: userId,
        accountId: userId,
        email: "fixture@example.test",
        provider: "workos",
      } as T;
    if (command === "shell_open_url") return null as T;
    throw new Error(`Unexpected cloud PR native command: ${command}`);
  },
};

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { RuntimeClient } = await import("../platform/bridge/ws-client");
  const { setActiveBridge } = await import("../platform/bridge/active-bridge");
  const { cloudV2Document } = await import("../platform/cloud-v2");
  const {
    acceptCloudWorkspaceDocument,
    getCloudWorkspaceRows,
    refreshCloudWorkspace,
    subscribeCloudWorkspaces,
  } = await import("../state/cloud-workspace-catalog");
  const { clearCloudGithubPr } = await import("../platform/cloud-github-pr");
  const { PrStatusRow } = await import("../shell/pr/pr-status-row");
  const { useWorkspacePrSync, retryWorkspacePrDiscovery } =
    await import("../shell/pr/use-workspace-pr-sync");
  const { useGithubReview } =
    await import("../features/code-review/use-github-review");
  const { InlineReviewThread } =
    await import("../features/code-review/inline-review-thread");
  const { ReviewDraftStore } =
    await import("../features/code-review/review-draft-store");
  const { Button, TooltipProvider } = await import("../shared/ui/primitives");
  const { Toaster } = await import("../shared/ui/primitives/elements/toast");
  const { triggerGitRefresh } = await import("../shell/use-git-refresh-key");
  const bridge = new RuntimeClient();
  bridge.request = async function <T>(
    request: Parameters<typeof bridge.request>[0],
  ): Promise<T> {
    const op = String((request as { op?: string }).op);
    const params = (request as { params?: Record<string, unknown> }).params;
    fixture.workerCalls.push({ op, params });
    let result: unknown;
    if (op === "git.status")
      result = {
        staged: [],
        unstaged: [],
        untracked: [],
        conflicted: [],
        conflictState: null,
        branch: "feature",
        ahead: 0,
        behind: 0,
        upstream: "origin/feature",
        summary: { branch: "feature", base: { ref: "origin/main", behind: 0 } },
      };
    else if (op === "git.changeCounts")
      result = { all: 1, uncommitted: 0, staged: 0, unstaged: 0 };
    else if (op === "git.hasChanges") result = { hasChanges: true };
    else if (op === "git.log")
      result = { commits: [{ message: "Cloud change" }] };
    else if (op === "git.diff") result = { files: [], hunks: [] };
    else if (op === "workspace.prepareGithub")
      result = {
        branch: "feature",
        baseBranch: "main",
        headSha: "a".repeat(40),
      };
    else if (op === "git.repoBranchCatalog")
      result = {
        effectiveRemote: "origin",
        remotes: [
          {
            name: "origin",
            isGitHub: true,
            url: "https://github.com/example/project.git",
          },
        ],
        branches: [],
      };
    else if (op === "workspace.list")
      result = { workspaces: getCloudWorkspaceRows() };
    else if (op === "settings.read")
      result = { doc: {}, raw: "", exists: true };
    else throw new Error(`Unexpected cloud PR worker operation: ${op}`);
    return { type: "WORKSPACE_RESPONSE", op, result } as T;
  };
  setActiveBridge(bridge);
  Object.assign(window, {
    cloudPrFixture: {
      ...fixture,
      publish: (value: CloudV2Workspace) =>
        acceptCloudWorkspaceDocument(cloudV2Document(value)),
      retire: () => clearCloudGithubPr(organizationId),
      retry: (id: string) =>
        retryWorkspacePrDiscovery(`cloud://${organizationId}/${id}`),
      broadcast: (id: string) =>
        triggerGitRefresh(`cloud://${organizationId}/${id}`),
    },
  });
  await Promise.all(
    ids.map((workspaceId) =>
      refreshCloudWorkspace({ organizationId, workspaceId }),
    ),
  );

  function Review({
    workspace,
    active,
  }: {
    workspace: Workspace;
    active: boolean;
  }) {
    const review = useGithubReview({
      workspaceId: workspace.id,
      cwd: workspace.path,
      prNumber: workspace.prNumber,
      active,
    });
    const [drafts] = React.useState(() => new ReviewDraftStore());
    const source = review.source;
    return (
      <section
        aria-label="Published cloud review"
        className="flex flex-col gap-3 p-4"
      >
        <Button variant="secondary" onClick={() => void review.refresh()}>
          Refresh published review
        </Button>
        {review.error && <p role="alert">{review.error}</p>}
        {source?.threads.map((thread) => (
          <InlineReviewThread
            key={`${thread.source}:${thread.id}`}
            thread={thread}
            active={active}
            drafts={drafts}
            operations={{
              create: async () => {
                throw new Error(
                  "Use the published diff to create a line comment.",
                );
              },
              reply: source.reply!,
              setResolved: source.setResolved!,
            }}
          />
        ))}
      </section>
    );
  }
  function Surface({ id, active }: { id: string; active: boolean }) {
    const rows = React.useSyncExternalStore(
      subscribeCloudWorkspaces,
      getCloudWorkspaceRows,
      getCloudWorkspaceRows,
    );
    const workspace = rows.find(
      (row) => row.id === `cloud://${organizationId}/${id}`,
    )!;
    useWorkspacePrSync(active ? workspace : null);
    return (
      <section
        hidden={!active}
        {...(!active ? { inert: "" } : {})}
        aria-label="Cloud PR workspace"
      >
        <PrStatusRow
          workspace={workspace}
          originUrl="https://github.com/example/project.git"
          active={active}
        />
        {workspace.prNumber && (
          <Review key={workspace.id} workspace={workspace} active={active} />
        )}
      </section>
    );
  }
  function Harness() {
    const [selected, setSelected] = React.useState(0),
      [active, setActive] = React.useState(true);
    return (
      <TooltipProvider>
        <main className="bg-bg1 text-fg1 min-h-screen p-8">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div className="flex gap-2">
              {ids.map((id, index) => (
                <Button
                  key={id}
                  variant="secondary"
                  onClick={() => setSelected(index)}
                >
                  Workspace {index === 0 ? "A" : "B"}
                </Button>
              ))}
              <Button
                variant="ghost"
                onClick={() => setActive((value) => !value)}
              >
                {active ? "Hide PR" : "Show PR"}
              </Button>
            </div>
            <Surface key={selected} id={ids[selected]!} active={active} />
          </div>
          <Toaster />
        </main>
      </TooltipProvider>
    );
  }
  createRoot(document.getElementById("root")!).render(<Harness />);
}
void main();
