# Wireon Design System — "Matte Slate"

> Source of truth: `src/styles/theme.css` (tokens) and `src/styles/global.css`
> (reset, base elements, utility classes, animations). Read this instead of
> inventing values.
>
> Two caveats before you trust a number below. **Most of the design is
> user-configurable**: `presets.ts` rewrites radii, particles and glass,
> `palette.ts` rewrites the accent and rotates the surface ladder, and
> `typographyVars` rescales the type. Concrete values in this document are
> therefore *defaults*, not constants — use the token names. And **inline style
> beats any stylesheet rule**, which in this codebase is a recurring source of
> bugs, not a footnote: a media query cannot override an inline `display`, and an
> inline `background` kills a `:hover` rule. If a component sets a property
> inline, that property cannot be themed or overridden from CSS.

## 1. Intent

**Matte, not glass — in the app window.** Surfaces are opaque and low-chroma.
Depth comes from four things only: a step up the surface scale, a hairline border,
a soft neutral shadow, and the 1 px lit top edge (`--highlight-top`). No glow, no
saturated gradient.

Blur is not banned outright any more, but it is **fenced off**: `--glass-*` and
the `.glass` / `.glass-strong` classes exist for layers that float over *other*
content — the mini player window, its popover, the queue drawer, modals
(`global.css` §10). Blurring the whole app window costs real frames and turns the
interface into a smear, so the sidebar, header and player bar stay opaque. The
blur radius comes from the active preset (`glassBlur`, 0 for `obsidian`) and a
user can force it off, so **never rely on blur to make text legible** — the same
markup has to read at `blur(0)`.

**Layered.** Six surface values form a strict elevation ladder from
`--surface-sunken` (recessed) to `--surface-4` (modals). Pick the level by what
the element *is*, not by how it should look — see §11 Elevation.

**One restrained accent.** A pale cool blue (`--accent: #8fc7ff`, the "Лёд"
default) is the only chromatic UI colour, and it means *state*, never decoration
— see the rule in §5. Semantic colours exist for status only. If two things on
screen both want the accent, one of them is wrong.

**Accent hex values in this document are the default, not a constant.** Every
`--accent*` token is rewritten at runtime by `palette.ts` from whatever colour
the user picked, and the surface ladder is rotated toward that hue by the same
engine. Read the accent numbers below as "what ships out of the box"; never
hardcode one in a component, and never reason about contrast from these
particular digits — a person may be running any hue in the picker.

**One optical weight for icons.** Every glyph comes off the `ICON` scale, is
paired with a `--control-*` hit target, and gets its stroke normalised by the
ramp in `global.css` — see §7. Never write a raw pixel size.

**Calm motion.** 150–250 ms, custom easing, transform and opacity only.
Everything collapses under `prefers-reduced-motion: reduce`.

**Legible by construction.** Every text/surface pair is measured (§4). A
barely-there film grain (`.grain`, `--grain-opacity` 0.028) sells the matte finish and
hides banding in the large flat fills.

**Never invent a value.** If the colour, radius, duration or icon size you need
is not in this document, it does not exist yet — ask instead of inlining it.

---

## 2. Surfaces

Opaque and low-chroma, but not neutral: the ladder is rotated a couple of degrees
toward the accent hue. Pure grey next to a tinted accent makes the dark read as
dead and the accent as stuck on; a shared hue makes the accent look like it grew
out of the surface. Higher number = closer to the user.

The hex values below are what the default accent produces. They are **computed,
not authored** — `palette.ts` regenerates the whole ladder from the chosen
colour, and a unit test compares `theme.css` against that computation, so editing
these numbers by hand fails the suite. Use the token names; treat the digits as
illustration.

| Token | Value | When to use |
|---|---|---|
| `--bg-base` | `#0e0f12` | The app canvas. Also the `BrowserWindow` backgroundColor and the `theme-color` meta — **change all three together or the window flashes the wrong colour on open.** |
| `--surface-sunken` | `#0a0b0d` | Recessed wells: text inputs, inset progress rails, drop targets, empty-state boxes. |
| `--surface-1` | `#141619` | Structural chrome that sits *on* the canvas: sidebar, header, player bar, the mini window. |
| `--surface-2` | `#191b20` | Content containers on the canvas: cards, list rows, panels. |
| `--surface-3` | `#1f2127` | Floating layers: menus, dropdowns, popovers, queue drawer, toasts. Also the hover target for `--surface-2` cards. |
| `--surface-4` | `#26282e` | Highest layer: modals, tooltips. |
| `--surface-hover` | `rgba(255,255,255,0.050)` | Hover *overlay*. Translucent, so it stacks on any surface without knowing the level. |
| `--surface-active` | `rgba(255,255,255,0.085)` | Pressed/held overlay, and the unfilled part of a slider rail. |
| `--bg-lift` | `rgba(255,255,255,0.035)` | The one background decoration left: a neutral top-of-window gradient on `#root::before`. Not an accent tint — it has to read as another step of this same ladder. |

In `[data-theme='light']` the three translucent values above flip to
`rgba(11,15,22,…)`: white is invisible on a light canvas. **Any new alpha-white
token needs the same treatment** — the light theme is not an inversion, it is a
second set of numbers.

Rules:
- Never skip more than one level between a parent and a child.
- Never use a surface value as a text colour, and never a text value as a fill.
- Prefer the two translucent overlays for interaction states; reserve the
  numbered surfaces for the resting elevation of a box.

### The background is almost empty, on purpose

The canvas carries exactly one thing: a neutral `--bg-lift` gradient along the
top of the window (`#root::before`), unanimated. That is the whole decoration
budget.

Two things used to live here and were removed:

- **Two accent radial glows** in opposite corners. A pair of coloured pools on the
  diagonal is the single most recognisable landing-page tell, and in a music app a
  coloured glow competes with the one genuinely colourful object on screen — the
  artwork — and tints everything around it.
- **A particle field on by default** (`sparks`: accent dots with trails, drifting
  up under the whole UI on a permanent `requestAnimationFrame`). Not badly drawn,
  but it is background motion nobody asked for that communicates nothing, in an
  app where the eye should be on the cover and the list. It also burned frames the
  entire time the window was open.

All four particle profiles still exist and are one click away in appearance
settings — `DESIGN_PRESETS.island` simply ships `particles: 'off'`. If you add a
background layer, it goes **behind** `.wireon-app-shell` (see the stacking-order
comment above `#root` in `global.css`), and it does not animate by default: a
forever-breathing background gets tiring inside the first minute.

