import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import "../features/design-workspace/design-workspace-ui.css";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../shared/ui/primitives/button";
import { Input } from "../shared/ui/primitives/input";
import { Checkbox } from "../shared/ui/primitives/checkbox";
import { Switch } from "../shared/ui/primitives/switch";
import { RadioGroup, RadioGroupItem } from "../shared/ui/primitives/radio-group";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../shared/ui/primitives/tabs";
import { Tooltip, TooltipProvider } from "../shared/ui/primitives/tooltip";
import { Popover, PopoverTrigger, PopoverContent } from "../shared/ui/primitives/popover";
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from "../shared/ui/primitives/dialog";
import { Sheet, SheetTrigger, SheetContent, SheetTitle, SheetDescription } from "../shared/ui/primitives/sheet";
import { Badge } from "../shared/ui/primitives/badge";
import { ShortcutsPalette } from "../shell/shortcuts-palette";
import { ReviewTimelineSection } from "../shell/workbench/tabs/review-timeline";

// Real controls and portals under the desktop cascade. Owner changes remount
// the surface, with a retained inert sibling, without requiring a live engine.
function Surface({ owner }: { owner: string }) {
  const [checked, setChecked] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const action = useRef<HTMLButtonElement>(null);
  const rejectComment = useRef<((error: Error) => void) | null>(null);
  return (
    <section aria-label={`${owner} controls`} className="flex flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Button>Before controls</Button>
        <Button ref={action} data-testid="action">Action</Button>
        <button type="button" data-testid="native">Native action</button>
        <a href="#" onClick={(event) => event.preventDefault()} data-testid="link">Link</a>
        <div role="button" tabIndex={0} data-testid="fallback">Custom control</div>
        <Badge tabIndex={0} data-testid="badge">Focusable badge</Badge>
        <button type="button" className="zd-panel-tab" data-testid="design">Design tab</button>
      </div>
      <div className="group/focus-parent flex gap-3">
        <Button data-testid="descendant">Nested action</Button>
        <span data-testid="descendant-hint" className="opacity-0 group-has-focus-visible/focus-parent:opacity-100">Nested help</span>
      </div>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2" data-testid="checkbox">
          <Checkbox checked={checked} onChange={() => setChecked(!checked)} />
          Checkbox
        </label>
        <Switch aria-label="Switch" data-testid="switch" />
        <RadioGroup defaultValue="a" aria-label="Choices" className="flex-row">
          <RadioGroupItem value="a" label="Choice A" />
          <RadioGroupItem value="b" label="Choice B" />
        </RadioGroup>
      </div>
      <Tabs defaultValue="a">
        <TabsList aria-label="Focus tabs">
          <TabsTrigger value="a">Tab A</TabsTrigger>
          <TabsTrigger value="b">Tab B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel A</TabsContent>
        <TabsContent value="b">Panel B</TabsContent>
      </Tabs>
      <Input aria-label="Editable field" />
      <div role="textbox" aria-label="Editable document" contentEditable suppressContentEditableWarning className="border border-border3 p-2">Editable document</div>
      <div className="flex items-center gap-3">
        <Popover>
          <PopoverTrigger asChild><Button>Open popover</Button></PopoverTrigger>
          <PopoverContent aria-label="Search popover"><Input aria-label="Popover search" /></PopoverContent>
        </Popover>
        <Dialog>
          <DialogTrigger asChild><Button>Open dialog</Button></DialogTrigger>
          <DialogContent>
            <DialogTitle>Focus dialog</DialogTitle>
            <DialogDescription>Keyboard focus stays inside this dialog.</DialogDescription>
            <Input autoFocus aria-label="Dialog field" />
          </DialogContent>
        </Dialog>
        <Sheet>
          <SheetTrigger asChild><Button>Open sheet</Button></SheetTrigger>
          <SheetContent>
            <SheetTitle>Focus sheet</SheetTitle>
            <SheetDescription>Pointer focus does not paint a keyboard ring.</SheetDescription>
          </SheetContent>
        </Sheet>
        <Button onClick={() => setShortcuts(true)}>Open shortcuts</Button>
        <Tooltip label="Action help"><Button data-testid="help">Help action</Button></Tooltip>
      </div>
      <ShortcutsPalette open={shortcuts} onOpenChange={setShortcuts} />
      <div hidden {...{ inert: "" }}><Button>Hidden action</Button><Input aria-label="Hidden field" /></div>
      <Button onClick={() => action.current?.focus()}>Focus action programmatically</Button>
      <iframe title="Embedded focus document" sandbox="allow-same-origin" srcDoc='<button type="button">Frame end</button>' className="h-12" />
      <Button>After embedded document</Button>
      <div className="h-64">
        <ReviewTimelineSection pr={null} prNumber={1} commits={[]} timeline={[]} loading={false} error={null}
          scrollKey={`focus:${owner}`} onAddToChat={() => {}} onRetry={() => {}}
          onPostComment={() => new Promise<void>((_resolve, reject) => { rejectComment.current = reject; })} />
      </div>
      <Button onClick={() => rejectComment.current?.(new Error("Comment failed"))}>Fail comment request</Button>
    </section>
  );
}

function Harness() {
  const [owner, setOwner] = useState("Local");
  return (
    <TooltipProvider>
      <main data-Zeros-root className="bg-bg1 text-fg1 min-h-screen p-4">
        <nav className="flex gap-2">
          {["Local", "Organization local", "Organization cloud"].map((name) => (
            <Button key={name} onClick={() => setOwner(name)}>{name}</Button>
          ))}
        </nav>
        <Surface key={owner} owner={owner} />
      </main>
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
