import React from "react";
import { Check } from "lucide-react";
import { Button } from "../../shared/ui";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../../shared/ui/primitives/dialog";
import type { ConnectionMethod } from "./connection-methods";

export function ProviderConnectionDialog({
  provider,
  name,
  open,
  onOpenChange,
  method,
  onMethodChange,
  connected,
  busy,
  children,
}: {
  provider: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  method: ConnectionMethod;
  onMethodChange: (method: ConnectionMethod) => void;
  connected: boolean;
  busy: boolean;
  children: React.ReactNode;
}) {
  const methods = [
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
            description: "Connect your subscription using the inline terminal.",
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
        <DialogTitle>{name}</DialogTitle>
        <DialogDescription>
          Choose how to connect {name} to Zeros.
        </DialogDescription>
        <div
          className="flex min-w-0 flex-col gap-3"
          aria-label="Connection methods"
        >
          {methods.map((entry) => (
            <section
              key={entry.id}
              className="border-border1 min-w-0 overflow-hidden rounded-lg border"
            >
              <Button
                variant="ghost"
                className="h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left"
                aria-pressed={method === entry.id}
                disabled={busy}
                onClick={() => onMethodChange(entry.id)}
              >
                <span
                  aria-hidden="true"
                  className="border-fg2 flex size-4 shrink-0 items-center justify-center rounded-full border"
                >
                  {method === entry.id && (
                    <span className="bg-fg1 size-2 rounded-full" />
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
                    <p className="text-fg2 text-xs">{entry.description}</p>
                  )}
                  {children}
                </div>
              )}
            </section>
          ))}
          {provider !== "cursor" && (
            <Button
              variant="secondary"
              disabled
              className="h-auto w-full justify-start px-4 py-3"
            >
              Custom Providers <span className="text-fg2">(Coming soon)</span>
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