## 3. Borders

Hairlines are the primary separation device in a matte system — reach for a
border before you reach for a shadow.

| Token | Value | When to use |
|---|---|---|
| `--border-subtle` | `rgba(255,255,255,0.022)` | Default edge of a resting card/panel; dividers *inside* one surface. |
| `--border` | `rgba(255,255,255,0.035)` | Edge of a floating layer (menu, modal, toast); form control at rest. |
| `--border-strong` | `rgba(255,255,255,0.067)` | Hover/emphasis edge. The "brighten" half of a card hover. |
| `--border-accent` | `rgba(143,199,255,0.45)` | Selected / now-playing / active-filter edge. Never for hover. |

## 4. Text — with measured contrast

| Token | Value | When to use |
|---|---|---|
| `--text-primary` | `#efeff1` | Body copy, track titles, headings, active nav. |
| `--text-secondary` | `#b5b8bf` | Artist names, subtitles, inactive nav, menu item labels. |
| `--text-muted` | `#9296a0` | Metadata: durations, play counts, timestamps, section labels. |
| `--text-faint` | `#6b707b` | **Decoration only** — placeholders, disabled text, separator glyphs. Never information a user needs. |
| `--text-on-accent` | `#0b0f16` | Text and icons on an `--accent` fill. |
| `--accent-contrast` | `var(--text-on-accent)` | Exact synonym; both names are supported. |

### Measured WCAG 2.1 contrast ratios

sRGB relative luminance, `(L1+.05)/(L2+.05)`, measured against the **default**
accent. Re-measure and update this table whenever a surface or a text value moves
— it is the only record that the palette is legible, and a stale number here is
worse than none. A user running a darker custom accent shifts the last row only;
the four text rows are accent-independent.

| foreground | `--bg-base` | `--surface-1` | `--surface-2` | `--surface-3` | `--surface-4` | `--surface-sunken` |
|---|---|---|---|---|---|---|
| `--text-primary` | **16.69** | **15.78** | **15.00** | **14.01** | **12.83** | **17.15** |
| `--text-secondary` | **9.65** | **9.13** | **8.67** | **8.10** | **7.42** | **9.91** |
| `--text-muted` | **6.47** | **6.12** | **5.82** | **5.43** | **4.98** | **6.65** |
| `--text-faint` | 3.86 | 3.65 | 3.47 | 3.24 | 2.97 | 3.96 |
| `--accent` (as text) | **10.75** | **10.17** | **9.67** | **9.03** | **8.27** | **11.05** |

- `--text-primary`, `--text-secondary` **and** `--text-muted` clear the 4.5:1
  body threshold on **every** surface, including `--surface-4` (worst case
  4.98:1).
- `--text-faint` clears 3:1 on `--bg-base` … `--surface-3` (2.97 on `--surface-4`,
  2.55 over a hover overlay there). It is deliberately below body threshold and is
  documented as decoration only — never information a user needs.
- `--text-on-accent` (`#0b0f16`) on the accent fills: **10.77** on `--accent`,
  **12.23** on `--accent-hover`, **8.73** on `--accent-active`. All pass AA
  comfortably — the pale accent buys a lot of headroom over the old violet.
- On a selected row (`--accent-soft` over `--surface-2` ⇒ `#2a333f`):
  primary **11.13**, secondary **6.43**, accent-as-text **7.17**. `--text-muted`
  there is **4.32** and over `--surface-4` (`#353e4b`) **3.64** — **do not put
  muted metadata on a selected row**; step it up to `--text-secondary`.

---

## 5. Accent, semantics and source badges

### Accent — the only chromatic UI colour

| Token | Value | When to use |
|---|---|---|
| `--accent` | `#8fc7ff` | Primary button fill, active nav indicator, slider fill, `.eq-bar`, focus ring, now-playing title. |
| `--accent-hover` | `#a6d3ff` | Hover state of an accent-filled control; accent-coloured *text* on `--surface-4` or a selected row. |
| `--accent-active` | `#6fb4f7` | Pressed state of an accent-filled control. |
| `--accent-soft` | `rgba(143,199,255,0.14)` | Selected row / active chip fill, `::selection`, soft accent tint. Pairs with `--border-accent`. |
| `--accent-contrast` / `--text-on-accent` | `#0b0f16` | Text and icons sitting on any of the three accent fills. |

All five are regenerated by `palette.ts` from the user's colour — see the note in
§1. The names are the contract; the hexes are today's default.

#### The rule: accent means *state*, never decoration

`--accent` and `--accent-soft` are allowed on exactly six things:

1. the **playing** track — its title, its marker, its row fill;
2. the **active** navigation item, tab, filter chip or layout toggle;
3. a switch or toggle that is **on**, including the check on a checked menu item;
4. the **primary** button or action of a region;
5. the **filled** part of a progress rail, slider or download indicator;
6. the **focus** ring.

An "active sleep timer", "syncing now" or "changed from the default" readout
counts as (5) — something is happening and the colour says so. Everything else is
decoration and takes `--text-secondary`: heading glyphs, avatar rings, eyebrow
labels, explanatory captions, "stored offline" badges, chat author names. Artwork
placeholders take `--text-faint`.

The test is whether the colour would move if the app's state changed. A `Sparkles`
next to the words "how this works" is accent-coloured forever, so it teaches the
eye nothing — and it steals meaning from the one accent glyph on screen that *is*
saying something.

**`Sparkles` in particular is down to one use in the whole app**: the "Для вас"
section, in the sidebar and in the command palette, where it stands for
recommendations. Everywhere else it was decoration marking "this bit is clever",
which is the clearest sign of a generated interface, and it was replaced by an icon
that names the actual subject. If you need a glyph, name the thing — `ListMusic`
for a queue, `Mic` for lyrics, `Radio` for autoplay. Reach for `Sparkles` only if
the subject really is "recommended for you", and check whether that one use is
already taken.

**One documented exception:** the brand mark in the sidebar (`Disc3` on an accent
tile) is identity, not state. It is the only permanently-accent decoration in the
app, it appears once, and it never moves.

Budget: at most **one** accent-filled element per visual region. Everything else
uses `--accent-soft` + `--border-accent`, or accent-coloured text.

### Semantics — status only, never decoration

