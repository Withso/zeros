import { DAY, LIMITS, PROVIDERS, SCHEMA } from "./config.mjs";
import {
  compareVersions,
  hash,
  invariant,
  parseJson,
  plain,
  sha,
  stableVersion,
  timestamp,
  validateObservation,
  validateTask,
} from "./contracts.mjs";
import { validateReport } from "./qualification.mjs";

export const STATE_MARKER = "<!-- zeros-agent-runtime-state:v1 -->";
export const DIGEST_MARKER = "zeros-agent-runtime-digest:v1";
export const CHECKPOINT_MARKER = "<!-- zeros-agent-runtime-checkpoint:v1 -->";

export function initialState(now) {
  invariant(timestamp(now), "Invalid state creation time.");
  return {
    schema: SCHEMA,
    createdAt: now,
    scannedAt: null,
    publishedAt: null,
    modelsEnabledAt: null,
    sequence: 0,
    sources: {},
    events: {},
    proposals: {},
    models: {},
    checkpoint: null,
  };
}

export function validateState(state, { transient = false } = {}) {
  invariant(
    plain(state) && state.schema === SCHEMA && timestamp(state.createdAt),
    "Invalid notification state.",
  );
  invariant(
    Number.isSafeInteger(state.sequence) && state.sequence >= 0,
    "Invalid state sequence.",
  );
  for (const field of ["scannedAt", "publishedAt"])
    invariant(
      state[field] === null || timestamp(state[field]),
      "Invalid state heartbeat.",
    );
  invariant(
    state.modelsEnabledAt == null || timestamp(state.modelsEnabledAt),
    "Invalid model discovery activation time.",
  );
  for (const field of ["sources", "events", "proposals", "models"])
    invariant(plain(state[field]), "Invalid state collection.");
  invariant(
    Object.keys(state.sources).length <= 100 &&
      Object.keys(state.events).length <= (transient ? 5000 : 500),
    "Notification state is oversized.",
  );
  for (const [id, source] of Object.entries(state.sources)) {
    invariant(
      /^[a-z][a-z0-9-]{0,79}$/.test(id) &&
        plain(source) &&
        timestamp(source.firstSeenAt) &&
        timestamp(source.observedAt),
      "Invalid source state.",
    );
    invariant(
      Number.isSafeInteger(source.failures) &&
        source.failures >= 0 &&
        typeof source.incident === "boolean",
      "Invalid source health.",
    );
    if (source.lastGood) validateObservation(source.lastGood);
    if (source.lastGood?.kind === "releases") {
      const digests = source.lastGood.data.releaseDigests;
      invariant(
        digests === undefined ||
          (plain(digests) &&
            Object.keys(digests).length <= 5000 &&
            Object.entries(digests).every(
              ([version, digest]) =>
                stableVersion(version) &&
                typeof digest === "string" &&
                /^[a-f0-9]{64}$/.test(digest),
            )),
        "Invalid release fingerprint inventory.",
      );
    }
  }
  for (const [id, event] of Object.entries(state.events)) {
    invariant(
      /^[a-f0-9]{64}$/.test(id) &&
        plain(event) &&
        event.id === id &&
        timestamp(event.createdAt),
      "Invalid event state.",
    );
    invariant(
      typeof event.kind === "string" &&
        typeof event.summary === "string" &&
        event.summary.length <= 2000 &&
        ["info", "warning", "critical"].includes(event.severity),
      "Invalid event content.",
    );
    invariant(
      event.notifiedAt === null || timestamp(event.notifiedAt),
      "Invalid event notification state.",
    );
  }
  for (const [provider, proposal] of Object.entries(state.proposals)) {
    invariant(
      Object.hasOwn(PROVIDERS, provider) && plain(proposal),
      "Invalid proposal provider.",
    );
    for (const field of ["pr"])
      invariant(
        proposal[field] == null ||
          (Number.isSafeInteger(proposal[field]) && proposal[field] > 0),
        "Invalid saved proposal number.",
      );
    for (const field of ["head", "lastBotCommit", "frozenHead", "mergedCommit"])
      invariant(
        proposal[field] == null || sha(proposal[field]),
        "Invalid saved proposal commit.",
      );
    for (const field of ["version", "queued", "declined"])
      invariant(
        proposal[field] == null || stableVersion(proposal[field]),
        "Invalid saved proposal version.",
      );
    invariant(
      proposal.branch == null ||
        new RegExp(`^automation/agent-runtime/${provider}/[a-f0-9]{12}$`).test(
          proposal.branch,
        ),
      "Invalid saved proposal branch.",
    );
    invariant(
      proposal.status === undefined || /^[a-z-]{1,64}$/.test(proposal.status),
      "Invalid proposal status.",
    );
    invariant(
      proposal.reviewProgress === undefined ||
        /^[1-9]\d*:(?:[a-f0-9]{40}|creation)$/.test(proposal.reviewProgress),
      "Invalid integration progress identity.",
    );
    invariant(
      proposal.reviewProgressAt === undefined ||
        timestamp(proposal.reviewProgressAt),
      "Invalid integration progress time.",
    );
    invariant(
      proposal.reviewReminderWeek == null ||
        (Number.isSafeInteger(proposal.reviewReminderWeek) &&
          proposal.reviewReminderWeek >= 0),
      "Invalid integration reminder interval.",
    );
    if (proposal.lastAttempt)
      invariant(
        plain(proposal.lastAttempt) &&
          /^[a-f0-9]{64}$/.test(proposal.lastAttempt.key) &&
          Number.isSafeInteger(proposal.lastAttempt.count) &&
          proposal.lastAttempt.count > 0 &&
          timestamp(proposal.lastAttempt.at) &&
          timestamp(proposal.lastAttempt.createdAt),
        "Invalid proposal attempt.",
      );
    if (proposal.pendingTask)
      invariant(
        validateTask(proposal.pendingTask).provider === provider,
        "Pending preparation has the wrong provider.",
      );
    if (proposal.report) validateReport(proposal.report);
  }
  for (const [provider, models] of Object.entries(state.models)) {
    invariant(
      Object.hasOwn(PROVIDERS, provider) &&
        plain(models) &&
        /^[a-f0-9]{64}$/.test(models.scopeKey) &&
        plain(models.missing) &&
        plain(models.firstMissing) &&
        plain(models.lastMissingDay ?? {}),
      "Invalid model disappearance state.",
    );
    invariant(
      Object.keys(models.missing).length <= 500,
      "Model disappearance inventory is oversized.",
    );
    for (const [id, count] of Object.entries(models.missing))
      invariant(
        id.length > 0 &&
          id.length <= 200 &&
          !/[\s\u0000-\u001f@<>]/.test(id) &&
          Number.isSafeInteger(count) &&
          count > 0 &&
          timestamp(models.firstMissing[id]),
        "Invalid model disappearance counter.",
      );
  }
  invariant(
    Buffer.byteLength(JSON.stringify(state)) <=
      (transient ? LIMITS.report : LIMITS.state),
    transient
      ? "Notification catch-up state exceeds its size limit."
      : "Notification state needs a checkpoint; refusing to discard it.",
  );
  return state;
}

