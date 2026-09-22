// Development-only fixture for the shared dialog chrome.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../shared/ui";
import { QuickStartDialog } from "../shell/dialogs/quick-start";
import { ChatCloseDialog } from "../shell/conversation/chat-close-dialog";
import { ShortcutsPalette } from "../shell/shortcuts-palette";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandItem,
} from "../shared/ui/primitives/command";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";

function Harness() {
  const [example, setExample] = useState<string | null>(null);
  return (
    <>
      <Button onClick={() => setExample("quick")}>Open quick start</Button>
      <Button onClick={() => setExample("confirm")}>Open confirmation</Button>
      <Button onClick={() => setExample("command")}>Open command picker</Button>
      <Button onClick={() => setExample("shortcuts")}>Open shortcuts</Button>
      <QuickStartDialog
        open={example === "quick"}
        onOpenChange={(open) => {
          if (!open) setExample(null);
        }}
      />
      {example === "confirm" && (
        <ChatCloseDialog
          copy={{
            title: "Close active chat?",
            description: "The agent is still working.",
          }}
          onCancel={() => setExample(null)}
          onConfirm={() => setExample(null)}
        />
      )}
      <CommandDialog
        title="Choose a folder"
        open={example === "command"}
        onOpenChange={(open) => {
          if (!open) setExample(null);
        }}
      >
        <CommandInput placeholder="Search folders" />
        <CommandList>
          <CommandItem>Example folder</CommandItem>
        </CommandList>
      </CommandDialog>
      <ShortcutsPalette
        open={example === "shortcuts"}
        onOpenChange={(open) => {
          if (!open) setExample(null);
        }}
      />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <Harness />
  </TooltipProvider>,
);
