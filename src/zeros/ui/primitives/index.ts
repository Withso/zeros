// Barrel for the v0 / shadcn primitive surface. Phase 6 of Roadmap 01.
// Consumers should prefer `import { Button } from "@/zeros/ui/primitives"` over
// deep-path imports.

export { Button, buttonVariants, type ButtonProps } from "./button";
export { Pill, type PillProps } from "./pill";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "./card";
export { Input } from "./input";
export { Textarea } from "./textarea";
export { CodeTextarea, type CodeTextareaProps } from "./code-textarea";
export { Label } from "./label";
export { Checkbox, type CheckboxProps, type CheckedState } from "./checkbox";
export { Badge, badgeVariants, type BadgeProps } from "./badge";
export { RadioGroup, RadioGroupItem } from "./radio-group";
export { Separator } from "./separator";
export { Kbd } from "./kbd";
export { Tile } from "./tile";
export { Alert, AlertTitle, AlertDescription } from "./alert";
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./dialog";
export {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverAnchor,
} from "./popover";
export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
} from "./dropdown-menu";
export {
  Tooltip,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./tooltip";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
export { ScrollArea, ScrollBar } from "./scroll-area";
export { Switch } from "./switch";
export { Slider } from "./slider";
export { Avatar, AvatarImage, AvatarFallback } from "./avatar";
export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
} from "./sheet";

// Roadmap 01b Wave 4 deps. These shadcn primitives came in as
// dependencies of the AI Elements PromptInput install. PromptInput
// itself was NOT vendored (its full graph also needs the `ai` SDK +
// nanoid + use-stick-to-bottom — too much scope for Wave 4). The
// primitives themselves are canonical shadcn shape and useful on
// their own; exposing them here so future code can pick them up.
export { HoverCard, HoverCardTrigger, HoverCardContent } from "./hover-card";
export { ZerosSpinner, type ZerosSpinnerProps } from "@/loaders";
export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
  InputGroupTextarea,
} from "./input-group";

// Roadmap 01b Wave 2 (2026-05-16) — Command (cmdk-based combobox) and
// Sidebar primitives installed. Sheet + Avatar + a use-mobile hook came
// in as Sidebar dependencies. Wave 3 will migrate the custom composer
// pill dropdowns to Popover + Command; Wave 5 will rewrite Column 1 on
// top of Sidebar.
export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
} from "./command";
export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
} from "./sidebar";

// AI Elements — chat-surface visual primitives (Phase 7)
export * from "./elements";
