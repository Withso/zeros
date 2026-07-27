import { useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  Atom,
  Bird,
  BookOpen,
  Box,
  Brain,
  BriefcaseBusiness,
  Bug,
  ChartNoAxesCombined,
  ChefHat,
  CircleDollarSign,
  Cloud,
  Code2,
  Coffee,
  Compass,
  Crown,
  Database,
  Gem,
  Globe2,
  Heart,
  House,
  Layers3,
  Leaf,
  Lightbulb,
  Package,
  Palette,
  Rocket,
  Server,
  Shield,
  Sparkles,
  Terminal,
  WandSparkles,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

import type { Project } from "../store/projects-store";
import {
  useResolvedRepositoryIcon,
  type AutomaticRepositoryIcon,
  type RepositoryIconChoice,
} from "../store/repository-icons";
import { cn } from "./cn";

export interface RepositoryIconOption {
  name: string;
  label: string;
  keywords: string[];
  Icon: LucideIcon;
}

export interface RepositoryEmojiOption {
  value: string;
  label: string;
  keywords: string[];
}

export const REPOSITORY_ICONS: RepositoryIconOption[] = [
  { name: "code-2", label: "Code", keywords: ["dev", "brackets"], Icon: Code2 },
  {
    name: "app-window",
    label: "App",
    keywords: ["web", "window"],
    Icon: AppWindow,
  },
  {
    name: "terminal",
    label: "Terminal",
    keywords: ["shell", "cli"],
    Icon: Terminal,
  },
  {
    name: "package",
    label: "Package",
    keywords: ["module", "box"],
    Icon: Package,
  },
  { name: "globe-2", label: "Globe", keywords: ["web", "world"], Icon: Globe2 },
  {
    name: "database",
    label: "Database",
    keywords: ["data", "storage"],
    Icon: Database,
  },
  {
    name: "server",
    label: "Server",
    keywords: ["backend", "host"],
    Icon: Server,
  },
  {
    name: "cloud",
    label: "Cloud",
    keywords: ["deploy", "remote"],
    Icon: Cloud,
  },
  {
    name: "rocket",
    label: "Rocket",
    keywords: ["launch", "ship"],
    Icon: Rocket,
  },
  {
    name: "sparkles",
    label: "Sparkles",
    keywords: ["ai", "magic"],
    Icon: Sparkles,
  },
  {
    name: "wand-sparkles",
    label: "Wand",
    keywords: ["ai", "magic"],
    Icon: WandSparkles,
  },
  { name: "atom", label: "Atom", keywords: ["science", "react"], Icon: Atom },
  { name: "bug", label: "Bug", keywords: ["debug", "issue"], Icon: Bug },
  {
    name: "wrench",
    label: "Wrench",
    keywords: ["tool", "build"],
    Icon: Wrench,
  },
  { name: "zap", label: "Lightning", keywords: ["fast", "energy"], Icon: Zap },
  {
    name: "shield",
    label: "Shield",
    keywords: ["security", "safe"],
    Icon: Shield,
  },
  { name: "brain", label: "Brain", keywords: ["ai", "smart"], Icon: Brain },
  {
    name: "lightbulb",
    label: "Lightbulb",
    keywords: ["idea", "insight"],
    Icon: Lightbulb,
  },
  {
    name: "layers-3",
    label: "Layers",
    keywords: ["stack", "design"],
    Icon: Layers3,
  },
  { name: "box", label: "Box", keywords: ["cube", "package"], Icon: Box },
  {
    name: "book-open",
    label: "Book",
    keywords: ["docs", "read"],
    Icon: BookOpen,
  },
  {
    name: "palette",
    label: "Palette",
    keywords: ["design", "color"],
    Icon: Palette,
  },
  {
    name: "chart-no-axes-combined",
    label: "Chart",
    keywords: ["analytics", "growth"],
    Icon: ChartNoAxesCombined,
  },
  {
    name: "briefcase-business",
    label: "Briefcase",
    keywords: ["business", "work"],
    Icon: BriefcaseBusiness,
  },
  {
    name: "circle-dollar-sign",
    label: "Dollar",
    keywords: ["money", "finance"],
    Icon: CircleDollarSign,
  },
  { name: "house", label: "Home", keywords: ["house", "local"], Icon: House },
  {
    name: "heart",
    label: "Heart",
    keywords: ["favorite", "love"],
    Icon: Heart,
  },
  { name: "leaf", label: "Leaf", keywords: ["nature", "green"], Icon: Leaf },
  { name: "bird", label: "Bird", keywords: ["animal", "fly"], Icon: Bird },
  {
    name: "chef-hat",
    label: "Chef",
    keywords: ["food", "cook"],
    Icon: ChefHat,
  },
  {
    name: "coffee",
    label: "Coffee",
    keywords: ["drink", "java"],
    Icon: Coffee,
  },
  {
    name: "compass",
    label: "Compass",
    keywords: ["navigate", "direction"],
    Icon: Compass,
  },
  {
    name: "crown",
    label: "Crown",
    keywords: ["royal", "premium"],
    Icon: Crown,
  },
  { name: "gem", label: "Gem", keywords: ["diamond", "ruby"], Icon: Gem },
];

export const REPOSITORY_EMOJIS: RepositoryEmojiOption[] = [
  { value: "🚀", label: "Rocket", keywords: ["launch", "ship"] },
  { value: "✨", label: "Sparkles", keywords: ["magic", "ai"] },
  { value: "⚡", label: "Lightning", keywords: ["fast", "energy"] },
  { value: "🔥", label: "Fire", keywords: ["hot", "flame"] },
  { value: "💡", label: "Idea", keywords: ["light", "insight"] },
  { value: "🧠", label: "Brain", keywords: ["ai", "smart"] },
  { value: "🤖", label: "Robot", keywords: ["ai", "bot"] },
  { value: "🛠️", label: "Tools", keywords: ["build", "fix"] },
  { value: "🧪", label: "Test tube", keywords: ["lab", "test"] },
  { value: "📦", label: "Package", keywords: ["box", "module"] },
  { value: "🌐", label: "Globe", keywords: ["web", "world"] },
  { value: "☁️", label: "Cloud", keywords: ["deploy", "remote"] },
  { value: "🗄️", label: "Database", keywords: ["data", "storage"] },
  { value: "📱", label: "Phone", keywords: ["mobile", "app"] },
  { value: "💻", label: "Laptop", keywords: ["computer", "code"] },
  { value: "🎨", label: "Art", keywords: ["design", "color"] },
  { value: "🎮", label: "Game", keywords: ["controller", "play"] },
  { value: "🎵", label: "Music", keywords: ["audio", "sound"] },
  { value: "📚", label: "Books", keywords: ["docs", "learn"] },
  { value: "🔒", label: "Lock", keywords: ["security", "private"] },
  { value: "🛡️", label: "Shield", keywords: ["security", "safe"] },
  { value: "❤️", label: "Heart", keywords: ["love", "favorite"] },
  { value: "🌱", label: "Seedling", keywords: ["green", "growth"] },
  { value: "🍎", label: "Apple", keywords: ["fruit", "mac"] },
  { value: "🐦", label: "Bird", keywords: ["animal", "fly"] },
  { value: "🐙", label: "Octopus", keywords: ["animal", "github"] },
  { value: "👑", label: "Crown", keywords: ["royal", "premium"] },
  { value: "💎", label: "Gem", keywords: ["diamond", "ruby"] },
  { value: "🧭", label: "Compass", keywords: ["navigate", "direction"] },
  { value: "🏠", label: "Home", keywords: ["house", "local"] },
];

const ICONS_BY_NAME = new Map(
  REPOSITORY_ICONS.map((icon) => [icon.name, icon.Icon]),
);

export function projectInitial(name: string): string {
  return (name.trim()[0] ?? "·").toUpperCase();
}

export function automaticRepositoryIconLabel(
  source: AutomaticRepositoryIcon["source"],
): string {
  if (!source) return "Using repository initial";
  if (source.kind === "github-avatar") return "Using GitHub avatar";
  const sourcePath = source.path;
  if (sourcePath.includes("apple-touch-icon")) return "Using Apple touch icon";
  if (sourcePath.includes("favicon")) return "Using favicon";
  if (sourcePath.includes("logo")) return "Using repository logo";
  return "Using repository icon";
}

export function RepositoryIconGraphic({
  choice,
  automatic,
  name,
  className,
}: {
  choice: RepositoryIconChoice | null;
  automatic: AutomaticRepositoryIcon;
  name: string;
  className?: string;
}) {
  const imageUrl =
    choice?.kind === "upload" ? choice.dataUrl : automatic.imageUrl;
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [imageUrl]);

  const Icon = useMemo(
    () => (choice?.kind === "lucide" ? ICONS_BY_NAME.get(choice.value) : null),
    [choice],
  );

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        className,
      )}
      aria-hidden="true"
    >
      {choice?.kind === "emoji" ? (
        <span className="text-sm leading-none">{choice.value}</span>
      ) : Icon ? (
        <Icon className="size-3.5" strokeWidth={1.5} />
      ) : imageUrl && !imageFailed ? (
        <img
          src={imageUrl}
          alt=""
          className="size-full object-cover"
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setImageFailed(true)}
        />
      ) : (
        projectInitial(name)
      )}
    </span>
  );
}

export function RepositoryIcon({
  project,
  className,
}: {
  project: Project;
  className?: string;
}) {
  const resolved = useResolvedRepositoryIcon(project);
  return (
    <RepositoryIconGraphic
      choice={resolved.choice}
      automatic={resolved.automatic}
      name={project.name}
      className={className}
    />
  );
}
