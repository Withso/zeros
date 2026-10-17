// Portable authored defaults render outside the app and cannot reference its chrome tokens.
import { escapeText, escapeAttribute } from "./source";

/** A new directory's Manual tokens start empty: the theme editor offers to
 * sync the application's own styles instead of placeholder values. The reset
 * only removes browser defaults and reads no token. */
export const TOKENS_SEED = `/* Design-only tokens. Sync the application's styles from the theme editor
   to use its real tokens; add a token here only for a value the app lacks. */

@layer reset {
  *, *::before, *::after { box-sizing: border-box; }
  html, body { min-height: 100%; margin: 0; }
  h1, h2, h3, h4, h5, h6, p { margin: 0; }
  img, svg { display: block; max-width: 100%; }
  button, input, textarea, select { font: inherit; }
}
`;

/** New canvas frames keep one editable root for styles and future children,
 * but never seed visible content the designer did not create. With imported
 * app styles the root takes the app's page background instead of white. */
export const FRAME_SEED = (
  title: string,
  oid: string,
  _width: number,
  _height: number,
  tokensHref = "./tokens.css",
  appStyles = false,
): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${escapeAttribute(tokensHref)}">
    <title>${escapeText(title)}</title>
  </head>
  <body>
    <main data-oid="${oid}-main" data-zeros-frame-root style="display:block; position:relative; width:100%; height:100vh; box-sizing:border-box;${appStyles ? "" : " background-color:#ffffff;"} opacity:1;"></main>
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
  tokensHref = "./tokens.css",
): string => `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="${escapeAttribute(tokensHref)}">
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
