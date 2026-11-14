# Showing every state

Reviewers usually want every state of a surface side by side: default, hover, selected, focus-visible, disabled, loading, empty, error, and long or missing content, plus the workspace variants where the product differs. Frames do not run scripts, so each state is drawn rather than toggled. These are patterns that work well on the canvas; choose whichever fits the request.

A state is an attribute or a state class on the same markup, never a second version of it: `is-hover`, `is-disabled`, `aria-pressed="true"`, `aria-expanded="true"`, `data-state="open"`, styled by the frame's or the directory's CSS.

## One frame per state

- Write one HTML file per state in the page's folder and give each frame a title such as `"Composer — Disabled"`. Each frame uses the same markup and classes and sets its state with attributes; parts shared by several frames are components.
- Place the frames in a row on one page so the canvas shows them together. Rows of related states read well with the same width and a consistent gap.
- Best when states differ in layout or size, or when each state is a whole screen.

## One frame with a row per state

- Make the part a main frame once and place one `<zd-<name>>` instance per state, each under a short label. Each instance carries its own option values and fills its slots, so it holds its own text and state (`reference/format.md`, Components). A change to the main updates every state at once.
- Markup drawn three or more times is a component; `design validate` warns with `repeated-markup` otherwise. For one or two states, the same markup with its state attribute is enough.
- A grid or a column with `gap` keeps the rows aligned, and a person can reorder or duplicate rows on the canvas.
- Best for small parts such as buttons, rows, chips and menu items.

## Interaction and motion

- A drawn hover, pressed or focus state appears in captures and on the canvas. `:hover` and `:focus-visible` rules apply only while someone actually hovers or focuses the element.
- Animate state changes with CSS transitions and `@keyframes`. The motion timeline edits and previews keyframes from source, and captures stop animations.

## Themes

- The canvas applies themes itself: the Themes menu sets `data-zd-theme` on every frame root. One frame therefore shows one theme at a time.
- Capture each theme the design supports (`--theme <id>`, `reference/verify.md`) instead of drawing a second copy for the other theme.

## Generating many states

- Shell, Node or Python may generate the frames, rows or component instances from data; the output is still HTML and CSS. Generate component instances rather than copies of the same markup.
- Register generated frames in `meta/canvas.json` the same way as hand-written ones, and verify them in proportion (`reference/verify.md`).
