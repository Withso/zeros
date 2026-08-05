import React from "react";
import { captureException } from "../../platform/observability/analytics/posthog";

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[Zeros] Component error:", error, info);
    // Report to PostHog error tracking. componentStack is just the
    // React component tree (names only — no props/user data), so it's
    // safe to send. No-ops when analytics is disabled / not yet ready.
    captureException(error, {
      source: "react-error-boundary",
      component_stack: info.componentStack,
      severity: "major",
      area: "renderer",
    });
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      // Inline styles, not a CSS class: the boundary's whole job is to
      // render *something* when the tree is broken, and that can
      // include a broken styling/token layer or a failure before
      // stylesheets resolve. Every color is a token var() with a
      // hardcoded dark-theme fallback (matching the BrowserWindow
      // backgroundColor): themed when the token layer is alive, still
      // a visible, actionable surface when it isn't.
      const btnStyle: React.CSSProperties = {
        padding: "6px 14px",
        fontSize: 12,
        borderRadius: 4,
        border: "1px solid var(--border3, #2a2a2a)", // check:ui ignore-line (error-boundary fallback)
        background: "var(--bg2, #1a1a1a)", // check:ui ignore-line (error-boundary fallback)
        color: "var(--fg1, #e5e5e5)", // check:ui ignore-line (error-boundary fallback)
        cursor: "pointer",
      };
      return (
        <div
          role="alert"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            height: "100vh",
            padding: 24,
            textAlign: "center",
            background: "var(--bg1, #0a0a0a)", // check:ui ignore-line (error-boundary fallback)
            color: "var(--fg1, #e5e5e5)", // check:ui ignore-line (error-boundary fallback)
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
          }}
        >
          <div
            style={{ fontSize: 14, fontWeight: 500 }} // check:ui ignore-line (stylesheet-independent emergency fallback)
          >
            Something went wrong
          </div>
          {this.state.error?.message ? (
            <div
              style={{
                maxWidth: 520,
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--fg3, #8a8a8a)", // check:ui ignore-line (error-boundary fallback)
                fontFamily:
                  "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
                wordBreak: "break-word",
              }}
            >
              {this.state.error.message}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              style={btnStyle}
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try again
            </button>
            <button
              type="button"
              style={btnStyle}
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
