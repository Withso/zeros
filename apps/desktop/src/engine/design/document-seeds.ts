// Portable authored defaults render outside the app and cannot reference its chrome tokens.
import { escapeText, escapeAttribute } from "./source";

export const TOKENS_SEED = `@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  body { background: var(--bg1); color: var(--fg1); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  body [data-oid] { display: block; flex-direction: column; flex-shrink: 0; position: relative; margin: 0; }
  h1, h2, h3, h4, h5, h6, p, span, a, strong, em, small, label { display: block; }
  img, svg { display: block; max-width: 100%; }
  button, input, textarea, select { font: inherit; }
}

@property --bg1 {
  syntax: "<color>";
  inherits: true;
  initial-value: #ffffff;
}
@property --bg2 {
  syntax: "<color>";
  inherits: true;
  initial-value: #f5f5f5;
}
@property --fg1 {
  syntax: "<color>";
  inherits: true;
  initial-value: #171717;
}
@property --fg2 {
  syntax: "<color>";
  inherits: true;
  initial-value: #737373;
}
@property --accent {
  syntax: "<color>";
  inherits: true;
  initial-value: #2563eb;
}
@property --border {
  syntax: "<color>";
  inherits: true;
  initial-value: #e5e5e5;
}
@property --space-1 {
  syntax: "<length>";
  inherits: true;
  initial-value: 4px;
}
@property --space-2 {
  syntax: "<length>";
  inherits: true;
  initial-value: 8px;
}
@property --space-3 {
  syntax: "<length>";
  inherits: true;
  initial-value: 12px;
}
@property --space-4 {
  syntax: "<length>";
  inherits: true;
  initial-value: 16px;
}
@property --space-6 {
  syntax: "<length>";
  inherits: true;
  initial-value: 24px;
}
@property --space-8 {
  syntax: "<length>";
  inherits: true;
  initial-value: 32px;
}
@property --radius-sm {
  syntax: "<length>";
  inherits: true;
  initial-value: 6px;
}
@property --radius-md {
  syntax: "<length>";
  inherits: true;
  initial-value: 10px;
}
@property --radius-lg {
  syntax: "<length>";
  inherits: true;
  initial-value: 16px;
}

:root {
  --bg1: #ffffff;
  --bg2: #f5f5f5;
  --fg1: #171717;
  --fg2: #737373;
  --accent: #2563eb;
  --border: #e5e5e5;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}
`;

/** New canvas frames keep one editable root for styles and future children,
 * but never seed visible content the designer did not create. */
export const FRAME_SEED = (
  title: string,
  oid: string,
  _width: number,
  _height: number,
): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="./tokens.css">
    <title>${escapeText(title)}</title>
  </head>
  <body>
    <main data-oid="${oid}-main" data-zeros-frame-root style="display:block; position:relative; width:100%; height:100vh; box-sizing:border-box; background-color:#ffffff; opacity:1;"></main>
  </body>
</html>
`;

export const TEXT_FRAME_SEED = (
  title: string,
  nodeId: string,
  text: string,
  _width: number,
  _height: number,
  fixedSize: boolean,
): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="./tokens.css">
    <title>${escapeText(title)}</title>
    <style>
      html, body { width: 100%; height: 100%; min-height: 0; margin: 0; background: transparent !important; overflow: visible; }
      body > [data-oid] { ${fixedSize ? "width:100%;min-height:100%;" : "width:max-content;max-width:none;"} margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    </style>
  </head>
  <body>
    <div data-oid="${escapeAttribute(nodeId)}">${escapeText(text)}</div>
  </body>
</html>
`;