export function encodeState(state) {
  validateState(state);
  return `${STATE_MARKER}\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``;
}

export function decodeState(body) {
  invariant(
    typeof body === "string" &&
      body.startsWith(`${STATE_MARKER}\n\`\`\`json\n`) &&
      body.endsWith("\n```"),
    "State comment is missing or corrupt; do not reinitialize it.",
  );
  return validateState(
    parseJson(
      body.slice(`${STATE_MARKER}\n\`\`\`json\n`.length, -4),
      LIMITS.state,
    ),
  );
}

function addEvent(
  state,
  { provider = "all", kind, subject, summary, severity = "info", url = null },
  now,
) {
  const id = hash({ provider, kind, subject });
  if (!state.events[id])
    state.events[id] = {
      id,
      provider,
      kind,
      summary: summary.slice(0, 2000),
      severity,
      url,
      createdAt: now,
      notifiedAt: null,
    };
}

function compactObservation(observation) {
  const result = structuredClone(observation);
  if (result.kind === "registry")
    result.data.versions = result.data.versions.slice(-30);
  if (result.kind === "releases") {
    // Keep comparison evidence for the whole shipping-pin window. Only the
    // report excerpts are limited to eight; dropping fingerprints replays alerts.
    result.data.releaseDigests = Object.fromEntries(
      result.data.releases.map(({ version, digest }) => [version, digest]),
    );
    result.data.releases = result.data.releases.slice(-8).map((release) => ({
      ...release,
      excerpt: release.excerpt?.slice(0, 400),
    }));
  }
  if (result.kind === "notes")
    result.data.excerpt = result.data.excerpt?.slice(0, 500);
  if (result.kind === "models")
    result.data.items = result.data.items.map((item) => ({
      id: item.id,
      digest: hash(item),
    }));
  return result;
}

