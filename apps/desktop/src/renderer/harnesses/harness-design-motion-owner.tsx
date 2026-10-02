// Standalone browser fixture for timeline owner changes during pending writes.
// No engine/cache mock is involved: each reply belongs to its captured owner.
import React, { useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { DesignRuntimeNodeDetails } from "@zeros/protocol/design-runtime";
import type { DesignAuthoredKeyframes } from "@zeros/design-web";

import {
  DesignMotionTimeline,
  type DesignMotionTimelineDraft,
} from "../features/design-workspace/design-motion-timeline";
import "../features/design-workspace/design-workspace-ui.css";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { Toaster } from "../shared/ui/primitives/elements/toast";

export function mountDesignMotionOwnerHarness() {
  const saved = new Map<string, DesignMotionTimelineDraft>();
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void }
  >();
  const control = {
    select: (_owner: string) => {},
    writes: [] as Array<{ owner: string; type: "save" | "delete" }>,
    release(owner: string, success = true) {
      const write = pending.get(owner);
      if (!write) throw new Error(`No pending motion write for ${owner}`);
      pending.delete(owner);
      if (success) write.resolve();
      else write.reject(new Error("The fixture rejected the motion write."));
    },
  };
  (
    window as Window & { __zerosHarnessMotionOwner?: typeof control }
  ).__zerosHarnessMotionOwner = control;

  function Harness() {
    const [owner, setOwner] = useState("directory-a");
    const [revision, setRevision] = useState(0);
    useLayoutEffect(() => {
      control.select = setOwner;
    }, []);
    const { details, definitions } = useMemo(() => {
      const motion = saved.get(owner);
      const details: DesignRuntimeNodeDetails = {
        sourceVersion: `source-${owner}-${revision}`,
        oid: "home-heading",
        tag: "h1",
        name: "Heading",
        text: "Motion owner fixture",
        selector: '[data-oid="home-heading"]',
        visible: true,
        breadcrumb: ["home-heading"],
        rect: { x: 0, y: 0, width: 400, height: 100 },
        styles: motion
          ? {
              opacity: "1",
              animationName: motion.name,
              animationDuration: motion.duration,
              animationDelay: motion.delay,
              animationTimingFunction: motion.easing,
              animationIterationCount: motion.iterations,
              animationDirection: motion.direction,
              animationFillMode: motion.fillMode,
            }
          : { opacity: "1", animationName: "none" },
      };
      const definitions: DesignAuthoredKeyframes[] = motion
        ? [
            {
              file: motion.file,
              name: motion.name,
              keyframes: motion.keyframes,
            },
          ]
        : [];
      return { details, definitions };
    }, [owner, revision]);

    const write = async (
      type: "save" | "delete",
      draft?: DesignMotionTimelineDraft,
    ) => {
      const capturedOwner = owner;
      control.writes.push({ owner: capturedOwner, type });
      await new Promise<void>((resolve, reject) => {
        pending.set(capturedOwner, { resolve, reject });
      });
      if (draft) saved.set(capturedOwner, draft);
      else saved.delete(capturedOwner);
      setRevision((current) => current + 1);
    };
    const sessionOwnerKey = `motion-owner-workspace\0${owner}\0home.html\0home-heading`;
    return (
      <TooltipProvider>
        <main
          className="bg-bg1 relative h-screen overflow-hidden"
          data-design-motion-owner={owner}
        >
          <DesignMotionTimeline
            key={sessionOwnerKey}
            open
            ownerKey="home.html"
            sessionOwnerKey={sessionOwnerKey}
            details={details}
            definitions={definitions}
            onOpenChange={() => {}}
            onPreview={async () => {}}
            onClearPreview={async () => {}}
            onSave={(draft) => write("save", draft)}
            onDeleteMotion={() => write("delete")}
          />
        </main>
        <Toaster />
      </TooltipProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Harness />
    </React.StrictMode>,
  );
}
