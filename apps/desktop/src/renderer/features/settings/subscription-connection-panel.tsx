import React, { useEffect, useRef, useState } from "react";
import { MoreVertical, RefreshCw } from "lucide-react";
import {
  RadioGroup,
  RadioGroupItem,
} from "../../shared/ui/primitives/radio-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives/dropdown-menu";
import type { BrowserSubscriptionProvider } from "@zeros/protocol/provider-auth";
import { Button, Input } from "../../shared/ui";
import { useNativeRuntime } from "../../platform/runtime";
import { useCachedRead } from "../../state/use-cached-read";
import {
  cancelSubscription,
  changeSubscriptionAccount,
  connectSubscription,
  readSubscription,
  submitSubscriptionCode,
  subscriptionCache,
} from "./subscription-connection";

export const SUBSCRIPTION_NAMES = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
} as const;
const unchanged = async () => {};

export function SubscriptionConnectionPanel({
  provider,
  surfaceActive,
  onChanged = unchanged,
}: {
  provider: BrowserSubscriptionProvider;
  surfaceActive: boolean;
  onChanged?: () => Promise<unknown>;
}) {
  const native = useNativeRuntime().ready;
  const read = useCachedRead(subscriptionCache, provider, readSubscription, {
    enabled: native && surfaceActive,
    maxAgeMs: 15_000,
  });
  const status = read.data;
  const name = SUBSCRIPTION_NAMES[provider];
  const codeId = React.useId();
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [changingAccount, setChangingAccount] = useState(false);
  const [accountMenu, setAccountMenu] = useState<string | null>(null);
  const changeAccount = async (id: string, remove = false) => {
    if (changingAccount) return;
    setChangingAccount(true);
    setError(undefined);
    try {
      await changeSubscriptionAccount({
        provider,
        action: remove ? "remove-account" : "select-account",
        accountId: id,
      });
      await onChanged();
    } catch {
      setError("Could not change the account. Refresh and try again.");
    } finally {
      setChangingAccount(false);
    }
  };
  const notified = useRef<string>();
  useEffect(() => {
    if (!native || !surfaceActive) return;
    const refresh = () => subscriptionCache.invalidate(provider);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [native, provider, surfaceActive]);
  useEffect(() => {
    if (
      !surfaceActive ||
      !status?.attemptId ||
      status.state === "connecting" ||
      notified.current === status.attemptId
    )
      return;
    notified.current = status.attemptId;
    void onChanged().catch(() => {});
  }, [onChanged, status, surfaceActive]);
  useEffect(() => {
    setAccountMenu(null);
    setCode("");
    setShowCode(false);
    setError(undefined);
  }, [provider, status?.attemptId, status?.canSubmitCode, surfaceActive]);
  const act = async (action: "connect" | "cancel") => {
    setError(undefined);
    try {
      if (action === "connect") await connectSubscription(provider);
      else if (action === "cancel") await cancelSubscription(provider);
    } catch {
      setError("Could not update the connection. Refresh and try again.");
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!status?.attemptId || submitting || !code.trim()) return;
    const value = code.trim();
    setCode("");
    setSubmitting(true);
    setError(undefined);
    try {
      await submitSubscriptionCode(status.attemptId, value);
    } catch {
      setError(
        "The sign-in code could not be submitted. Refresh the connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section
      className="flex flex-col gap-3"
      aria-label={`${name} subscription connection`}
    >
      <p className="text-fg1 text-sm" role="status">
        {status?.state === "connected"
          ? `Connected${status.email ? ` as ${status.email}` : ` to ${name}`}${status.plan ? ` · ${status.plan}` : ""}`
          : status?.state === "connecting"
            ? provider === "claude" && status.canSubmitCode
              ? "If the browser gives you a sign-in code, paste it here. Sign-in expires after 5 minutes."
              : "Complete sign-in in your browser. Sign-in expires after 5 minutes."
            : status?.state === "expired"
              ? `Your ${name} connection expired. Sign in again.`
              : `Sign in through ${provider === "codex" ? "ChatGPT" : name} to use your subscription`}
      </p>
      {!!status?.accounts?.length && (
        <RadioGroup
          aria-label={`${name} accounts`}
          value={status.activeAccountId ?? ""}
          disabled={
            !surfaceActive || changingAccount || status.state === "connecting"
          }
          onValueChange={(id) => void changeAccount(id)}
          className="ml-6 gap-1"
        >
          {status.accounts.map((account, index) => {
            const label = account.email ?? `Account ${index + 1}`;
            const disabled =
              !surfaceActive ||
              changingAccount ||
              status.state === "connecting";
            return (
              <div
                key={account.id}
                className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1"
              >
                <RadioGroupItem
                  value={account.id}
                  className="[&>span:last-child]:min-w-0 [&>span:last-child]:truncate"
                  label={`${label}${account.plan ? ` · ${account.plan}` : ""}${account.state !== "connected" ? " · Sign in required" : ""}`}
                />
                <DropdownMenu
                  open={surfaceActive && accountMenu === account.id}
                  onOpenChange={(open) =>
                    setAccountMenu(open ? account.id : null)
                  }
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      aria-label={`Account options for ${label}`}
                    >
                      <MoreVertical className="size-4" aria-hidden="true" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-red-primary focus:text-red-primary"
                      disabled={disabled}
                      onSelect={() => void changeAccount(account.id, true)}
                    >
                      Disconnect
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            );
          })}
        </RadioGroup>
      )}
      {(error || status?.error || read.error) && (
        <p className="text-fg2 text-xs" role="alert">
          {error ??
            status?.error ??
            "Could not check the connection. Try refreshing."}
        </p>
      )}
      {!native && (
        <p className="text-fg2 text-xs">
          Open the Zeros desktop app to connect this device.
        </p>
      )}
      {provider === "claude" &&
        status?.state === "connecting" &&
        status.canSubmitCode &&
        !showCode && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setShowCode(true)}
          >
            Use a sign-in code
          </Button>
        )}
      {provider === "claude" &&
        showCode &&
        status?.state === "connecting" &&
        status.canSubmitCode && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => void submit(event)}
          >
            <div className="flex items-center gap-2">
              <Input
                id={codeId}
                aria-label="Claude sign-in code"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={4096}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
              <Button
                size="sm"
                type="submit"
                disabled={submitting || !code.trim()}
              >
                Submit code
              </Button>
            </div>
          </form>
        )}
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={
            !native || !surfaceActive || read.loading || changingAccount
          }
          onClick={() =>
            void act(status?.state === "connecting" ? "cancel" : "connect")
          }
        >
          {status?.state === "connecting"
            ? "Cancel sign-in"
            : status?.accounts?.length || status?.state === "connected"
              ? "Add account"
              : "Connect via subscription"}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!native || !surfaceActive || read.refreshing}
          onClick={read.refresh}
          aria-label={`Refresh ${name} subscription`}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