function detectChanges(state, previous, current, now, bootstrap) {
  const { provider, kind, data, url } = current;
  const old = previous?.lastGood?.data;
  const event = (value) => addEvent(state, { provider, url, ...value }, now);
  if (kind === "registry") {
    if (old && compareVersions(data.latest, old.latest) < 0)
      event({
        kind: "registry-rollback",
        subject: [old.latest, data.latest],
        severity: "warning",
        summary: `${provider}: latest moved from ${old.latest} back to ${data.latest}; no automatic downgrade.`,
      });
    const newer = data.versions.filter(
      (release) =>
        compareVersions(release.version, data.pin) > 0 &&
        (!old ||
          compareVersions(release.version, old.latest) > 0 ||
          Date.parse(release.publishedAt) >
            Date.parse(previous.lastGood.observedAt)),
    );
    if (!bootstrap)
      for (const release of newer)
        event({
          kind: "release",
          subject: release.version,
          summary: `${provider}: stable release ${release.version}; shipping ${data.pin}, eligible ${data.candidate ?? "none yet"}.`,
        });
    if (data.deprecated && (!old?.deprecated || old.latest !== data.latest))
      event({
        kind: "withdrawn",
        subject: data.latest,
        severity: "critical",
        summary: `${provider}: registry marks ${data.latest} deprecated; review before adoption.`,
      });
    if (
      old &&
      hash([old.nativeVersion, old.engines, old.installable]) !==
        hash([data.nativeVersion, data.engines, data.installable])
    )
      event({
        kind: "runtime-contract",
        subject: [
          data.latest,
          data.nativeVersion,
          data.engines,
          data.installable,
        ],
        severity: "warning",
        summary: `${provider}: native pairing, Node requirement or platform availability changed for ${data.latest}.`,
      });
  }
  if (kind === "notes" && old && old.digest !== data.digest)
    event({
      kind: "upstream-notes",
      subject: [current.id, data.digest],
      summary: `${provider}: ${data.advisory ? "advisory CLI" : "SDK"} notes changed${data.watches.length ? `; review ${data.watches.join(", ")}` : ""}.`,
    });
  if (kind === "releases" && !bootstrap) {
    const previousDigests =
      old?.releaseDigests ??
      Object.fromEntries(
        (old?.releases ?? []).map(({ version, digest }) => [version, digest]),
      );
    // Schema-1 snapshots originally retained only eight releases. Their missing
    // older fingerprints cannot prove a new announcement; seed them once while
    // continuing to detect edits to known notes and genuinely newer releases.
    const legacyLatest =
      old && old.releaseDigests === undefined
        ? Object.keys(previousDigests).sort(compareVersions).at(-1)
        : null;
    for (const release of data.releases) {
      const before = previousDigests[release.version];
      if (before === release.digest) continue;
      // Initial inventory already explains old notes; subsequent missing/new notes are actionable.
      if (!old) continue;
      if (
        !before &&
        legacyLatest &&
        compareVersions(release.version, legacyLatest) <= 0
      )
        continue;
      event({
        kind: "release-notes",
        subject: [release.version, release.digest],
        summary: `${provider} ${release.version}: ${before ? "release notes changed" : "release announcement available"}${release.watches.length ? `; review ${release.watches.join(", ")}` : ""}.`,
        url: release.url,
      });
    }
  }
  if (kind === "advisory")
    for (const advisory of data.advisories) {
      if (
        old?.advisories?.some(
          (value) => value.id === advisory.id && hash(value) === hash(advisory),
        )
      )
        continue;
      event({
        kind: "security",
        subject: [current.id, advisory.id, hash(advisory)],
        severity: "critical",
        summary: `${provider}${data.role === "independent-auth-keeper" ? " auth keeper" : " runtime"}: ${advisory.id} (${advisory.severity}) affects the shipping pin. ${advisory.summary}`,
        url: advisory.url,
      });
    }
  if (kind === "models") {
    const sameScope =
      old?.scope === data.scope && old?.runtimeVersion === data.runtimeVersion;
    const previousItems = sameScope ? old.items : [];
    const oldMap = new Map(previousItems.map((item) => [item.id, item]));
    const currentMap = new Map(data.items.map((item) => [item.id, item]));
    const scopeKey = hash([provider, data.scope, data.runtimeVersion]);
    const scopedPrevious =
      state.models[provider]?.scopeKey === scopeKey
        ? state.models[provider]
        : null;
    const counters = scopedPrevious?.missing ?? {};
    const missing = {};
    const lastMissingDay = {};
    const day = now.slice(0, 10);
    // Keep absent IDs in the disappearance tracker until two complete observations agree.
    for (const id of new Set([
      ...oldMap.keys(),
      ...Object.keys(counters),
      ...(data.requiredCuratedMissing ?? []),
    ])) {
      if (!currentMap.has(id)) {
        const countToday = scopedPrevious?.lastMissingDay?.[id] !== day;
        missing[id] = Math.min(2, (counters[id] ?? 0) + (countToday ? 1 : 0));
        lastMissingDay[id] = day;
        if (missing[id] === 2 && (counters[id] ?? 0) < 2)
          event({
            kind: "model-unavailable",
            subject: [
              scopeKey,
              id,
              "absent",
              scopedPrevious?.firstMissing?.[id] ?? now,
            ],
            severity: "warning",
            summary: `${provider}: ${id} absent from two complete daily listings for the same account/runtime scope; retirement is not established.`,
          });
      }
    }
    if (sameScope)
      for (const item of data.items)
        if (
          (oldMap.get(item.id)?.digest ?? hash(oldMap.get(item.id) ?? null)) !==
          hash(item)
        )
          event({
            kind: "model-change",
            subject: [scopeKey, item.id, hash(item)],
            summary: `${provider}: ${item.id} ${oldMap.has(item.id) ? "capabilities changed" : "newly listed"} for the dedicated test account.`,
          });
    const firstMissing = Object.fromEntries(
      Object.keys(missing).map((id) => [
        id,
        scopedPrevious?.firstMissing?.[id] ?? now,
      ]),
    );
    state.models[provider] = {
      scopeKey,
      missing,
      firstMissing,
      lastMissingDay,
    };
  }
  if (kind === "delivery" && old && hash(old) !== hash(data))
    event({
      kind: "delivery",
      subject: hash(data),
      severity: data.failure ? "warning" : "info",
      summary: `${provider}: desktop/cloud delivery evidence changed; publication and qualification are reported separately.`,
    });
}

