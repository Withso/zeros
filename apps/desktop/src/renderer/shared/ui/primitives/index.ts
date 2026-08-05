// Public barrel for the shared component primitives. Consumers should prefer
// this entrypoint over deep imports when they need several primitives.

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
export { Toolbar } from "./toolbar";
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

// Supporting primitives used by the prompt input and other composite controls.
export { HoverCard, HoverCardTrigger, HoverCardContent } from "./hover-card";
export {
  ZerosSpinner,
  type ZerosSpinnerProps,
} from "@/renderer/shared/ui/loading";
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

// Command (cmdk-based combobox) and Sidebar composition primitives.
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

// Chat-surface visual primitives.
export * from "./elements";
