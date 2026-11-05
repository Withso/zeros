import React from "react";
import { Check } from "lucide-react";
import { Button } from "../../shared/ui";
import { cn } from "../../shared/ui/cn";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../../shared/ui/primitives/dialog";
import { connectedAccountLabel, type ConnectionMethod } from "./connection-methods";

export function ProviderConnectionDialog({
  provider,
  name,
  open,
  onOpenChange,
  method,
  onMethodChange,
  connected,
  connectedIdentity,
  busy,
  children,
  methodOptions,
}: {
  provider: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  method: ConnectionMethod;
  onMethodChange: (method: ConnectionMethod) => void;
  connected: boolean;
  connectedIdentity?: string;
  busy: boolean;
  children: React.ReactNode;
  methodOptions?: Array<{ id: ConnectionMethod; label: string; description: string }>;
}) {
  const methods = methodOptions ?? [
    {
      id: "account" as const,
      label: "Account",
      description: "Connect your subscription in your browser.",
    },
    ...(provider === "cursor"
      ? []
      : [
          {
            id: "cli" as const,
            label: "CLI",
            description: "Sign in from the terminal below.",
          },
        ]),
    {
      id: "apiKey" as const,
      label: "API",
      description: "Connect with an API key.",
    },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-[calc(100vw-2rem)] min-w-0 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>
            Choose how to connect {name} to Zeros.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div
            className="flex min-w-0 flex-col gap-3"
            aria-label="Connection methods"
          >
            {methods.map((entry) => (
              <section
                key={entry.id}
                className="border-border1 min-w-0 overflow-hidden rounded-[calc(var(--radius-lg)*1.5)] border"
              >
                <Button
                  variant="ghost"
                  className="hover:bg-bg1-hover aria-pressed:bg-transparent aria-pressed:border-transparent h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left"
                  aria-pressed={method === entry.id}
                  disabled={busy}
                  onClick={() => onMethodChange(entry.id)}
                >
                  {/* The RadioGroup look: border4, then inverted-bg around a
                      6px inverted-fg dot when chosen. */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded-full border",
                      method === entry.id
                        ? "border-inverted-bg bg-inverted-bg"
                        : "border-border4",
                    )}
                  >
                    {method === entry.id && (
                      <span className="bg-inverted-fg size-1.5 rounded-full" />
                    )}
                  </span>
                  <span className="flex-1">{entry.label}</span>
                  {method === entry.id && connected && (
                    <Check
                      className="text-green-fg size-4"
                      aria-label="Connected"
                    />
                  )}
                </Button>
                {method === entry.id && (
                  <div className="border-border1 flex min-w-0 flex-col gap-3 border-t p-4">
                    {entry.id !== "account" && (
                      connected ? (
                        <p className="text-fg1 min-w-0 break-words text-sm" role="status">
                          {connectedAccountLabel(method, connectedIdentity)}
                        </p>
                      ) : <p className="text-fg2 text-xs">{entry.description}</p>
                    )}
                    {children}
                  </div>
                )}
              </section>
            ))}
          </div>
        </DialogBody>
        {provider !== "cursor" && (
          <DialogFooter>
            <Button
              variant="secondary"
              disabled
              className="h-auto w-full justify-start px-4 py-3"
            >
              Custom Providers <span className="text-fg2">(Coming soon)</span>
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
