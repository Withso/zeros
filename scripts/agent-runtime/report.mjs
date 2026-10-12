import { LIMITS, PROVIDERS, REPOSITORY } from "./config.mjs";
import { invariant, markdown, sha } from "./contracts.mjs";
import { DIGEST_MARKER, digestId } from "./state.mjs";

export const TRACKING_MARKER = "<!-- zeros-agent-runtime-tracking:v1 -->";
export const BODY_START = "<!-- zeros-agent-runtime-dashboard:start -->";
export const BODY_END = "<!-- zeros-agent-runtime-dashboard:end -->";
export const PR_MARKER = "<!-- zeros-agent-runtime-report:v1 -->";

export function safeLink(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      ![
        "github.com",
        "api.github.com",
        "registry.npmjs.org",
        "cursor.com",
        "developers.openai.com",
        "raw.githubusercontent.com",
        "learn.chatgpt.com",
      ].includes(url.hostname)
    )
      return null;
    return url.href.replace(/[()< >]/g, (c) => encodeURIComponent(c));
  } catch {
    return null;
  }
}

export function renderDigest(events) {
  invariant(
    events.length > 0 && events.length <= 100,
    "Invalid digest batch size.",
  );
  const marker = `<!-- ${DIGEST_MARKER} ${digestId(events)} ${events
    .map((event) => event.id)
    .sort()
    .join(",")} -->`;
  const lines = events.map(
    (event) =>
      `- **${markdown(event.provider)} · ${markdown(event.severity)}:** ${markdown(event.summary, 1800)}${safeLink(event.url) ? ` [Source](${safeLink(event.url)})` : ""}`,
  );
  const text = `${marker}\nUpstream agent runtime updates\n\n${lines.join("\n")}\n\nReview the tracking issue and linked PR reports. Runtime and capability adoption still require maintainer review.`;
  invariant(
    Buffer.byteLength(text) <= LIMITS.comment,
    "Digest exceeds the comment limit.",
  );
  return text;
}