export function reduceObservations(
  input,
  observations,
  now,
  { bootstrap = false } = {},
) {
  // Catch-up events must reach publication, acknowledgment and checkpointing
  // before the stricter persisted-state limit is applied by encode/decode.
  const state = structuredClone(validateState(input, { transient: true }));
  for (const raw of observations) {
    const current = validateObservation(raw);
    const previous = state.sources[current.id];
    const source = previous ?? {
      firstSeenAt: now,
      observedAt: now,
      failures: 0,
      incident: false,
      lastGood: null,
    };
    if (current.status === "complete") {
      detectChanges(state, previous, current, now, bootstrap);
      if (source.incident)
        addEvent(
          state,
          {
            provider: current.provider,
            kind: "source-recovered",
            subject: [current.id, source.incidentSince],
            summary: `${current.id}: source recovered.`,
          },
          now,
        );
      source.lastGood = compactObservation(current);
      source.failures = 0;
      source.incident = false;
      source.incidentSince = null;
    } else {
      source.failures++;
      const maxAge = current.kind === "models" ? 2 * DAY : DAY / 2;
      if (
        !source.incident &&
        (source.failures >= 2 ||
          Date.parse(now) -
            Date.parse(source.lastGood?.observedAt ?? source.firstSeenAt) >=
            maxAge ||
          current.status === "unavailable")
      ) {
        source.incident = true;
        source.incidentSince = now;
        addEvent(
          state,
          {
            provider: current.provider,
            kind: "source-unavailable",
            subject: [
              current.id,
              source.lastGood?.observedAt ?? state.createdAt,
            ],
            severity: "warning",
            summary: `${current.id}: ${current.status === "unavailable" ? "discovery is not configured" : "repeated or stale incomplete observations"}; retaining last-good evidence.`,
          },
          now,
        );
      }
    }
    source.observedAt = now;
    source.status = current.status;
    source.kind = current.kind;
    source.reason = current.reason ?? null;
    state.sources[current.id] = source;
  }
  state.scannedAt = now;
  state.sequence++;
  return validateState(state, { transient: true });
}

