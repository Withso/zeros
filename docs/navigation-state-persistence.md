# Navigation state ownership audit

> Status: active implementation map, 2026-07-18. The normative rules live in
> `RULES.md` and `docs/ui-interaction-performance.md`.

The persistence question is not “should every `useState` survive forever?” It
is “what would a user reasonably expect after switching to a peer context and
back?” Durable navigation follows that semantic owner; unfinished modal work
remains ephemeral.

| Surface                                                               | Owner                        | Persistence / first-render source                           | Stale fallback                                                                  |
| --------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Home: Dashboard / Settings / repo page                                | app                          | `WorkspaceState.lastHomePage`                               | Dashboard if a repo target is absent                                            |
| Dashboard repository filter                                           | app                          | `zeros:dashboard-repo-filter:v1`                            | All projects when its slug is gone                                              |
| Settings primary section                                              | app                          | `settings:active-section`                                   | first valid visible section                                                     |
| Providers inner tab                                                   | app                          | `providers:active-tab`                                      | first valid provider                                                            |
| Terminal Agents inner tab                                             | app                          | `zeros:terminal-agents-active:v1`                           | first present agent; unsaved New Agent is not persisted                         |
| Selected workspace while switching repos                              | repository root              | `lastWorkspaceByRepoRoot`                                   | main only after the repo's settled workspace snapshot proves the target missing |
| Repository hub: Workspaces / Environment / Git / Actions / Paths      | project id                   | `repoPageViewByProject`                                     | Workspaces                                                                      |
| Active chat and pane layout                                           | workspace folder             | `activeChatByFolder` and chat-panes store                   | most-recent live chat / default layout                                          |
| Column 3 tab strip, open file tabs, active tab, browser history       | workspace folder             | `column3ByScope`                                            | fresh Open file + Changes + Review slice                                        |
| Changes scope and turn filter                                         | Git target/workspace id      | changes-filter store                                        | All changes / no turn                                                           |
| Changes flat/tree and selected file/viewer mode                       | workspace Changes tab        | `Column3Tab.changesView`, file intent fields, `viewerMode`  | Flat; entry-point mode for a new path                                           |
| Review Changes/Description/Commits/Checks/Reviews                     | workspace Review tab         | `Column3Tab.reviewSubtab`                                   | Changes                                                                         |
| File tab path and Diff/Preview/Edit choice                            | workspace + File tab id      | `Column3Tab.filePath` / `viewerMode`                        | new open intent chooses Diff/Preview/Edit                                       |
| Unified/split diff presentation                                       | app                          | synchronized diff-style external store + localStorage       | Unified                                                                         |
| Setup / Run / terminal session selection and sessions                 | workspace folder             | terminal store's `activeTerminalTabByFolder` / session list | Setup or first valid session per store policy                                   |
| Browser iframe DOM, recent file/diff trees, transcripts, terminal DOM | exact workspace/tab identity | bounded retained decks                                      | cold remount after eviction                                                     |
| Create pickers, confirmation dialogs, unsaved New Agent               | modal/draft instance         | component-local only                                        | reset on close/reload                                                           |

## Required change procedure

For every new route, tab, segmented control, or nested settings page:

1. Name its semantic owner before choosing a state primitive.
2. Include route, owner, and explicit nested target in one action when a click
   deep-links across surfaces.
3. Restore durable state synchronously; never repair a visible default in an
   effect.
4. Distinguish cold server state from a settled missing target. Retain exact-key
   data while refreshing.
5. Bound persisted maps/retained DOM, validate stored values, and define owner
   deletion cleanup, including descendant cwd keys and nested-owner protection.
6. Add A → B → A, reload/corruption, stale deletion, and atomic-notification
   regression coverage at the affected owner boundary.
