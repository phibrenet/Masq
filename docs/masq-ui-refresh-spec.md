# Masq UI Refresh — Implementation Spec

## Context

Masq is an Electron desktop app for producing anonymised, subsetted dumps of a source database. It currently works but looks generic. This spec describes a visual and UX refresh.

**Hard constraints**

- Keep dark mode as the default (and only required) theme. Don't break the existing Appearance setting if one exists.
- Keep the existing Masq logo unchanged. Its colours may be sampled for a secondary accent.
- Don't change behaviour, data models, IPC contracts or business logic unless a task below explicitly asks for it. This is a presentation-layer change.
- Keep all existing features reachable. If something moves (e.g. workspace actions into a menu), it must still be accessible.

**Assumed stack.** Vue 3 + Tailwind CSS in the renderer, with Electron main and preload processes. **Verify this before starting**: inspect `package.json`, the renderer entry point and the Tailwind config. If the stack differs (React, plain CSS, Tailwind v4 CSS-first config), adapt the snippets below to match the project's conventions rather than introducing a new approach.

## Working rules for the agent

1. Before editing, map the codebase and record the locations of:
   - the `BrowserWindow` creation
   - the app shell/layout component
   - the sidebar
   - each page (Connections, Tables, Selection Rules, Backfill Management, Field Strategies, Polymorphic, Runs)
   - the global CSS and the Tailwind config
2. Do the work in the phase order below. Each phase should leave the app runnable.
3. Reuse existing components where possible. Extract shared primitives (Badge, SegmentedControl, Panel, Row, MenuButton) instead of duplicating markup.
4. Don't hardcode hex colours in components. Use only the design tokens from Phase 1.
5. After each phase, run the app and the existing lint, typecheck and test scripts, and fix any regressions.
6. Keep accessibility intact:
   - Segmented controls use `role="radiogroup"` / `role="radio"` with `aria-checked`.
   - Toggles keep their labels.
   - Focus rings stay visible (`focus-visible:ring-2 ring-accent/60`).

---

## Phase 1 — Design tokens and typography

### 1.1 Tokens

Create (or replace) a tokens stylesheet imported globally, e.g. `src/renderer/styles/tokens.css`. Values are space-separated RGB triples so Tailwind alpha modifiers work.

```css
:root {
  --bg:        11 11 15;
  --surface-1: 18 18 24;
  --surface-2: 24 24 32;
  --surface-3: 32 32 42;
  --fg:        236 236 241;
  --fg-muted:  148 148 160;
  --fg-subtle: 100 100 112;

  --accent:    124 92 255;   /* brand purple: primary actions + active nav ONLY */
  --ok:        52 211 153;
  --warn:      251 191 36;
  --danger:    248 113 113;

  /* Table classification */
  --c-transactional: 96 165 250;
  --c-reference:     167 139 250;
  --c-structure:     251 191 36;
  --c-excluded:      113 113 122;

  /* Field strategy families */
  --s-preserve:  148 163 184;
  --s-redact:    248 113 113;
  --s-fake:      251 146 60;
  --s-obfuscate: 244 114 182;
  --s-jitter:    192 132 252;
  --s-template:  56 189 248;
}
```

Optional: sample a warm tone from the logo and add it as `--accent-2` for small highlights (the logo mark area, the Run button glow). Don't use it for semantic states.

### 1.2 Tailwind config

```js
const c = (v) => `rgb(var(${v}) / <alpha-value>)`;

module.exports = {
  // keep existing content/darkMode settings
  theme: {
    extend: {
      colors: {
        bg: c('--bg'),
        'surface-1': c('--surface-1'),
        'surface-2': c('--surface-2'),
        'surface-3': c('--surface-3'),
        fg: c('--fg'),
        'fg-muted': c('--fg-muted'),
        'fg-subtle': c('--fg-subtle'),
        accent: c('--accent'),
        ok: c('--ok'),
        warn: c('--warn'),
        danger: c('--danger'),
        cls: {
          transactional: c('--c-transactional'),
          reference: c('--c-reference'),
          structure: c('--c-structure'),
          excluded: c('--c-excluded'),
        },
        strat: {
          preserve: c('--s-preserve'),
          redact: c('--s-redact'),
          fake: c('--s-fake'),
          obfuscate: c('--s-obfuscate'),
          jitter: c('--s-jitter'),
          template: c('--s-template'),
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Geist Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
};
```

