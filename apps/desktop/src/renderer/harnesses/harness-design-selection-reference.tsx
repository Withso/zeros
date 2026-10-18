import { useCallback, useState } from "react";
import { ComposerDesignFrame, useComposerDesignFrame } from "../features/agent/composer-design-frame";
import type { DesignFrameAttachmentSelection } from "../features/agent/design-frame-attachment";
import { useComposerEditor } from "../features/agent/composer-editor/use-composer-editor";
import { Button } from "../shared/ui/primitives";

export function DesignSelectionReferenceFixture({ folder }: { folder: string }) {
  const [saved, setSaved] = useState<DesignFrameAttachmentSelection | null | undefined>();
  const [submitted, setSubmitted] = useState<DesignFrameAttachmentSelection | null>(null);
  const context = useComposerDesignFrame({ chatId: "selection-reference", cwd: folder, active: true, intent: "code", onPin: useCallback(() => {}, []) });
  const composer = useComposerEditor({ agentId: null, agentName: null, agentSupportsImage: false, modelId: null,
    cwd: folder, originUrl: null, availableCommands: [], placeholder: "Describe the selected design…", onSubmit: () => {} });
  return <section data-selection-reference-fixture="" className="border-border1 bg-bg2 flex w-80 shrink-0 flex-col gap-3 border-r p-3">
    <div className="text-fg1 text-sm">Canvas references</div>
    {composer.editorContent}
    {composer.suggestionPopup}
    {context.selection && <ComposerDesignFrame selection={context.selection} onRemove={context.remove} onToggleScreenshot={context.toggleScreenshot} />}
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => composer.insertTextAttachment({ sourceKey: "manual", name: "notes.txt", text: "An unrelated manual attachment." })}>Attach notes</Button>
      <Button onClick={() => setSaved(context.capture())}>Save reference draft</Button>
      <Button onClick={() => context.pin(saved)}>Restore reference draft</Button>
      <Button onClick={() => { const targets = context.capture(); setSubmitted(targets); context.consume(targets); }}>Send selection</Button>
      <Button onClick={() => { composer.clear(); context.clear(); }}>Clear composer</Button>
    </div>
    <output aria-label="Submitted canvas references" className="text-fg3 text-xxs wrap-anywhere">{JSON.stringify(submitted)}</output>
    <div data-historical-reference="" className="text-fg3 text-xs">Earlier message: design-history.md</div>
  </section>;
}
