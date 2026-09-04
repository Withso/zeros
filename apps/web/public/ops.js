const root = document.querySelector("main.layout");
const role = root?.dataset.role || "";
const lookupForm = document.getElementById("lookup-form");
const requestPanel = document.getElementById("request-panel");
const lookupError = document.getElementById("lookup-error");
const actionResult = document.getElementById("action-result");
const ownerGrant = document.getElementById("owner-grant");
const grantForm = document.getElementById("grant-form");
const grantResult = document.getElementById("grant-result");
const restoreButton = document.getElementById("restore-button");
const purgeButton = document.getElementById("purge-button");
const purgeConfirmation = document.getElementById("purge-confirmation");
const purgeInput = document.getElementById("purge-input");
const purgePhrase = document.getElementById("purge-phrase");
const purgeConfirmButton = document.getElementById("purge-confirm-button");
let current = null;

function value(form, name) {
  return new FormData(form).get(name)?.toString().trim() || "";
}

async function api(path, body) {
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-zeros-request": "dashboard",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (response.status === 401) {
    window.location.assign(
      `/auth/start?max_age=300&return=${encodeURIComponent(`${window.location.origin}/`)}`,
    );
    throw new Error("Reauthentication required");
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || "The operation could not be completed.");
  }
  return payload;
}

function details(entries) {
  const list = document.getElementById("request-details");
  list.replaceChildren();
  for (const [label, value] of entries) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value ?? "Unavailable";
    list.append(term, description);
  }
}

function resetPurgeConfirmation() {
  purgeConfirmation.hidden = true;
  purgeInput.value = "";
  purgePhrase.textContent = "";
  purgeConfirmButton.disabled = false;
}

function completeRequestAction(message) {
  current = null;
  actionResult.textContent = message;
  restoreButton.disabled = true;
  purgeButton.disabled = true;
  resetPurgeConfirmation();
  purgeConfirmButton.disabled = true;
  ownerGrant.hidden = true;
}

async function loadDevelopers() {
  if (role !== "platform_owner") return;
  const response = await fetch("/api/v1/ops/session", { headers: { accept: "application/json" } });
  if (!response.ok) return;
  const session = await response.json();
  const select = grantForm?.elements.granteeUserId;
  if (!(select instanceof HTMLSelectElement)) return;
  select.replaceChildren();
  for (const developer of session.developers || []) {
    const option = document.createElement("option");
    option.value = developer.id;
    option.textContent = `${developer.displayName || developer.email} (${developer.email})`;
    select.append(option);
  }
  if (!select.options.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No active developers";
    select.append(option);
  }
}

lookupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  lookupError.textContent = "";
  actionResult.textContent = "";
  const code = value(lookupForm, "code").toUpperCase();
  const supportCaseReference = value(lookupForm, "supportCaseReference");
  try {
    const payload = await api(`/v1/ops/deletions/${encodeURIComponent(code)}/lookup`, {
      supportCaseReference,
      ownershipVerification: "confirmed_out_of_band",
    });
    current = { code, supportCaseReference, payload };
    document.getElementById("request-title").textContent =
      payload.target.kind === "account" ? "Account deletion" : "Organization deletion";
    document.getElementById("request-summary").textContent =
      payload.target.kind === "account"
        ? payload.target.maskedEmail || "Purged account"
        : payload.target.name || "Purged organization";
    document.getElementById("request-state").textContent = payload.deletion.state;
    details([
      ["Recovery code", payload.deletion.recoveryCode],
      ["Requested", new Date(payload.deletion.requestedAt).toLocaleString()],
      ["Scheduled purge", new Date(payload.deletion.purgeAfter).toLocaleString()],
      ["Target", payload.target.kind],
      ["Members", payload.target.memberCount === undefined ? "—" : String(payload.target.memberCount)],
      ["Two-person recovery", payload.target.businessOrganization ? "Required" : "Not required"],
    ]);
    resetPurgeConfirmation();
    grantResult.textContent = "";
    ownerGrant.hidden = role !== "platform_owner";
    restoreButton.disabled = payload.deletion.state !== "scheduled";
    purgeButton.disabled = payload.deletion.state !== "scheduled" || role !== "developer";
    requestPanel.hidden = false;
  } catch (error) {
    current = null;
    requestPanel.hidden = true;
    lookupError.textContent = error instanceof Error ? error.message : "Lookup failed";
  }
});

grantForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!current) return;
  grantResult.textContent = "";
  try {
    const payload = await api(`/v1/ops/deletions/${encodeURIComponent(current.code)}/grants`, {
      supportCaseReference: current.supportCaseReference,
      ownershipVerification: "confirmed_out_of_band",
      granteeUserId: value(grantForm, "granteeUserId"),
      capability: value(grantForm, "capability"),
      expiresInMinutes: Number(value(grantForm, "expiresInMinutes")),
    });
    grantResult.textContent = `Approval ${payload.grant.id} expires ${new Date(payload.grant.expiresAt).toLocaleString()}.`;
  } catch (error) {
    grantResult.textContent = error instanceof Error ? error.message : "Approval failed";
  }
});

restoreButton?.addEventListener("click", async () => {
  if (!current) return;
  actionResult.textContent = "";
  try {
    await api(`/v1/ops/deletions/${encodeURIComponent(current.code)}/restore`, {
      supportCaseReference: current.supportCaseReference,
      ownershipVerification: "confirmed_out_of_band",
    });
    completeRequestAction(
      "Restored. All previous sessions and endpoint grants remain revoked.",
    );
  } catch (error) {
    actionResult.textContent = error instanceof Error ? error.message : "Restore failed";
  }
});

purgeButton?.addEventListener("click", () => {
  if (!current) return;
  const phrase = `FORCE PURGE ${current.code}`;
  purgePhrase.textContent = phrase;
  purgeConfirmation.hidden = false;
  purgeInput.focus();
});

purgeConfirmButton?.addEventListener("click", async () => {
  if (!current) return;
  const confirmation = purgeInput.value;
  const expected = `FORCE PURGE ${current.code}`;
  if (confirmation !== expected) {
    actionResult.textContent = "Enter the exact force-purge phrase.";
    return;
  }
  try {
    await api(`/v1/ops/deletions/${encodeURIComponent(current.code)}/force-purge`, {
      supportCaseReference: current.supportCaseReference,
      ownershipVerification: "confirmed_out_of_band",
      confirmation,
    });
    completeRequestAction("Purge queued through the verified WorkOS deletion worker.");
  } catch (error) {
    actionResult.textContent = error instanceof Error ? error.message : "Purge failed";
  }
});

document.getElementById("identity-recovery-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const output = document.getElementById("identity-result");
  try {
    const code = value(form, "code").toUpperCase();
    await api(`/v1/internal/account-recoveries/${encodeURIComponent(code)}/approve`, {
      supportCaseReference: value(form, "supportCaseReference"),
      ownershipVerification: "confirmed_out_of_band",
    });
    output.textContent = "Identity recovery approved and consumed.";
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : "Recovery failed";
  }
});

void loadDevelopers();
