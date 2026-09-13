import type { RepoPageMode, RepoPageView } from "./store";

// Keep the persisted/deep-link `design` destination for the Directory tab.
export function repoPageModeForView(view: RepoPageView): RepoPageMode {
  return view === "design" || view === "design-preferences" ? "design" : "code";
}

export const DEFAULT_REPO_MODE_VIEWS: Record<RepoPageMode, RepoPageView> = {
  code: "workspaces",
  design: "design",
};