export function dueEvents(state) {
  return Object.values(state.events)
    .filter((event) => event.notifiedAt === null)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
}
export function digestId(events) {
  return hash(events.map((event) => event.id).sort());
}

export function acknowledgeEvents(input, ids, now) {
  const state = structuredClone(input);
  for (const id of ids)
    if (state.events[id]) state.events[id].notifiedAt ??= now;
  return state;
}

export function reconcileDigests(input, comments) {
  let state = structuredClone(input);
  for (const comment of comments) {
    const match =
      /^<!-- zeros-agent-runtime-digest:v1 ([a-f0-9]{64}) ([a-f0-9,]+) -->/.exec(
        comment.body ?? "",
      );
    if (!match || !timestamp(comment.created_at)) continue;
    const ids = match[2].split(",");
    if (
      ids.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
      hash([...ids].sort()) !== match[1]
    )
      continue;
    state = acknowledgeEvents(state, ids, comment.created_at);
  }
  return state;
}

export function compactState(input, now) {
  const state = structuredClone(validateState(input, { transient: true }));
  const completed = Object.values(state.events)
    .filter((event) => event.notifiedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const keep = new Set(completed.slice(0, 24).map((event) => event.id));
  for (const event of completed)
    if (
      !keep.has(event.id) ||
      Date.parse(now) - Date.parse(event.notifiedAt) > 30 * DAY
    )
      delete state.events[event.id];
  // Twenty-four long summaries can still exceed the persisted budget. Retain
  // as many as fit, leaving room for the checkpoint locator and heartbeat. All
  // removed acknowledgments remain in the snapshot published before saving.
  const retained = completed.filter((event) =>
    Object.hasOwn(state.events, event.id),
  );
  for (const event of retained.reverse()) {
    if (Buffer.byteLength(JSON.stringify(state)) <= LIMITS.state - 256) break;
    delete state.events[event.id];
  }
  return {
    state: validateState(state),
    checkpoint:
      Object.keys(state.events).length !== Object.keys(input.events).length
        ? input
        : null,
  };
}

export function healthFindings(state, now, { modelsEnabled = true } = {}) {
  const findings = [];
  for (const field of ["scannedAt", "publishedAt"])
    if (!state[field] || Date.parse(now) - Date.parse(state[field]) >= DAY / 2)
      findings.push(`${field}: no successful heartbeat within 12 hours`);
  for (const [id, source] of Object.entries(state.sources)) {
    if (source.kind === "models" && !modelsEnabled) continue;
    const maxAge = source.kind === "models" ? 2 * DAY : DAY / 2;
    if (
      Date.parse(now) -
        Date.parse(source.lastGood?.observedAt ?? source.firstSeenAt) >=
      maxAge
    )
      findings.push(`${id}: stale last-good evidence`);
  }
  if (
    modelsEnabled &&
    state.modelsEnabledAt &&
    Date.parse(now) - Date.parse(state.modelsEnabledAt) >= 2 * DAY
  ) {
    for (const provider of Object.keys(PROVIDERS))
      if (!state.sources[`${provider}-models`])
        findings.push(
          `${provider}-models: enabled discovery has never completed an observation`,
        );
  }
  return findings;
}

export function addProposalEvent(
  state,
  provider,
  kind,
  subject,
  summary,
  now,
  severity = "warning",
) {
  addEvent(state, { provider, kind, subject, summary, severity }, now);
}