| Token | Value | When to use |
|---|---|---|
| `--danger` / `--danger-soft` | `#f28ba0` / `rgba(242,139,160,0.13)` | Destructive actions (delete playlist), playback errors, the window close button. |
| `--success` / `--success-soft` | `#86dcb4` / `rgba(134,220,180,0.13)` | Saved / synced / added-to-library confirmations. |
| `--warning` / `--warning-soft` | `#e8c48f` / `rgba(232,196,143,0.13)` | Degraded state: offline, stream fell back to a lower quality, token expiring. |
| `--info` / `--info-soft` | `#8fc7ff` / `rgba(143,199,255,0.13)` | Neutral notices, tips, "resolving stream…". |

Pattern for a status pill: `color: var(--danger); background: var(--danger-soft);
border: 1px solid var(--danger)` at 28 % alpha — or just use `.badge` and set
the two properties. Contrast as text on `--surface-2`: danger **7.36**, success
**10.59**, warning **10.44**, info **9.67** — all AA.

`--info` is the same value as `--accent` under the default palette. That is fine
for a notice, but it means **you cannot tell an info state from an active state by
colour alone** in the shipped theme — pair info with an icon or a word, never with
hue only.

### Source badges — recognisable hue, matte saturation

| Token | Value |
|---|---|
| `--badge-youtube-text` | `#f0908a` (**7.43** on `--surface-2`) |
| `--badge-youtube-bg` | `rgba(240,144,138,0.12)` |
| `--badge-youtube-border` | `rgba(240,144,138,0.26)` |
| `--badge-soundcloud-text` | `#f0a875` (**8.67** on `--surface-2`) |
| `--badge-soundcloud-bg` | `rgba(240,168,117,0.12)` |
| `--badge-soundcloud-border` | `rgba(240,168,117,0.26)` |

Use via `.badge` + a `data-source` attribute — the tinting is already wired:

```jsx
<span className="badge" data-source="youtube">YouTube</span>
<span className="badge" data-source="soundcloud">SoundCloud</span>
```

---

## 6. Radii, shadows, focus ring

**Radii are preset-driven — `theme.css` only holds the first-frame fallback.**
`presets.ts` writes `--radius-xs … --radius-lg`/`-xl` from each preset's `radius`
tuple as soon as the design store hydrates, so editing `theme.css` alone changes
what you see for one frame and nothing after. The values below are the default
preset (`island`, `DEFAULT_PRESET_ID`); `obsidian` runs as tight as `3px` and
`aurora` as loose as `36px`, and a user can override the whole ladder from the
shape picker. Never assume a specific pixel count in a component.

| Token | Default (`island`) | When to use |
|---|---|---|
| `--radius-xs` | `8px` | Badges, `.kbd`, tiny tags, colour swatches. |
| `--radius-sm` | `10px` | Buttons, icon buttons, menu items, list rows, inputs. |
| `--radius-md` | `14px` | Cards, panels, menus, dropdowns, the sidebar. |
| `--radius-lg` | `18px` | Large panels, album artwork, the queue drawer. |
| `--radius-xl` | `24px` | Modals, hero artwork, the fullscreen player. |
| `--radius-full` | `9999px` | Pills, chips, avatars, slider rails and thumbs. **Not** preset-driven: a circle stays a circle under every preset. |

Nesting rule: a child's radius should be the parent's minus roughly its padding.
A `--radius-md` card with `--space-3` padding takes `--radius-sm` children.

**A capsule inside a capsule is a mistake.** `--radius-full` is for shapes where
roundness carries meaning — an avatar, a slider thumb, a pill that reads as one
token. A pill-shaped chip sitting inside a pill-shaped group makes both look like
decoration; the inner element takes `--radius-sm` instead. See `.chip[role='radio']`
in `global.css`.

Shadows are neutral black at low alpha. **There is no coloured shadow in this
system** — if you find yourself wanting a glow, add a `--border-accent` edge.

| Token | Value | When to use |
|---|---|---|
| `--shadow-xs` | `0 1px 2px rgba(4,6,10,.26)` | Pressed card, slider thumb, tiny lifted chip. |
| `--shadow-sm` | `0 1px 3px rgba(4,6,10,.30), 0 3px 8px rgba(4,6,10,.22)` | Resting elevation for something that overlaps content slightly. |
| `--shadow-md` | `0 2px 6px rgba(4,6,10,.34), 0 10px 26px rgba(4,6,10,.30)` | Card hover lift, dropdown menus, popovers. |
| `--shadow-lg` | `0 6px 16px rgba(4,6,10,.40), 0 26px 60px rgba(4,6,10,.42)` | Modals, the queue drawer, toasts, the fullscreen player. |
| `--highlight-top` | `inset 0 1px 0 rgba(255,255,255,.06)` | **Stack it, never use it alone.** See below. |

The shadow tint is `rgba(4,6,10,…)`, not pure black: a dead-black shadow on a
slightly blue-rotated surface reads as a hole rather than as depth.

Each shadow is a tight contact layer plus a wide ambient one, so an element reads
as sitting *on* something instead of floating in front of a photograph.

`--highlight-top` is what makes a matte panel read as a physical slab rather than
a painted rectangle: a 1 px lit edge along the top, as if a light sat above the
window. `.panel-raised`, `.card` and `.card-interactive` already apply it. When
you write a `box-shadow` by hand on a floating surface, stack it last:

```css
box-shadow: var(--shadow-lg), var(--highlight-top);
```

### Focus ring

| Token | Value | Notes |
|---|---|---|
| `--ring-color` | `rgba(143,199,255,0.7)` | The accent at 70 % — a fully opaque ring on top of an accent-filled button disappeared into its own fill. |
| `--ring-width` | `2px` | |
| `--ring-offset` | `2px` | |
| `--ring-offset-color` | `var(--bg-base)` | **Override per container.** Inside a modal set `--ring-offset-color: var(--surface-4)` on the modal root. |
| `--ring` | 2-layer `box-shadow` | For elements that cannot show an `outline`. Applied by `.focus-ring`. |
| `--ring-inset` | `inset 0 0 0 2px var(--accent)` | For form controls; already applied to `input`/`textarea`/`select`. |

A global `:focus-visible { outline: 2px solid var(--ring-color); outline-offset: 2px }`
is already in place, so **you get a focus ring for free**. Never write
`outline: none` without providing `.focus-ring` or an equivalent.

---

## 7. Icons

Every icon is `lucide-react`. The library takes a `size` prop and writes it to
both `width` and `height`; **`strokeWidth` is expressed in viewBox units (24)**,
so the line you actually see is

```
rendered stroke = strokeWidth × size / 24
```