If the project uses Tailwind v4, express the same tokens with `@theme` in CSS instead.

### 1.3 Fonts

- Bundle Inter and JetBrains Mono locally (e.g. via `@fontsource/inter` and `@fontsource/jetbrains-mono`). Don't load them from a CDN, because Electron must work offline.
- Use `font-sans` for all UI text.
- Every database identifier (table names, column names, `table.column` edges, hostnames, database names) uses `font-mono text-[13px]`.
- All counts and numbers use `tabular-nums`.
- Page H1: `text-xl font-semibold tracking-tight text-fg`. Page description: `text-sm text-fg-muted`.

### 1.4 Surfaces

- App background is `bg-bg`; panels are `bg-surface-1`; rows and inputs inside panels are `bg-surface-2`.
- Prefer layered surfaces over borders. Use a border (`border-white/[0.06]`) only where two identical surfaces meet.
- Lists of items render as **one panel with divided rows** (`divide-y divide-white/[0.04]`), not one bordered card per item.
- Radius: panels `rounded-xl`, controls `rounded-md`, badges `rounded`.

**Acceptance criteria**
- Tokens are defined and all new or edited components use them.
- A grep for hex colours in the edited components returns nothing new.
- Fonts render offline.

---

## Phase 2 — Window chrome and app shell

### 2.1 Frameless title bar

In the `BrowserWindow` options:

```js
const win = new BrowserWindow({
  // keep existing width/height/webPreferences
  backgroundColor: '#0b0b0f',
  titleBarStyle: 'hidden',
  titleBarOverlay: process.platform === 'darwin' ? undefined : {
    color: '#0b0b0f',
    symbolColor: '#a1a1aa',
    height: 40,
  },
  trafficLightPosition: { x: 14, y: 12 }, // macOS
});
```

- The renderer's top bar is 40px tall, uses `-webkit-app-region: drag`, and every interactive element inside it uses `-webkit-app-region: no-drag`.
- Leave room for the native window controls:
  - On Windows and Linux, add right padding of about 140px, or use `env(titlebar-area-width)` if Window Controls Overlay values are available.
  - On macOS, add left padding of about 78px when the sidebar doesn't already cover that area.
- Expose `process.platform` to the renderer through the preload script if it isn't already available.

### 2.2 Top bar

- Replace the current page-name-only top bar with:
  - on the left, a breadcrumb `‹Workspace name› › ‹Page name›`, with the workspace name in `text-fg-muted` and the page name in `text-fg`
  - on the right, page-specific actions via a slot, plus a persistent primary **Run** button that navigates to or starts a run using the existing behaviour
- Remove the duplicated large page title from the top bar. The page body keeps the H1 and description.

### 2.3 Sidebar

**Workspace block**
- Move Edit, Delete, Export and Import workspace… into the workspace dropdown (or a `⋯` menu beside it), grouped as: switch workspace list → divider → Edit, Export, Import… → divider → Delete (in `text-danger`).
- Delete must still confirm, as it does today.

**Navigation as a pipeline**
- Render the nav items in their existing order as steps of a workflow.
- Each item: icon, label, and on the right either a status dot or a badge.
  - `done`: small `bg-ok` dot.
  - `attention`: a `bg-warn/15 text-warn` pill with a count.
  - `todo`: nothing.
- Draw a subtle vertical connector line (`border-l border-dashed border-white/10`) between the step icons.
- Active state: `bg-accent/10 text-fg` plus a 2px left accent bar.
- Hover state: `bg-white/[0.03] text-fg`. It must be visually distinct from active.
- **Bug to fix:** currently two items can appear highlighted at once (hover looks identical to active). After this change, exactly one item looks active.

**Step status sources** (derive from existing stores or state; add lightweight computed getters only, no new persistence):

| Step | Done when | Attention badge |
|---|---|---|
| Connections | ≥1 connection exists and last test succeeded | count of connections whose last test failed |
| Tables | every discovered table has a class | count of unclassified tables |
| Selection Rules | ≥1 rule exists for transactional tables | none |
| Backfill Management | edges have been read from the database | none |
| Field Strategies | no suspected PII columns lack a strategy (see 4.4) | count of suspected unhandled PII columns |
| Polymorphic | configured, or nothing to configure | none |
| Runs | last run succeeded | `!` if last run failed |

If the data for a status isn't readily available, render no indicator for that step and add a `TODO` comment. Don't invent data.