export function renderDashboard(state, stateComment) {
  const rows = Object.entries(PROVIDERS).map(([provider, config]) => {
    const source = state.sources[`${provider}-registry`];
    const data = source?.lastGood?.data;
    const proposal = state.proposals[provider];
    return `| ${config.name} | ${markdown(data?.pin ?? "unknown")} | ${markdown(data?.latest ?? "unknown")} | ${markdown(data?.candidate ?? "none eligible")} | ${proposal?.pr ? `[#${proposal.pr}](https://github.com/${REPOSITORY}/pull/${proposal.pr})` : "none"} | ${markdown(proposal?.status ?? source?.status ?? "not observed")} |`;
  });
  const health = Object.entries(state.sources).map(
    ([id, source]) =>
      `- ${markdown(id)}: ${markdown(source.status)}; last complete ${markdown(source.lastGood?.observedAt ?? "never")}${source.incident ? "; **needs attention**" : ""}.`,
  );
  const delivery = Object.entries(PROVIDERS).flatMap(([provider, config]) => {
    const evidence = state.sources[`${provider}-delivery`]?.lastGood?.data;
    return [
      ...["alpha", "beta", "production"].map((channel) => {
        const item = evidence?.desktop?.[channel];
        return `| ${config.name} | Desktop ${channel} | ${markdown(item?.pin ?? "unknown")} | ${markdown(item?.status ?? "unknown")} | ${channel === "alpha" ? "after release gates" : "maintainer promotion"} |`;
      }),
      `| ${config.name} | Cloud alpha | ${markdown(evidence?.cloud?.pin ?? "unknown")} | ${markdown(evidence?.cloud?.status ?? "unknown")}${evidence?.cloud?.freshness ? "; latest unknown" : ""} | qualification ${markdown(evidence?.cloud?.qualification ?? "unknown")} |`,
    ];
  });
  return `${TRACKING_MARKER}\n<!-- zeros-agent-runtime-state-comment:${stateComment} -->\n${BODY_START}\nThis issue tracks upstream SDK/CLI releases, models, capabilities, upgrade PRs and delivery. Subscribe to receive new digest comments.\n\n| Provider | Main pin | Upstream latest | Eligible candidate | Working PR | Status |\n| --- | --- | --- | --- | --- | --- |\n${rows.join("\n")}\n\nLast scan: ${markdown(state.scannedAt ?? "not yet")}. Last publication: ${markdown(state.publishedAt ?? "not yet")}.\n\nSource health\n\n${health.join("\n")}\n\nDelivery evidence (a main merge is not a published release)\n\n| Provider | Destination | Published pin | Evidence | Policy / qualification |\n| --- | --- | --- | --- | --- |\n${delivery.join("\n")}\n\nWork on each automatic PR's existing branch. New eligible releases append commits there. Apply **agent-runtime:hold** for final review; check the report for the acknowledged head. Conflicts stay on that PR. New model/capability announcements do not automatically enable features or change defaults.\n\nLocal workspace impact: reviewed desktop releases carry bundled runtimes for both Local and organization-local workspaces.\n\nCloud workspace impact: bundle publication/qualification is observed separately. This monitor never wakes, restarts or changes a workspace.\n${BODY_END}`;
}

export function updateOwnedDashboard(body, replacement) {
  const start = body.indexOf(BODY_START);
  const end = body.indexOf(BODY_END);
  invariant(
    start >= 0 &&
      end > start &&
      body.indexOf(BODY_START, start + 1) < 0 &&
      body.indexOf(BODY_END, end + 1) < 0,
    "Dashboard ownership markers are missing or ambiguous.",
  );
  const freshStart = replacement.indexOf(BODY_START);
  const freshEnd = replacement.indexOf(BODY_END) + BODY_END.length;
  return (
    body.slice(0, start) +
    replacement.slice(freshStart, freshEnd) +
    body.slice(end + BODY_END.length)
  );
}

export function renderPrBody(provider, version) {
  return `Automated runtime maintenance for ${PROVIDERS[provider].name} ${version}.\n\nImplement integration changes directly on this PR's branch. New eligible upstream versions update this same PR while preserving your commits. See the maintained runtime report for required work and check results.\n\nApply \`agent-runtime:hold\` for final review; wait for the report to acknowledge the current head. This updater never merges.\n\n### Local workspace impact\n\nUpdates the bundled runtime used by Local and organization-local workspaces through the normal desktop release process. Global CLI overrides and credentials are unchanged.\n\n### Cloud workspace impact\n\nUpdates future qualified cloud runtime bundles through the existing release process. Running allocations retain their pins; this PR does not wake or restart workspaces.\n`;
}

export function renderPrReport(
  report,
  {
    held = false,
    status = null,
    updatesEnabled = true,
    frozenHead = null,
    queued = null,
    signals = [],
    trackingIssue = null,
  } = {},
) {
  invariant(sha(report.head), "PR report needs an exact source head.");
  const rows = (report.gates ?? []).map(
    (gate) =>
      `| ${markdown(gate.name)} | ${markdown(gate.status)} | ${gate.exitCode === null ? "—" : Number(gate.exitCode)} |`,
  );
  const changes = (report.changes ?? [])
    .slice(0, 80)
    .map(
      (change) =>
        `- ${markdown(change.kind)}: ${markdown(change.subject, 400)}${change.disposition ? ` — ${markdown(change.disposition)}` : " — review required"}`,
    );
  const controls = held
    ? `Updates held. ${frozenHead === report.head ? `Frozen at \`${report.head}\`.` : "Freeze acknowledgement/checks pending for this head."}`
    : updatesEnabled
      ? "Automatic updates are enabled, subject to source, preparation and review controls below."
      : "Notifications are enabled; automatic branch updates are disabled.";
  const blocker = [
    "preparation-blocked",
    "preparation-incomplete",
    "baseline-unavailable",
    "reconciliation-blocked",
    "legacy-proposal-open",
    "source-incomplete",
    "platform-evidence-incomplete",
  ].includes(status)
    ? `\n\n**Automatic update needs attention: ${markdown(status)}.** Review the linked radar run and resolve on this same branch. For intentional edits to managed files, apply agent-runtime:regenerate only after reviewing the intended regeneration. No existing commit was replaced.`
    : "";
  const pin =
    report.provider && report.version
      ? `Working ${markdown(report.provider)} pin: **${markdown(report.version)}**.\n\n`
      : "";
  const surface = changes.length
    ? `Surface review\n\n${changes.join("\n")}`
    : report.testedHead &&
        report.gates?.some(
          (gate) =>
            gate.name === "agent-runtime:surfaces" && gate.status === "passed",
        )
      ? "No structural changes require a new disposition at this tested commit."
      : "No qualified structural review report is available yet; missing evidence is not a pass.";
  const upstream = signals.length
    ? `\n\nRecent upstream signals (notification does not imply adoption)\n\n${signals
        .slice(0, 8)
        .map(
          (event) =>
            `- ${markdown(event.summary, 900)}${safeLink(event.url) ? ` [Source](${safeLink(event.url)})` : ""}`,
        )
        .join("\n")}`
    : "";
  const tracking =
    Number.isSafeInteger(trackingIssue) && trackingIssue > 0
      ? `\n\n[Tracking issue and source/delivery health](https://github.com/${REPOSITORY}/issues/${trackingIssue}).`
      : "";
  const text = `${PR_MARKER}\n<!-- zeros-agent-runtime-report-head:${report.head} -->\n**Agent runtime report**\n\n${pin}Source head: \`${report.head}\`. Tested head: ${sha(report.testedHead) ? `\`${report.testedHead}\`` : "not qualified yet"}.\n\n${controls}${queued ? ` Queued candidate: ${markdown(queued)}.` : ""}\n\n${report.summary ? markdown(report.summary, 1800) : "Mechanical changes are prepared. Required integration decisions remain with the maintainer."}\n\n| Gate | Result | Exit code |\n| --- | --- | --- |\n${rows.join("\n")}\n\n${surface}\n\nLocal workspace impact: review Local and organization-local engine/desktop behavior.\n\nCloud workspace impact: review Linux bundles and cloud adapter behavior independently; publication is not qualification or adoption.\n\n${safeLink(report.runUrl) ? `[Full workflow evidence](${safeLink(report.runUrl)})` : "Workflow evidence unavailable."}\n`;
  invariant(
    Buffer.byteLength(text + blocker + upstream + tracking) <= LIMITS.comment,
    "PR report exceeds its bound.",
  );
  return text + blocker + upstream + tracking;
}