That formula is the whole problem. lucide defaults to `strokeWidth={2}`, so a
14 px icon draws a 1.17 px line and a 48 px icon draws a 4 px line — the same
glyph reads as a hairline in one place and as marker pen in another. Left alone,
this system had 21 distinct sizes and a stroke that swung from 0.83 px to
5.33 px.

Two things fix it, and you only have to remember the first one.

### The scale — `src/styles/icons.ts`

```jsx
import { ICON } from '../../styles/icons';

<Play size={ICON.md} aria-hidden="true" />
```

| Token | px | Pairs with | When to use |
|---|---|---|---|
| `ICON.xs` | 12 | — | Badges, inline meta, counters. |
| `ICON.sm` | 14 | `--control-sm` | Dense rows, window buttons, the mini player. |
| `ICON.md` | 16 | `--control-md` | **Default.** Toolbars, menus, list rows. |
| `ICON.lg` | 20 | `--control-lg` | Navigation, prev/next, section-heading glyphs. |
| `ICON.xl` | 24 | `--control-xl` | The play button in the player bar. |
| `ICON['2xl']` | 28 | `--control-2xl` | The play button in the fullscreen player. |
| `ICON.display` | 32 | — | The glyph of an `EmptyState`. |
| `ICON.hero` | 48 | — | Large artwork fallback (fullscreen, mini square). |

**Never invent a size.** A number that is not on this scale is the bug this
section exists to prevent — and odd values (13/15/17/19) are the worst of them,
because a non-integer scale of the 24-grid puts every stroke on a half pixel.

### The button pairs — `--control-*` in `theme.css`

A glyph and its hit target come from the same row of the table above, so a row of
controls reads as a row and the primary control reads as primary:

```jsx
<button style={{ width: 'var(--control-lg)', height: 'var(--control-lg)' }}>
  <SkipForward size={ICON.lg} />
</button>
```

| Token | px | When to use |
|---|---|---|
| `--control-sm` | `28px` | Window buttons, inline row actions, mini-player controls. |
| `--control-md` | `32px` | Default icon button — `<Button size="icon">` is already this. |
| `--control-lg` | `40px` | Navigation, prev/next, favourite in the fullscreen player. |
| `--control-xl` | `48px` | The play button in the player bar. |
| `--control-2xl` | `64px` | The play button in the fullscreen player. |

### The stroke ramp — `global.css` §7

lucide stamps `class="lucide"` and `width="<size>"` on every icon and sets
`strokeWidth` on **no** child node, so one CSS declaration on `svg.lucide`
inherits down the whole glyph and beats the presentation attribute:

```css
svg.lucide[width='16'] { stroke-width: 2.25; }
svg.lucide[width='48'] { stroke-width: 0.95; }
```

There is a rule for all 21 sizes the app has ever used, not just the eight on the
scale, so the ~200 call sites that were never migrated are optically correct too.
Rendered weight now stays inside **1.45–2.0 px** across the entire range. A size
with no rule simply behaves the way lucide ships it, which is the bug — hence
"never invent a size".