**Footer**
- Output mode: a small segmented control using the existing option values.
- Appearance: a segmented control or select, wired to the existing setting.

**Acceptance criteria**
- The native title bar is gone and the window can still be dragged by the top bar.
- Window controls work on Linux and Windows.
- All workspace actions are reachable from the menu.
- Exactly one nav item looks active.

---

## Phase 3 — Shared primitives

Create these in something like `src/renderer/components/ui/` and use them in Phase 4.

- **`Panel`**: `bg-surface-1 rounded-xl` with an optional header slot and a body with divided rows.
- **`SegmentedControl`**
  - Props: `options: {key, label, activeClass}[]` and `modelValue`.
  - Container: `bg-surface-2 p-0.5 rounded-md`.
  - Option: `px-2.5 py-1 text-xs font-medium rounded ring-1 ring-transparent`.
  - Selected option uses its own `activeClass`, so each option can have its own colour.
  - Keyboard support: arrow keys move the selection.
- **`Badge`**
  - Props: `tone` (any token name) and `variant` (`soft` | `outline`).
  - Soft variant: `bg-{tone}/15 text-{tone} ring-1 ring-{tone}/30 text-xs px-1.5 py-0.5 rounded`.
  - Build tone → class maps statically so Tailwind can see the class names. No dynamic string concatenation.
- **`MenuButton`**: a `⋯` icon button that opens a dropdown of actions, with destructive items styled `text-danger`.
- **`StatusDot`**: tones `ok` | `warn` | `danger` | `muted`, with an optional pulse while testing.
- **`FilterChips`**: a horizontal chip row with a label, a count and an active state. Clicking toggles a filter.
- **`EmptyState`**: icon, title, one sentence and a primary action.

---

## Phase 4 — Pages

### 4.1 Connections

- Render connections in a responsive grid (`grid-cols-1 lg:grid-cols-2`).
- Each card shows:
  - the name in `text-base font-medium`
  - an engine icon (PostgreSQL or MySQL) in place of the grey text pill
  - `host:port / database` in mono and the user in `text-fg-muted`
  - a lock icon labelled "Read-only", reinforcing that Masq never writes back
  - a status row with a `StatusDot` and the last test result and time ("Connected · 42 ms · tested 3 min ago"), using existing test results if they're stored, otherwise session state
  - optionally, the table count if it's already known
- Actions:
  - **Test** is a ghost button with an icon, and shows a spinner and pulsing dot while running.
  - Edit and Delete go into a `MenuButton`.
- Put a dashed "Add connection" tile (`border-2 border-dashed border-white/10 hover:border-accent/50`) at the end of the grid. It opens the existing new-connection flow.
- Remove the top-right "New connection" button, or keep it in the top-bar action slot; don't show it in both places.

### 4.2 Tables

- Keep the existing toolbar (Discover from source, framework preset select, Apply presets), styled as a compact toolbar row.
- **Replace the legend table** with `FilterChips` showing counts per class, plus "Unclassified" if any exist. Each chip shows its class's "Used for" description as a tooltip. Clicking a chip filters the list.
- Merge the "Table name" input and "Add table" button into one field with placeholder "Filter or add table…".
  - Typing filters the list.
  - If no exact match exists, show an inline "Add ‹name›" action, triggered by Enter or a button, that calls the existing add-table logic.
- **Rows:** a single `Panel` with one row per table, about 40px tall.
  - The table name on the left in mono. Excluded tables get `text-fg-muted line-through decoration-fg-muted/40`.
  - A `SegmentedControl` on the right, with class-specific active styles:
    - transactional: `bg-cls-transactional/15 text-cls-transactional ring-cls-transactional/40`
    - reference: `bg-cls-reference/15 text-cls-reference ring-cls-reference/40`
    - structure: `bg-cls-structure/15 text-cls-structure ring-cls-structure/40`
    - excluded: `bg-cls-excluded/20 text-fg-muted ring-cls-excluded/40`
  - If the row differs from the applied preset, show a small `bg-accent` dot titled "Differs from preset", and a Reset button that appears on row hover. Rows that match the preset show no Reset.
- For long lists, make the chip and filter bar sticky at the top of the scroll area.

### 4.3 Backfill Management

