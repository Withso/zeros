// Chat-surface visual primitives built on the shared component and token
// foundations. Upstream provenance is recorded in each adapted source file.

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

// Empty-state and quick-action suggestions with horizontal overflow.
export {
  Suggestion,
  Suggestions,
  type SuggestionProps,
  type SuggestionsProps,
} from "./suggestion";

// Conversation and prompt-input compositions used by AgentChat and the empty
// composer surface.
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