`svg.lucide` also carries `flex-shrink: 0` (otherwise a narrow flex row squashes
a circular glyph into an ellipse) and `vertical-align: -0.125em` (so an inline
icon sits on the text's x-height instead of below the baseline).

Custom SVG is exempt from the ramp unless you opt in: `SourceBadge` deliberately
does not, `RestoreIcon` in `Header.tsx` deliberately does — it is drawn on the
same 24 grid and carries `className="lucide"`, so it matches the `Minus` and `X`
next to it. If you hand-draw a glyph that sits beside lucide icons, do the same.

---

## 8. Motion

| Token | Value | When to use |
|---|---|---|
| `--dur-fast` | `150ms` | Colour, opacity, border-colour, background — anything non-geometric. |
| `--dur-normal` | `200ms` | Transform: hover lift, press scale, chevron rotation. |
| `--dur-slow` | `250ms` | Enter/exit of a whole surface: modal, drawer, toast, popover. |
| `--ease-out` | `cubic-bezier(.22,1,.36,1)` | Default. Everything that enters or reveals. |
| `--ease-in-out` | `cubic-bezier(.4,0,.2,1)` | Symmetric state changes and looping animations (`.eq-bar`, `.skeleton`). |
| `--ease-spring` | `cubic-bezier(.34,1.35,.64,1)` | Sparingly — a gentle overshoot on things that "pop in" (`.animate-pop-in`). |

### What animates

- `transform` and `opacity` — always prefer these; they are compositor-only.
- `background-color`, `border-color`, `color`, `box-shadow` on interaction.
- Never animate `width`, `height`, `top/left`, `filter` or `backdrop-filter`.
- Never transition `all`. List the properties.
- Nothing animates on first paint except explicit enter animations.
- No infinite decorative motion except: `.eq-bar` (playing indicator),
  `.skeleton` (loading), spinners, and `.marquee` (hover-only).

### Ready-made animations

`.animate-fade-in`, `.animate-slide-up`, `.animate-pop-in`,
`.animate-slide-left` (drawer), `.animate-spin`.
Keyframes available by name: `fadeIn`, `slideUp`, `slideDown`, `slideLeft`,
`popIn`, `spin`, `pulse`, `shimmer`, `marquee`, `eq-bounce`, `pulse-ring`.

### Reduced motion

Both files handle it. `theme.css` collapses `--dur-*` to `1ms` (so even inline
`transition: … var(--transition-fast)` in un-migrated components goes quiet) and
`global.css` clamps every `animation-duration`/`transition-duration` to `1ms`,
drops the skeleton shimmer, freezes the equaliser and disables the hover lift,
press scale and marquee. **You do not need to write a reduced-motion block.**
`1ms` rather than `0` is deliberate: `transitionend` still fires.

---

## 9. Layout, spacing, typography

Layout tokens — names are fixed by the contract; the shell reads them. The header
and the player bar are deliberately tight: 56 px and 84 px hand 14 px back to the
content and still clear what they hold (52 px artwork and a `--control-xl` play
button in the bar) with room to spare.

| Token | Value |
|---|---|
| `--sidebar-width-expanded` | `260px` |
| `--sidebar-width-collapsed` | `72px` |
| `--header-height` | `56px` |
| `--player-bar-height` | `84px` |
| `--queue-drawer-width` | `380px` |

Spacing — **every** gap, padding and margin comes from this scale:

| Token | Value | Typical use |
|---|---|---|
| `--space-1` | `4px` | Icon-to-label inside a badge. |
| `--space-2` | `8px` | Inside a control; gap between icon and text. |
| `--space-3` | `12px` | Control padding; gap between list rows. |
| `--space-4` | `16px` | Card padding; gap between cards. |
| `--space-5` | `24px` | Padding of a view container; gap between groups. |
| `--space-6` | `32px` | Gap between sections. |
| `--space-7` | `48px` | Section top margin; page gutters. |
| `--space-8` | `64px` | Hero spacing, empty-state breathing room. |

Stacking order: `--z-raised: 10`, `--z-sticky: 20`, `--z-header: 40`,
`--z-drawer: 60`, `--z-overlay: 80`, `--z-menu: 100`, `--z-modal: 9999`,
`--z-toast: 10000`, `--z-grain: 10001`.

### Type

`--font-sans: 'Onest Variable', 'Onest', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`.
`--font-mono: 'JetBrains Mono Variable', 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace`.
`--font-display` — a separate stack (`Unbounded Variable`) for headings only; it
is chosen in the typography settings, and it reads badly at small sizes.

Size, line height and tracking come in **triples**: as the size grows the line
tightens and the letters close up. `typographyVars` computes all three, and a user
scales the whole scale by a multiplier, so the pixel values below are the default
and not a constant.

| Size token | Default | Line height | Tracking | When to use |
|---|---|---|---|---|
| `--text-xs` | `11px` | `--leading-xs` 1.454545 | `--tracking-xs` `0.012em` | Badges, `.kbd`, timestamps, counts. |
| `--text-sm` | `13px` | `--leading-sm` 1.538462 | `--tracking-sm` `0.004em` | Secondary rows, menu items, chips, captions. |
| `--text-base` | `14.5px` | `--leading-base` 1.517241 | `--tracking-base` `0` | Body, track titles in rows, buttons. |
| `--text-lg` | `17px` | `--leading-lg` 1.411765 | `--tracking-lg` `-0.008em` | Card titles, emphasised track title. |
| `--text-xl` | `22px` | `--leading-xl` 1.272727 | `--tracking-xl` `-0.016em` | Section headings (`h3`). |
| `--text-2xl` | `29px` | `--leading-2xl` 1.172414 | `--tracking-2xl` `-0.022em` | View titles (`h2`). |
| `--text-3xl` | `38px` | `--leading-3xl` 1.078947 | `--tracking-3xl` `-0.030em` | Hero / fullscreen player title (`h1`). |

**The line-height numbers are ugly on purpose.** Each ratio is tuned so that
`size × leading` lands on a whole pixel (11→16, 13→20, 14.5→22, 17→24, 22→28,
29→34, 38→41). Line height sets the height of everything wrapped around text, so a
fractional result means buttons 27.5 px tall, borders of different thickness on
opposite edges, and slightly blurred glyphs. **The same rule lives in
`typographyVars` — a change has to happen in both places.**

Weights: `--weight-normal` 400, `--weight-medium` 500 (labels/buttons),
`--weight-semibold` 600 (headings, track titles), `--weight-bold` 700 (rare).
Always the token, never the digits: `designDrift.test.ts` fails a numeric
`fontWeight`, a hardcoded px `fontSize`, and mixing two type steps on one element.
Optical tracking is already applied to `h1`–`h4` and to `body`; use the
`--tracking-*` token whenever you set a `--text-*` size by hand.

Anything numeric that ticks (elapsed time, remaining time, counters) must carry
`data-numeric` — it switches to the mono stack with `tabular-nums` so digits do
not jitter:

```jsx
<span data-numeric>{formatDuration(currentTime)}</span>
```

---

## 10. Utility classes

All defined in `src/styles/global.css`. Use these instead of repeating inline
styles.

### Surfaces

**`.panel`** — structural chrome on the canvas: `--surface-1` + `--border-subtle` + `--radius-md`, no shadow.
```jsx
<aside className="panel">…</aside>
```

**`.panel-raised`** — anything that floats: `--surface-3` + `--border` + `--shadow-lg`.
```jsx
<div className="panel-raised" role="menu">…</div>
```

**`.panel-inset`** — recessed well: `--surface-sunken` + `--border-subtle`.
```jsx
<div className="panel-inset">No tracks yet</div>
```

**`.card`** — static content container: `--surface-2` + `--border-subtle` + `--radius-md`.
```jsx
<div className="card" style={{ padding: 'var(--space-4)' }}>…</div>
```

**`.card-interactive`** — clickable card. Hover lifts 2 px, steps to `--surface-3` and brightens the border to `--border-strong` with `--shadow-md`; active settles back. Selected via `aria-selected`/`data-selected`.
```jsx
<div className="card-interactive" aria-selected={isCurrent} onClick={play}>…</div>
```

**`.divider`** — 1 px `--border-subtle` rule; horizontal by default, vertical with `aria-orientation`.
```jsx
<hr className="divider" />
<span className="divider" aria-orientation="vertical" />
```

### Text

**`.text-truncate`** — single-line ellipsis, includes `min-width: 0` so it works inside flex rows.
```jsx
<span className="text-truncate">{track.title}</span>
```

**`.text-clamp-2`** — two-line clamp for descriptions.
```jsx
<p className="text-clamp-2">{playlist.description}</p>
```

**`.marquee`** / **`.text-scroll`** — hover-scrolls an overlong title with masked edges. Duplicate the text so the loop is seamless.
```jsx
<span className="marquee"><span>{title}</span><span aria-hidden="true">{title}</span></span>
```

**`.section-label`** — the heading of a group inside a panel, menu or settings section. **Use this instead of styling a label by hand.**
```jsx
<span className="section-label">Таймер сна</span>
```
It is deliberately *not* an eyebrow: no `text-transform: uppercase`, no wide `letter-spacing`. Caps-plus-tracking was on nearly every group in the app, and a stamped eyebrow repeated on every screen stops being a heading and becomes texture — while caps also break Cyrillic word shapes and cost real legibility at 11–13 px. A group heading should simply look like a heading: one step up from the caption, semibold, ordinary letters.

Two places keep uppercase on purpose, both because the *content* is uppercase rather than the style: the room-code input (the codes themselves are caps) and the `НЕ НАЙДЕН` marker in the support log (it mirrors a machine status string).

### Feedback and overlays

**`.grain`** — the film-grain overlay. Mount **once**, near the root of `AppShell`. Inline SVG `feTurbulence`, `--grain-opacity` 0.028, `mix-blend-mode: overlay`, `pointer-events: none`.
```jsx
<div className="grain" aria-hidden="true" />
```

**`.skeleton`** — loading placeholder with a shimmer that is removed under reduced motion. Caller supplies the size.
```jsx
<div className="skeleton" style={{ height: 48, borderRadius: 'var(--radius-sm)' }} />
```

**`.scrollbar-thin`** — 6 px scrollbar for dense inner lists (drawer, menus).
```jsx
<div className="scrollbar-thin" style={{ overflowY: 'auto' }}>…</div>
```

**`.focus-ring`** — opt-in `box-shadow` ring for elements that cannot paint an `outline` (clipped or `overflow: hidden` ancestors). The global `:focus-visible` outline covers everything else.
```jsx
<button className="focus-ring">…</button>
```

### Micro components

**`.kbd`** — keyboard hint chip for the shortcuts list and command palette.
```jsx
<kbd className="kbd">Ctrl</kbd><kbd className="kbd">K</kbd>
```

**`.badge`** — static label. Neutral by default; `data-source="youtube" | "soundcloud"` applies the source tint.
```jsx
<span className="badge" data-source="youtube">YouTube</span>
```

**`.chip`** — interactive pill for filters/sorts. Active state via `aria-pressed` or `data-active` ⇒ `--accent-soft` + `--border-accent`.
```jsx
<button className="chip" aria-pressed={active}>Tracks</button>
```
Its height is `min-height: var(--control-sm)` — off the control scale, **not** derived from the text metrics. Padding-plus-line-height produced 27.5…27.83 px, which is both a fractional edge (a border thinner on one side than the other) and under the 28 px minimum hit target. Padding still sets the width. A chip inside a pill-shaped group takes `--radius-sm` instead of `--radius-full`; see §6.

**`.menu-item-hover`** — full-width row inside a dropdown/context menu. Hover and `:focus-visible` both go to `--surface-hover` + `--text-primary`; `data-variant="danger"` turns the hover red.
```jsx
<button className="menu-item-hover">Play Next</button>
<button className="menu-item-hover" data-variant="danger">Remove</button>
```

**`.eq-bars` / `.eq-bar`** — the now-playing equaliser, three bars in `--accent`. Frozen at 70 % height under reduced motion.
```jsx
<div className="eq-bars"><span className="eq-bar" /><span className="eq-bar" /><span className="eq-bar" /></div>
```

**`.press`** — subtle tactile press: hover overlay plus `scale(0.94)` on `:active`. Ideal for icon buttons.
```jsx
<button className="press" aria-label="Play"><Play size={ICON.md} /></button>
```

### Base element styling (no class needed)

- `input`, `textarea`, `select` — `--surface-sunken` fill, `--border` edge,
  `--radius-sm`, `--text-faint` placeholder, `--ring-inset` on focus, custom
  `select` caret. Components that set `background`/`border` inline (the search
  field) keep their own look because inline styles win.
- `input[type=range]` (timeline + volume) — **the element itself is the rail.**
  Its height is `--range-track-height` (6 px), the native track is transparent,
  and the thumb (`--range-thumb-size`, 12 px) fades in on hover/focus. So paint
  the fill with a gradient on the element:
  ```jsx
  <input type="range" style={{ background:
    `linear-gradient(to right, var(--accent) 0 ${pct}%, var(--surface-active) ${pct}% 100%)` }} />
  ```
  Use `--range-track-height` for the buffered rail too so the two line up.
- `button` — reset plus `--radius-sm` and `:disabled { opacity: .42 }`.
- `::selection` uses `--accent-soft`.

---

## 11. Elevation guidance

Pick the row that matches the element. Border and shadow are not free choices —
they come with the surface.

| Element | Surface | Border | Shadow | Radius | Class |
|---|---|---|---|---|---|
| App canvas / view background | `--bg-base` | — | — | — | — |
| **Sidebar** | `--surface-1` | `--border-subtle` on the inner edge only | none | 0 (full-height) | `.panel` |
| **Header** | `--surface-1` | `--border-subtle` on the bottom edge | none | 0 | `.panel` |
| **Player bar** | `--surface-1` | `--border-subtle` on the top edge | none | 0 | `.panel` |
| Section well / empty state | `--surface-sunken` | `--border-subtle` | none | `--radius-md` | `.panel-inset` |
| **Cards** (playlist, album, result) | `--surface-2` | `--border-subtle` | none at rest, `--shadow-md` on hover | `--radius-md` | `.card` / `.card-interactive` |
| **Track rows** | transparent | none at rest | none | `--radius-sm` | `.card-interactive` or row styling |
| **Menus / dropdowns / popovers** | `--surface-3` | `--border` | `--shadow-md` | `--radius-md` | `.panel-raised` |
| **Queue drawer** | `--surface-3` | `--border` on the leading edge | `--shadow-lg` | `--radius-lg` on the inner corners | `.panel-raised` |
| Toasts | `--surface-3` | `--border` | `--shadow-lg` | `--radius-md` | `.panel-raised` |
| **Modals** | `--surface-4` | `--border` | `--shadow-lg` | `--radius-xl` | `.panel-raised` + override background |
| Modal scrim | `rgba(4,4,6,0.72)` | — | — | — | plain `div`, `--z-overlay` |
| Tooltips | `--surface-4` | `--border` | `--shadow-md` | `--radius-sm` | `.panel-raised` |
| Fullscreen player | `--bg-base` | — | — | — | — |

Notes:
- Full-bleed chrome (sidebar/header/player bar) gets **one** hairline on the edge
  that faces content, and **no** shadow — the surface step is the separation.
- A floating layer always gets a real border (`--border`, not `--border-subtle`)
  *and* a shadow. One without the other reads as a mistake in a matte system.
- Track rows are transparent at rest so a long list stays quiet; they only gain
  `--surface-hover` on hover and `--accent-soft` when selected.
- Set `--ring-offset-color` on modal and drawer roots to their own surface so the
  focus ring's inner gap matches.

---

## 12. Interaction states

Exact tokens for every state. Rows are cumulative — hover keeps the rest values
it does not override.

### Interactive surface (card, row, chip, menu item)

| State | Background | Border | Text | Extra |
|---|---|---|---|---|
| Rest | `--surface-2` (or transparent for rows) | `--border-subtle` | `--text-primary` / `--text-secondary` | — |
| Hover | `--surface-3` (cards) or `--surface-hover` (rows/menu items) | `--border-strong` | `--text-primary` | `translateY(-2px)` + `--shadow-md` on cards only |
| Active / pressed | `--surface-active` | `--border-strong` | `--text-primary` | `translateY(0)` + `--shadow-xs`, or `scale(.94)` with `.press` |
| Focus-visible | unchanged | unchanged | unchanged | `outline: 2px solid var(--accent)`, `outline-offset: 2px` |
| Disabled | unchanged | unchanged | `--text-faint` | `opacity: .42`, `cursor: not-allowed`, no hover/active |
| Selected / now playing | `--accent-soft` | `--border-accent` | `--text-primary`, title may use `--accent-hover` | `.eq-bars` in place of the index |

### Accent-filled button (primary action)

| State | Background | Text |
|---|---|---|
| Rest | `--accent` | `--text-on-accent` |
| Hover | `--accent-hover` | `--text-on-accent` |
| Active | `--accent-active` | `--text-on-accent` |
| Focus-visible | `--accent` | + ring as above |
| Disabled | `--accent` at `opacity: .42` | `--text-on-accent` |

### Ghost / icon button

| State | Background | Icon colour |
|---|---|---|
| Rest | transparent | `--text-secondary` |
| Hover | `--surface-hover` | `--text-primary` |
| Active | `--surface-active` | `--text-primary` |
| Focus-visible | transparent | + ring |
| Disabled | transparent | `--text-faint`, `opacity: .42` |
| Toggled on | `--accent-soft` | `--accent` |

### Form control

| State | Background | Border | Extra |
|---|---|---|---|
| Rest | `--surface-sunken` | `--border` | placeholder `--text-faint` |
| Hover | `--surface-sunken` | `--border-strong` | — |
| Focus-visible | `--surface-sunken` | `--accent` | `box-shadow: var(--ring-inset)` |
| Invalid | `--surface-sunken` | `--danger` | helper text `--danger` |
| Disabled | `--surface-1` | `--border` | text `--text-faint`, `cursor: not-allowed` |

Rules: hover never uses the accent. Selected/active always does. Disabled never
gets a hover response. Focus-visible is additive — it never replaces the hover
or selected look.

---

## 13. Migration — done

The "Obsidian Cyber-Glass" migration is **complete**. Both deprecated blocks are
gone: the alias tokens at the bottom of `theme.css` and the alias classes at the
bottom of `global.css`. Nothing in this document is an alias any more, so every
name below is the real name.

If you are reading an old branch, or a diff resurrects one of these, the
replacements were:

| Gone | Use |
|---|---|
| `--accent-cyan`, `--accent-violet`, `*-glow` | `--accent`, `--accent-soft`, `--border-accent` |
| `--accent-emerald` / `-rose` / `-amber` | `--success` / `--danger` / `--warning` (+ `-soft`) |
| `--bg-app`, `--bg-surface-*` | `--bg-base`, `--surface-*` |
| `--glass-bg-*`, `--glass-border-*` | on an app panel: `--surface-*`, `--border*`. On a layer floating over other content: `.glass` / `.glass-strong` (see §1). |
| `--shadow-neon-*` | `--shadow-sm` … `--shadow-lg` by elevation |
| `--text-inverse` | `--text-on-accent` |
| `--transition-*`, `--ease-smooth` | `var(--dur-*) var(--ease-*)` on named properties |
| `.glass-panel` / `.glass-card` / `.glass-elevated` | `.panel` / `.card-interactive` / `.panel-raised` |
| `.wireon-track-row` | `.card-interactive`, or plain row styling |
| `.truncate`, `.marquee-hover` | `.text-truncate`, `.marquee` |
| `.text-gradient-*`, `.glow-*` | `--text-primary`, or a `--border-accent` edge |
| `.spin-animation` | `.animate-spin` |

Still-live hooks that never had CSS of their own and are not aliases:
`.wireon-*`, `.window-controls`, `.window-btn`, `.minimize-btn`, `.maximize-btn`,
`.close-btn`, `.sidebar-nav-item`, `.sidebar-playlist-item`. They are
semantic/test hooks; their visuals come from inline styles. (`.quick-tag-chip` is
gone — it became `.chip`.)

### Regression check

Both of these must stay empty (the second one is written so it does **not** match
the live `.text-truncate`). Note that `glass-` is **not** in the first pattern any
more: `--glass-bg`, `--glass-blur`, `--glass-border` and `--glass-highlight` are
live tokens for floating layers — see §1.

```bash
grep -rE "var\(--(accent-cyan|accent-emerald|accent-violet|accent-rose|accent-amber|bg-app|bg-surface|shadow-neon|text-inverse|transition-|ease-smooth)" src
grep -rE "glass-panel|glass-card|glass-elevated|(^|[^-])\btruncate\b|marquee-hover|text-gradient|spin-animation" src
```

And this one catches an icon size that bypassed the scale in a file that has
already been migrated — it should only ever return artwork sizes (`40`, `132`,
`160` in `TrackCard.tsx`):

```bash
grep -rn "size={[0-9]" src/components/player src/components/layout src/components/search/TrackCard.tsx src/components/common/VolumeSlider.tsx
```

---

## 14. UI text

All user-facing text is **Russian only**. This section is part of the design
system because wording is the fastest way for an interface to start looking
machine-written, and because most of it is a layout problem: every extra sentence
is a box that has to be sized, spaced and read.

**No caption on a self-evident control.** A toggle labelled "Сохранять
прослушанное" does not need a line explaining that listened tracks get saved. If
the description restates the label or the section heading above it, delete it —
`description` is optional on `ToggleSetting` for exactly this reason. Two
phrasings of one sentence in a row read as filler, and filler is the tell.

**Say what to do, not what will happen.** An empty state's title already says
there is nothing here, so the second line has one job: the next action.
"Включите любой трек." — not "Включите трек — и полноэкранный режим оживёт".
Promises, personification ("оживёт", "тихо оседает на диске") and wistful
constructions about non-existent places are the register to avoid.

**One clause, no rhetorical dash.** Em-dashes setting up a flourish, colons
introducing a pun, "и" chaining two half-thoughts — cut them. Short beats clever:
"Скорее всего, он удалён." beats "Его удалили — или ссылка ведёт туда, где ничего
никогда не было".

**Two deliberate exceptions.**
- **Error messages and diagnostics keep their punctuation.** There the dash and
  the colon carry structure — cause, then consequence, then what to try. Do not
  compress them.
- **Scene vocabulary stays.** "slowed", "nightcore", "эквалайзер" are what these
  things are called by the people using them; translating or explaining them would
  be worse, not cleaner.

**No emoji, ever** — `noEmoji.test.ts` enforces it.

---

## 15. Narrow windows

**One breakpoint: `768px`.** No intermediate states. This is a desktop app in a
resizable window, not a site serving phones and tablets; a second breakpoint
doubles the number of layouts to keep honest for a size nobody runs.

At `768px` the sidebar leaves and `MobileNav` takes over. Two utilities in
`global.css` §20 handle the swap:

| Class | Effect |
|---|---|
| `.hide-on-mobile` | Visible normally, `display: none` under 768px. |
| `.show-on-mobile` | `display: none` normally, shown under 768px. |

`.show-on-mobile` cannot hardcode the shown `display` — one element needs `flex`,
another `inline-block` — so it reads `--show-on-mobile-display` (default `block`)
and the element supplies its own:

```jsx
<div
  className="show-on-mobile"
  style={{ '--show-on-mobile-display': 'flex', alignItems: 'center' }}
>
```

**Put the class on a wrapper if the component sets `display` inline.** A
stylesheet rule cannot beat an inline style, so `.show-on-mobile` on a root that
already carries `display: inline-block` does nothing at all. `UserProfile` is
exactly this case. The sidebar has the same problem in reverse: `.wireon-sidebar`
keeps its `display` and `width` in CSS *precisely* so the breakpoint can hide it.

**Nothing may exist only inside the sidebar.** When it leaves, anything it was
holding has to survive elsewhere — the account pill moves to the header, which is
why the header copy is `.show-on-mobile` rather than always-on.

### Phones: safe areas, and what the bar keeps

The 768px breakpoint was written for a resizable desktop window. A phone adds
two things a window never has, and both were missing until 2026-08-28:

**System insets.** `env(safe-area-inset-*)` is silently `0` unless the viewport
meta carries `viewport-fit=cover`; without it the header sits under the clock
and the nav under the gesture bar. The four values are read once into
`--safe-top` / `--safe-bottom` / `--safe-left` / `--safe-right` in `theme.css`
and used from there — never `env()` by hand. Two sources of one number drift,
and the drift shows up as a gap or an overlap between the player bar and the
nav, with nowhere to look.

**Real viewport height.** `100vh` on a phone is the window with browser panels
*expanded*, so the bottom of the app hangs below the screen. `--app-height` is
`100dvh` where the engine has it and `100vh` where it does not.

**The player bar is a different component under 768px, not a squeezed one.**
Eight controls plus artwork and a timeline do not fit in 360px — they overlap
each other and the nav. What stays: artwork, title, prev/play/next, and a
hairline progress readout. What goes: volume, tempo, lyrics, queue, spectrum,
mini-player, overflow, shuffle, repeat, autoplay. All of it already exists in
the fullscreen player, and the bar opens into it — that is the only thing that
makes hiding them honest.

Because the bar lays itself out inline, the swap is a `useMediaQuery` read in
JS, not a rule in `@media`: an inline `display` beats any stylesheet.

**`--player-bar-height` cannot be overridden at the breakpoint.** The design
preset writes it *inline* on `:root` (`designService.applyDesign`), and inline
beats `@media`. Anything that needs to reserve room under the bar reads
`--player-bar-space` instead — same value on desktop, 64px on a phone.

### Phones get a bigger type scale and bigger controls

The scale was drawn for a window at arm's length. A phone is held at thirty
centimetres but on a screen a quarter as wide, and the small steps go first:
measured at 375px, Settings alone had **148 elements set in 11px** and 42
buttons under 44px tall. That is what "everything is tiny" means concretely.

- **Type**: `NARROW_TYPE_FACTOR = 1.15`, applied inside `typographyVars` *before*
  the rounding, so the "size x leading lands on a whole pixel" invariant
  survives. xs 11 -> 12.5, base 14.5 -> 16.5, lg 17 -> 19.5. Bigger than that and
  headings start wrapping.
- **Controls**: `--control-sm/md/lg/xl` become 38/42/46/52 under the breakpoint.
  Icons keep their `ICON` sizes — what grows is the field around the glyph, not
  the glyph, so stroke weight stays consistent.
- **`.tap-target`** gives a bare icon button `min-width/height: var(--control-sm)`.
  An `ICON.md` glyph with `--space-2` padding is a 32px button: fine for a mouse,
  half of what a finger needs.
- **`--content-pad-x`** is `--space-4` on a phone. 32px of side padding is a
  sixth of a 375px screen given to emptiness while titles truncate.

The type factor is read from JS in `designService`, not from `@media`, for the
same reason as `--player-bar-height`: the design preset writes `--text-*`
**inline** on `:root`, and inline beats any stylesheet rule. `--control-*` is
the one size family the preset does *not* write, so that one is a plain media
query. A `matchMedia` listener re-applies the design when the window crosses the
breakpoint, otherwise a resized desktop window keeps the wrong scale.

Raising the scale also raised `MobileNav`: its labels are `--text-xs`, so its
content grew to 58px and `--mobile-nav-height` went 56 -> 62. That number is not
cosmetic — the player bar sits on it.

### Full-width menu rows and inline buttons are different things

`.menu-item-hover` carries `width: 100%` because it is a menu *row*. Putting it
on a small button inside a row makes that button eat the whole line and squeeze
its neighbours to zero: the account menu's "Проверить" sat on top of
"Синхронизация медиатеки" and the description below wrapped one word per line.
`.menu-item-inline` is the same hover treatment sized to its content.

### A row that cannot shrink must be allowed to wrap

`flexShrink: 0` on a group of controls is right on a wide window and fatal on a
narrow one: the group does not shrink, so it slides past the right edge — and
the scrolling region clips horizontally, so it is not merely cut off, it is
gone. `SettingRow`, `InfoRow` and the playlists header all lost controls this
way. Every such row wraps (`flexWrap: 'wrap'`), and the group additionally
carries `maxWidth: 100%` so a long value cannot outgrow its own line.

A row that is meant to stay on one line — the library tabs — scrolls instead:
`width: max-content`, `maxWidth: 100%`, `overflowX: auto`, plus
`.scroll-x-quiet` to keep the scrollbar from drawing a second line under it.

### Don't ship the same control twice

Two buttons with the same icon calling the same action in one window is not
redundancy, it is two things to keep in sync and one more object on screen. Both
of these were removed:

- the queue button in the header — the player bar already had one, with the same
  `toggleQueue`, the same glyph and the same count, a screen-height apart;
- the account pill in the header on wide windows — the sidebar footer has it, and
  both copies even shared a `data-testid`, so two elements answered to one name.

Before adding a control, check the command palette and the player bar. If it is
reachable there, it probably does not need a second home.
