export type DesignStyleSectionId =
  | "layout"
  | "appearance"
  | "typography"
  | "effects"
  | "transform"
  | "transition"
  | "motion"
  | "css";

const DESIGN_STYLE_SECTION_ORDER: readonly DesignStyleSectionId[] = [
  "layout",
  "appearance",
  "typography",
  "effects",
  "transform",
  "transition",
  "motion",
  "css",
];

const DESIGN_STYLE_SEARCH_TERMS: Readonly<
  Record<DesignStyleSectionId, string>
> = {
  layout: `
    layout size position coordinates x y width height min-width min-height
    max-width max-height aspect-ratio box-sizing z-index visibility float clear
    overflow overflow-x overflow-y cursor pointer-events object-fit object-position
    display auto-layout flex flex-direction flex-wrap flex-grow flex-shrink flex-basis
    order gap row-gap column-gap align-items align-self align-content justify-content
    justify-items justify-self grid grid-template-columns grid-template-rows
    grid-auto-flow grid-auto-columns grid-auto-rows grid-column grid-row padding
    padding-top padding-right padding-bottom padding-left margin margin-top
    margin-right margin-bottom margin-left
  `,
  appearance: `
    appearance fill color background background-color background-image gradient
    background-position background-size background-repeat background-blend-mode
    opacity blend mix-blend-mode isolation border border-width border-top-width
    border-right-width border-bottom-width border-left-width border-style
    border-color radius border-radius border-top-left-radius border-top-right-radius
    border-bottom-right-radius border-bottom-left-radius outline outline-width
    outline-offset outline-style outline-color
  `,
  typography: `
    typography text color font font-family font-size font-weight font-style
    font-stretch line-height letter-spacing word-spacing text-indent text-align
    text-transform text-decoration text-overflow text-wrap white-space word-break
    overflow-wrap vertical-align writing-mode hyphens case tracking leading
  `,
  effects: `
    effects shadow box-shadow text-shadow blur filter backdrop-filter clip-path
  `,
  transform: `
    transform translate rotate scale skew transform-origin perspective
    perspective-origin 3d
  `,
  transition: `
    transition transition-property transition-duration transition-delay
    transition-timing-function duration delay easing timing
  `,
  motion: `
    motion animation keyframe keyframes timeline playback preset animation-name
    animation-duration animation-delay animation-timing-function animation-iteration-count
    animation-direction animation-fill-mode iterations direction fill-mode
  `,
  css: "css declaration declarations custom property advanced code",
};

export function matchesDesignStyleSearch(text: string, query: string): boolean {
  const haystack = text.toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export function designStyleSearchTerms(section: DesignStyleSectionId): string {
  return DESIGN_STYLE_SEARCH_TERMS[section];
}

export function designStyleSearchSections(
  query: string,
): DesignStyleSectionId[] {
  if (!query.trim()) return [...DESIGN_STYLE_SECTION_ORDER];
  return DESIGN_STYLE_SECTION_ORDER.filter((section) =>
    matchesDesignStyleSearch(
      `${section} ${DESIGN_STYLE_SEARCH_TERMS[section]}`,
      query,
    ),
  );
}
