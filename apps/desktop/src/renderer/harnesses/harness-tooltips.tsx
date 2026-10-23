// Development-only coverage of the production tooltip and inspector controls.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Columns2, GitBranch, Plus, Scan } from "lucide-react";
import { Button, Tooltip, TooltipProvider } from "../shared/ui/primitives";
import {
  InspectorIconButton,
  InspectorSection,
} from "../features/design-workspace/design-inspector-kit";
import "../features/design-workspace/design-workspace-ui.css";

function Harness() {
  const [revision, setRevision] = useState(0);
  return (
    <TooltipProvider>
      <main className="bg-bg1 text-fg1 flex min-h-screen flex-col items-start gap-8 p-10">
        <h1 className="text-sm">Tooltip interactions</h1>
        <Button onClick={() => setRevision((value) => value + 1)}>
          Replace controls
        </Button>
        <div key={revision} className="flex items-center gap-4">
          <Tooltip label="Target branch">
            <Button aria-label="Target branch" variant="ghost" size="icon">
              <GitBranch />
            </Button>
          </Tooltip>
          <Tooltip label="Split diff">
            <Button aria-label="Split diff" variant="ghost" size="icon">
              <Columns2 />
            </Button>
          </Tooltip>
        </div>
        <div className="w-64">
          <InspectorSection
            title="Fill"
            actions={
              <InspectorIconButton label="Add fill">
                <Plus />
              </InspectorIconButton>
            }
          />
          <InspectorIconButton
            label="Independent corners"
            tooltip="Independent corners"
          >
            <Scan />
          </InspectorIconButton>
        </div>
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
