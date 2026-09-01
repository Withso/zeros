const dataNode = document.getElementById("account-deletion-data");
const button = document.getElementById("restore-account");
const errorNode = document.getElementById("restore-account-error");

let requestId = null;
try {
  const parsed = JSON.parse(dataNode?.textContent || "{}");
  if (
    typeof parsed.requestId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      parsed.requestId,
    )
  ) {
    requestId = parsed.requestId;
  }
} catch {
  requestId = null;
}

button?.addEventListener("click", async () => {
  if (!requestId || button.disabled) return;
  button.disabled = true;
  if (errorNode) errorNode.textContent = "";
  try {
    const response = await fetch("/api/v1/account/deletion/restore", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-zeros-request": "dashboard",
      },
      body: JSON.stringify({ requestId }),
    });
    const body = await response.json().catch(() => null);
    if (response.status === 401) {
      const returnTo = `${window.location.origin}/`;
      window.location.assign(
        `/auth/start?max_age=300&return=${encodeURIComponent(returnTo)}`,
      );
      return;
    }
    if (!response.ok) {
      throw new Error(
        body?.error?.message || "The account could not be restored.",
      );
    }
    window.location.replace("/");
  } catch (error) {
    if (errorNode) {
      errorNode.textContent =
        error instanceof Error
          ? error.message
          : "The account could not be restored.";
    }
    button.disabled = false;
  }
});
