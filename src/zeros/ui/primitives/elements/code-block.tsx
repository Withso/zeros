// ──────────────────────────────────────────────────────────
// AI Elements — CodeBlock
// ──────────────────────────────────────────────────────────
// Visual primitive for code blocks in chat. Zeros already has
// a shiki-based syntax highlighter via src/zeros/agent/
// renderers/syntax.ts. This component renders the chrome
// (header + copy button + language pill); consumers feed it
// pre-highlighted HTML or plain children.
// ──────────────────────────────────────────────────────────

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/zeros/ui/cn";

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  language?: string;
  filename?: string;
}

const CodeBlock = React.forwardRef<HTMLDivElement, CodeBlockProps>(
  ({ className, language, filename, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "overflow-hidden rounded-lg border bg-bg2/60 font-mono text-xs",
        className,
      )}
      {...props}
    >
      {(language || filename) && (
        <div className="flex items-center justify-between border-b bg-bg2/60 px-3 py-1.5 text-xs text-fg2">
          <span>{filename ?? language}</span>
          {filename && language ? (
            <span className="opacity-60">{language}</span>
          ) : null}
        </div>
      )}
      <div className="overflow-x-auto px-3 py-2 [&_pre]:m-0 [&_pre]:bg-transparent">
        {children}
      </div>
    </div>
  ),
);
CodeBlock.displayName = "CodeBlock";

export interface CodeBlockCopyButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  text: string;
}

const CodeBlockCopyButton = React.forwardRef<
  HTMLButtonElement,
  CodeBlockCopyButtonProps
>(({ className, text, ...props }, ref) => {
  const [copied, setCopied] = React.useState(false);

  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked under some sandbox configs */
    }
  }, [text]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={onCopy}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-sm text-fg2 transition-colors hover:bg-bg2-hover hover:text-fg1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-highlighted-bright",
        className,
      )}
      aria-label={copied ? "Copied" : "Copy code"}
      {...props}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
});
CodeBlockCopyButton.displayName = "CodeBlockCopyButton";

export { CodeBlock, CodeBlockCopyButton };