- Keep "Read links from database", the "How this works" disclosure, the filter input, and the "Show links that are always on" toggle, arranged as one toolbar row.
- Each target table becomes a collapsible group with a sticky header. The header shows:
  - the table name (mono)
  - "54 links · 19 always on" in `text-fg-muted tabular-nums`
  - a thin proportion bar (on / off / always-on segments)
  - the chevron
- Edge rows render as `source_table` in `text-fg-muted`, then `.column` in `text-fg`, then `→ target.id` in `text-fg-muted`, all in mono. The column is the distinguishing part, so it must be the most prominent.
- Always-on edges, when shown, display a lock icon in place of the toggle, with a tooltip explaining why they can't be turned off.
- Show the "N turned off · M hidden" summary as small badges.

### 4.4 Field Strategies

- Tables stay grouped, with the table name as the group header (mono).
- **Collapse "Country from" and "Identity from"** into a `⚙ Context` button in each group header.
  - It opens a popover containing the two existing selects.
  - When either value is set, show it inline in the header as a subtle badge (e.g. `country: addresses.country`).
  - When neither is set, show only the button.
- Rows use a grid with four columns:
  - the column name (mono)
  - a strategy `Badge` coloured by family (`strat.*` tokens)
    - label format: `Fake · email`, `Redact · null`, `Template · 10 fields`
    - the full template mapping goes in a tooltip or expandable detail, instead of truncating with "+7 more"
  - a preview (see below)
  - actions: Edit as a ghost button, and Delete inside a `MenuButton`
- **Preview column.** If the app can generate a sample output locally with the existing faker or strategy code, without touching the source database, show `sample → result` in mono `text-xs text-fg-muted`, e.g. `jane@acme.com → k.morris@example.net`. If a real sample isn't available, show a representative example of the strategy's output only. If neither is feasible without new backend work, hide the column and add a `TODO`.
- **Unhandled-PII banner** at the top of the page.
  - Using table and column metadata already known to the app, flag columns whose names match `/(e[-_]?mail|phone|mobile|ip(_address)?|first_?name|last_?name|full_?name|surname|address|postcode|zip|dob|birth|ssn|national_insurance|passport|user_agent)/i` and that have no strategy.
  - Banner text: "N columns look like personal data but have no strategy". Expanding it lists the columns, each with a "Add strategy" action that opens the existing add-strategy flow pre-filled.
  - This count also feeds the sidebar badge from Phase 2.
  - If column metadata isn't available in the renderer, skip the banner and add a `TODO`.
- "Add strategy" moves to the top-bar action slot.

### 4.5 Selection Rules, Polymorphic, Runs

These weren't in the review screenshots. Apply the same system to them:

- page H1 and description
- a toolbar row
- `Panel` with divided rows instead of card-per-item
- mono for identifiers
- semantic colours from the tokens
- `EmptyState` when a list is empty

For **Runs** specifically:
- each run shows a `StatusDot`, start time, duration and row counts using `tabular-nums`
- a running run shows a progress bar in `bg-accent`
- failed runs show the error summary in `text-danger`

---

## Phase 5 — Polish

- Transitions: `transition-colors duration-150` on interactive elements. Avoid layout animations on long lists.
- Scrollbars: thin, dark scrollbars via `::-webkit-scrollbar` (8px wide, thumb `rgb(255 255 255 / 0.1)`, hover `0.2`, transparent track).
- Empty states on every page that can have no data.
- Loading states: skeleton rows (`animate-pulse bg-surface-2`) instead of blank panels during discovery or reading links.
- Toasts for success and error, if the app already has a notification mechanism. Restyle it to use the tokens.
- Confirm every destructive action still asks for confirmation.

---

## Final checklist

- [ ] Native title bar removed; top bar draggable; window controls work on the target OS.
- [ ] Logo unchanged; dark mode intact.
- [ ] Purple (`accent`) is used only for primary actions, the active nav item and focus rings.
- [ ] Table classes and strategy families each have a distinct, consistent colour everywhere they appear.
- [ ] All identifiers render in the monospace font.
- [ ] Exactly one sidebar item looks active at a time.
- [ ] Workspace Edit, Export, Import and Delete are reachable from the menu, and Delete still confirms.
- [ ] Tables rows are single-line with class-coloured segments; Reset appears only on overridden rows.
- [ ] Field Strategies context selects are collapsed into a popover.
- [ ] No behaviour, IPC or data-model regressions. Lint, typecheck and tests pass.
- [ ] Every `TODO` left for unavailable data is listed in a short summary at the end of the work.
