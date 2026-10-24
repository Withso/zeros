import {
  BRANCH_PREFIX,
  LABELS,
  PROVIDERS,
  REGENERATE_LABEL,
  REPOSITORY,
} from "./config.mjs";
import { invariant, sha, validateTask } from "./contracts.mjs";
import {
  appCommit,
  held,
  labelsOf,
  ownedProposal,
  proposalMarker,
} from "./proposals.mjs";
import {
  gitBlob,
  validateLockChange,
  validateManifestChange,
  validatePatch,
} from "./patch.mjs";
import { renderPrBody } from "./report.mjs";
import { validateReport } from "./qualification.mjs";

export async function writePreparedProposal({ prepared, ...options }) {
  const task = validateTask(options.task);
  if (!["prepared", "unchanged"].includes(prepared.status))
    return {
      taskId: task.id,
      provider: task.provider,
      status: "preparation-blocked",
    };
  if (prepared.status === "unchanged")
    invariant(
      prepared.patch?.files?.length === 0,
      "Unchanged preparation lacks an empty patch.",
    );
  validateReport(prepared.report);
  // Both paths require an App task commit. An unchanged artifact alone must
  // never establish a baseline at a human-authored head.
  const result = await writeProposal({ ...options, patch: prepared.patch });
  if (result.status === "written") result.report = prepared.report;
  return result;
}

