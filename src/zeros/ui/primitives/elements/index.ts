// AI Elements — chat-surface visual primitives.
// Built on shadcn / v0 tokens, mirror Vercel AI Elements' shape
// so the chat-surface renderers can switch to them with minimal
// disruption. Phase 7 of Roadmap 01.

export {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./collapsible";
export {
  Message,
  MessageContent,
  MessageAvatar,
  type MessageProps,
  type MessageContentProps,
  type MessageAvatarProps,
} from "./message";
export {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
  type ToolProps,
  type ToolHeaderProps,
  type ToolStatus,
} from "./tool";
export {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
  type ReasoningTriggerProps,
} from "./reasoning";
export {
  CodeBlock,
  CodeBlockCopyButton,
  type CodeBlockProps,
  type CodeBlockCopyButtonProps,
} from "./code-block";
export { toast, Toaster, type ToastVariant } from "./toast";
export {
  showUpdateToast,
  dismissUpdateToast,
  UPDATE_TOAST_ID,
  type UpdateToastProps,
} from "./update-toast";

// Wave 4 (2026-05-16) — Suggestion + Suggestions for empty-state /
// quick-action pills below the composer. Canonical AI Elements
// pattern: rounded-full outline Button size sm with horizontal
// scroll for overflow.
export {
  Suggestion,
  Suggestions,
  type SuggestionProps,
  type SuggestionsProps,
} from "./suggestion";

// Wave 4 close-out (2026-05-16) — canonical conversation container
// + prompt-input recipe. Conversation is a flex-1 scroll container;
// PromptInput is the form-shaped InputGroup recipe (textarea body +
// block-end addon toolbar). Both consumed by AgentChat and the
// EmptyComposer to replace ComposerShell/MessageView wrappers.
export {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  type ConversationProps,
  type ConversationContentProps,
  type ConversationScrollButtonProps,
} from "./conversation";
export {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputProps,
  type PromptInputBodyProps,
  type PromptInputTextareaProps,
  type PromptInputToolbarProps,
  type PromptInputToolsProps,
  type PromptInputSubmitProps,
  type PromptInputStatus,
} from "./prompt-input";
