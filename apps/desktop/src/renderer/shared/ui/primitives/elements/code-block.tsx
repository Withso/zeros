// Portions adapted from vercel/ai-elements@1.9.0 (Apache-2.0) and modified
// for Zeros; see third_party/ai-elements/LICENSE. This component owns chat
// code-block chrome while feature renderers provide highlighted content.

import * as React from "react";
import { Check, Copy } from "lucide-react";

import { cn } from "@/renderer/shared/ui/cn";

export interface CodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  language?: string;
  filename?: string;
}

const CodeBlock = React.forwardRef<HTMLDivElement, CodeBlockProps>(
  ({ className, language, filename, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "bg-bg2/60 overflow-hidden rounded-lg border font-mono text-xs",
        className,
      )}
      {...props}
    >
      {(language || filename) && (
        <div className="bg-bg2/60 text-fg2 flex items-center justify-between border-b px-3 py-1.5 text-xs">
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

export interface CodeBlockCopyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
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
        "text-fg2 hover:bg-bg2-hover hover:text-fg1 focus-visible:ring-highlighted-bright inline-flex size-7 items-center justify-center rounded-sm transition-colors focus-visible:ring-1 focus-visible:outline-none",
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