export async function writeProposal({ github, task, patch, appSlug }) {
  validateTask(task);
  invariant(
    /^[a-z0-9-]+$/.test(appSlug ?? ""),
    "Configure the runtime updater App slug.",
  );
  const stopped = (status) => ({
    status,
    taskId: task.id,
    provider: task.provider,
  });
  async function currentPr() {
    if (task.pr === null) return null;
    const pr = await github.get(`/pulls/${task.pr}`);
    invariant(
      ownedProposal(pr, task.provider, appSlug),
      "PR ownership changed; refusing a branch write.",
    );
    return {
      ...pr,
      ...(github.mergeState ? await github.mergeState(task.pr) : {}),
    };
  }
  const pr = await currentPr();
  if (pr && (pr.state !== "open" || held(pr)))
    return stopped(pr.state !== "open" ? "closed" : "held");
  if (pr && pr.head.sha !== task.head) return stopped("stale-head");

  const tree = await github.get(`/git/trees/${task.head}?recursive=1`);
  invariant(
    tree.truncated === false && sha(tree.sha) && Array.isArray(tree.tree),
    "Base tree is incomplete.",
  );
  validatePatch(patch, task, tree.tree);
  if (task.regenerate && (!pr || !labelsOf(pr).includes(REGENERATE_LABEL)))
    return stopped("preparation-blocked");
  const root = await github.file("package.json", task.head);
  const newRoot =
    patch.files.find((file) => file.path === "package.json")?.after ?? root;
  validateManifestChange(root, newRoot, task);
  const lock = patch.files.find((file) => file.path === "pnpm-lock.yaml");
  if (lock)
    validateLockChange(
      await github.file("pnpm-lock.yaml", task.head),
      lock.after,
      task,
    );
  else {
    invariant(
      task.regenerate && task.version === task.from,
      "Version bump omitted the lockfile.",
    );
    const currentLock = await github.file("pnpm-lock.yaml", task.head);
    validateLockChange(currentLock, currentLock, task);
  }

  // An interrupted first run can leave a branch without its PR. Recover that exact
  // task's commit; never reset an existing branch to a newly rebuilt proposal.
  let existingRef = null;
  try {
    existingRef = await github.get(`/git/ref/heads/${task.branch}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  let commit;
  if (task.pr === null && existingRef) {
    const previous = await github.get(`/git/commits/${existingRef.object.sha}`);
    const signed = await github.get(`/commits/${existingRef.object.sha}`);
    invariant(
      appCommit(signed, appSlug) &&
        previous.message.includes(
          `Zeros-Runtime-Task: ${task.recoveryTaskId ?? task.id}`,
        ) &&
        previous.parents?.length === 1 &&
        previous.parents[0].sha === task.head,
      "An existing proposal branch needs manual reconciliation.",
    );
    commit = previous;
  } else {
    if (task.pr !== null && existingRef?.object?.sha !== task.head)
      return stopped("stale-head");
    const entries = [];
    for (const file of patch.files) {
      if (file.after === null)
        entries.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: null,
        });
      else {
        const blob = await github.post("/git/blobs", {
          content: file.after,
          encoding: "utf-8",
        });
        invariant(
          blob.sha === gitBlob(file.after),
          "GitHub returned an unexpected blob identity.",
        );
        entries.push({
          path: file.path,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
      }
    }
    const createdTree = entries.length
      ? await github.post("/git/trees", { base_tree: tree.sha, tree: entries })
      : { sha: tree.sha };
    invariant(sha(createdTree.sha), "Missing generated tree identity.");
    const subject = entries.length
      ? `Update ${PROVIDERS[task.provider].name} runtime to ${task.version}`
      : `Acknowledge ${PROVIDERS[task.provider].name} runtime regeneration at ${task.version}`;
    commit = await github.post("/git/commits", {
      message: `${subject}\n\nZeros-Runtime-Task: ${task.id}\nZeros-Runtime-Provider: ${task.provider}`,
      tree: createdTree.sha,
      parents: [task.head],
    });
    invariant(sha(commit.sha), "Missing generated commit identity.");
    const latest = await currentPr();
    if (latest && (latest.state !== "open" || held(latest)))
      return stopped(latest.state !== "open" ? "closed" : "held");
    if (latest && latest.head.sha !== task.head) return stopped("stale-head");
    if (
      task.regenerate &&
      (!latest || !labelsOf(latest).includes(REGENERATE_LABEL))
    )
      return stopped("preparation-blocked");
    invariant(
      task.branch.startsWith(BRANCH_PREFIX) && !task.branch.startsWith("refs/"),
      "Invalid destination ref.",
    );
    try {
      if (task.pr === null)
        await github.post("/git/refs", {
          ref: `refs/heads/${task.branch}`,
          sha: commit.sha,
        });
      else
        await github.patch(`/git/refs/heads/${task.branch}`, {
          sha: commit.sha,
          force: false,
        });
    } catch (error) {
      // A non-fast-forward rejection means someone else pushed. Their commit wins.
      if ([409, 422].includes(error.status)) return stopped("stale-head");
      throw error;
    }
  }
  let number = task.pr;
  if (number === null) {
    const existing = await github.pages(
      `/pulls?state=open&head=${encodeURIComponent(`${REPOSITORY.split("/")[0]}:${task.branch}`)}`,
    );
    invariant(existing.length <= 1, "Multiple PRs for a managed branch.");
    if (existing[0]) {
      invariant(
        ownedProposal(existing[0], task.provider, appSlug),
        "Existing PR ownership is unrecognized.",
      );
      number = existing[0].number;
    } else {
      const opened = await github.post("/pulls", {
        title: `Update ${PROVIDERS[task.provider].name} runtime to ${task.version}`,
        head: task.branch,
        base: "main",
        body: `${proposalMarker(task.provider, task.branch)}\n${renderPrBody(task.provider, task.version)}`,
      });
      number = opened.number;
    }
    await github.post(`/issues/${number}/labels`, { labels: LABELS });
  } else {
    // Preserve the human-authored title/body and all discussion after creation.
    if (task.regenerate) {
      try {
        await github.delete(
          `/issues/${number}/labels/${encodeURIComponent(REGENERATE_LABEL)}`,
        );
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
  }
  const after = await github.get(`/pulls/${number}`);
  if (after.state !== "open")
    return { ...stopped("closed-after-write"), pr: number, head: commit.sha };
  return {
    status: "written",
    taskId: task.id,
    provider: task.provider,
    pr: number,
    head: commit.sha,
  };
}
