---
name: macos-design
description: Use when designing, restyling or reviewing an app's interface to feel like macOS without copying it, or when choosing window, sidebar, toolbar, control, type, color, radius, spacing, glass or motion values. Covers Katana's own UI style and macOS 27 Golden Gate metrics.
---

# macOS design reference

Measured and sourced metrics for macOS 27 Golden Gate (shipped September 2026), the current release, plus how to turn them into a look of your own.

**Core idea:** macOS reads as macOS because of its proportions, hierarchy and restraint, not because of Apple's assets. Borrow the geometry and the discipline, keep your own identity.

## How far to trust each number

Every value carries a tag. Check it before treating a number as fact.

| Tag | Meaning |
|---|---|
| **[M]** | Measured from pixels in a real macOS screenshot here. Typically ±0.5 pt; JPEG colors ±3 levels |
| **[R]** | Measured using the traffic lights as a ruler, on a shot of unknown scale. ±1 to 2 pt |
| **[A]** | Published by Apple in the Human Interface Guidelines (HIG), as read October 2026 |
| **[P]** | Press or developer reports, not measured here |
| **[H]** | Sampled from Apple's HIG artwork (`~dark` images, around macOS 26), not a live macOS 27 screenshot |
| **[I]** | Inference or recommendation. A design choice, not a fact about macOS |

Light-mode [M] values come from one macOS 27 System Settings screenshot in the MacRumors article listed under Sources. Its 2 px per pt scale is an assumption: it fits a 64 px row pitch and a window about 723 pt wide, but nothing independent confirms it, so every [M] size could be off by the same small factor. No measurement was taken on a physical Mac.

## What changed: Tahoe 26 to Golden Gate 27

macOS 27 walked back the parts of Tahoe people disliked. **Copy 27, not 26.** [P; Apple's macOS page confirms uniform toolbars, edge-to-edge sidebars, updated window shapes and better contrast]

| Area | Tahoe 26 | Golden Gate 27 |
|---|---|---|
| Sidebar | Floating glass, inset from the window | Edge to edge, attached, darker for contrast |
| Sidebar icons | Mostly monochrome | Colored again |
| Toolbar | Floating, ghostly buttons | Uniform; buttons more defined, sometimes a real bar |
| Window radius | Varied per app and per toolbar | One radius, smaller |
| Glass | Very clear, poor contrast | More opaque, darkened edge, brighter highlights, user slider |
| Active window | Hard to tell | Clearer, through sidebar, opacity and shadow |

**Lessons to keep:** large radii cost usable corner space and resize targets. "Big" here means beyond about 16 pt. On Tahoe about 75% of the 19×19 px corner resize area lay outside the visible window ([Heger](https://noheger.at/blog/2026/01/11/the-struggle-of-resizing-windows-on-macos-tahoe/)).

## Window [M]

| Property | Value |
|---|---|
| Corner radius | **15.3 pt** (circle fit, 0.24 px error); forum reports say 16. Use 16 |
| Traffic light diameter | **13.6 pt**, about 14 |
| Traffic light spacing | **23 pt** center to center |
| Red light center | **26 pt** from the left, **26 pt** from the top |
| Toolbar band height | about 52 pt (lights and title share a center line at 26 pt) |
| Light colors, active | `#fd5c5f` `#f9c802` `#35c75c` (sampled) |
| Light color, inactive | `#c8cbd0` light mode; `#4e4d4b` dark mode |
| Inactive title | `#aaaaaa` versus `#2e2e2e` when active |
| Inactive selection | `#ececec` gray, versus accent when active |

Three states [A]: **key** (takes input; colored lights), **main** (front window but not key; gray lights), **inactive** (gray lights, no vibrancy). If you draw custom chrome, you must draw these states yourself.

With custom chrome, make the resize target overlap the visible corner, inside the window as well as outside it. [I]

## Sidebar

| Property | Value | Tag |
|---|---|---|
| Width | **214 pt** in System Settings; about 223 in Shortcuts | M, R |
| Row pitch | **32 pt** | M, R |
| Selected row | **195 × 32 pt** | M |
| Selection inset | **10 pt** each side | M |
| Selection radius | **7.3 pt** | M |
| Selection color | `#0071f5`, white text | M |
| Icon size | about **21 pt** | M |
| Icon to label gap | about 10 pt | M |
| Search field | 195 × **28 pt**, full capsule | M |

Row height, text and icon size scale with the user's sidebar size setting (small, medium, large) [A]. Let people hide it; don't put critical actions at the bottom, since windows get dragged off screen [A].

## Toolbar and content

| Property | Value | Tag |
|---|---|---|
| Back/forward capsule | 69 × **36 pt** | M |
| Round toolbar button | about **36 pt** | R |
| Gap from sidebar edge to first control | 8 pt | M |
| Title | about 15 pt semibold, `#2e2e2e` (size estimated from letter height) | M |
| Content card inset | **20 pt** left and right | M |
| Card top | about 64 pt below the window top | M |
| Card radius | **9.7 pt**, use 10 | M |
| Card fill | `#f7f7f7` on `#ffffff`: a 3% step, no border, no shadow | M |
| Inner divider | hairline, about 1 pt, inset to the card's padding | M |
| Slider fill height | 6 pt | M |
| Color swatch | about 23 pt dia, 36 pt pitch | M |
| Finder list row | about 20 pt, alternating row fill | R |
| Shortcuts list row | about 34 pt, with separators | R |

Toolbars [A]: leading area for navigation, center for common items, trailing for search and inspectors. Prefer symbols to words. Every toolbar command must also be in the menu bar, since toolbars can be hidden.

## Control and spacing rules [A]

- **Control size:** default **28×28 pt**, minimum **20×20 pt**.
- **Padding around controls:** about **12 pt** with a bezel, about **24 pt** without.
- **Contrast:** text up to 17 pt needs **4.5:1**. 18 pt and up, or any bold text, needs **3:1**. Check both appearances.
- **Concentric corners:** nested shapes should share a center. `inner radius = outer radius − padding between them`. Check: window 16 − inset 10 ≈ selection 7 [I, fits M].
- **Trailing ellipsis** on a button that opens another window or view ("Add a folder…").
- **Switch** for emphasized or group settings; **checkbox** for lists and hierarchies; **radio** for 3+ exclusive options. None of these in a toolbar.
- **Segmented control** for switching in toolbars or inspectors; **tab view** in the main body.
- **Sheet:** rounded card over a dimmed parent; always modal to its window. Use a panel if people must see results while working. **Popover** arrow points at what opened it.
- **Menus:** title-style capitalization.
- Also: full keyboard support, tooltips on hover, resizable and hideable panes.

## Typography [A]

SF Pro in macOS. **13 pt is body**, far smaller than iOS. No Dynamic Type on macOS.

| Style | Weight | Size / line (pt) | Emphasized |
|---|---|---|---|
| Large Title | Regular | 26 / 32 | Bold |
| Title 1 | Regular | 22 / 26 | Bold |
| Title 2 | Regular | 17 / 22 | Bold |
| Title 3 | Regular | 15 / 20 | Semibold |
| Headline | Bold | 13 / 16 | Heavy |
| Body | Regular | 13 / 16 | Semibold |
| Callout | Regular | 12 / 15 | Semibold |
| Subheadline | Regular | 11 / 14 | Semibold |
| Footnote | Regular | 10 / 13 | Semibold |
| Caption 1 | Regular | 10 / 13 | Medium |
| Caption 2 | Medium | 10 / 13 | Semibold |

Minimum legible: 13 pt default, 10 pt smallest.

SF tracking in pt [A], `size:tracking`: 10:+0.12 11:+0.06 12:0 13:−0.08 14:−0.15 15:−0.23 16:−0.31 17:−0.43 20:−0.45 22:−0.26 26:+0.22. These are tuned for SF only; don't apply them to another font.

**Font license:** Apple licenses SF Pro for Apple platforms only, so it can't ship in a Windows app. As quoted on [Apple's developer forums](https://developer.apple.com/forums/thread/127350), the terms also bar using it for mock-ups of software on non-Apple systems; the license text itself is on [developer.apple.com/fonts](https://developer.apple.com/fonts/). Use this stack: `-apple-system, BlinkMacSystemFont, "Inter Variable", ...`. It shows real SF on a Mac and [Inter](https://rsms.me/inter/) (OFL-1.1) elsewhere, the usual free stand-in.

## Color

System colors [A], default light / default dark:

| Name | Light | Dark |
|---|---|---|
| Red | 255,56,60 | 255,66,69 |
| Orange | 255,141,40 | 255,146,48 |
| Yellow | 255,204,0 | 255,214,0 |
| Green | 52,199,89 | 48,209,88 |
| Mint | 0,200,179 | 0,218,195 |
| Teal | 0,195,208 | 0,210,224 |
| Cyan | 0,192,232 | 60,211,254 |
| Blue | 0,136,255 | 0,145,255 |
| Indigo | 97,85,245 | 109,124,255 |
| Purple | 203,48,224 | 219,52,242 |
| Pink | 255,45,85 | 255,55,95 |
| Brown | 172,127,94 | 183,138,102 |

Surfaces:

| Surface | Light [M] | Dark [H] |
|---|---|---|
| Content | `#ffffff` | `#1e1e1e` |
| Sidebar | `#eeecef` | `#262626` |
| Card | `#f7f7f7` | not measured |
| Toolbar button | not measured | `#333333` |
| Primary text | near `#000000` | `#dddcdd` |
| Secondary text | `#6b6b6b` | `#7a7a7a` (fails 4.5:1 on these surfaces; use about `#a4a8ac` [I]) |

Gray ramp, dark [A, iOS table]: `#8e8e93` `#636366` `#48484a` `#3a3a3c` `#2c2c2e` `#1c1c1e`.

**Rules:** neutral gray dominates and color is scarce: selection, accent, status and sidebar icons. Never use color alone to carry meaning. Provide an increased-contrast option.

## Glass and depth [A unless tagged]

- Two layers: **content** below, **controls and navigation** above. Glass belongs only on the upper layer. **Never glass in the content layer**, and never glass on glass.
- Use it sparingly: the most important navigation only.
- Glass has no color of its own; it picks up what's behind it. Tint rarely, for a primary action.
- Golden Gate's version: stronger diffusion, a **darkened edge**, **brighter specular highlight** [P].
- Let content run beneath sidebars and toolbars, and fade or obscure content scrolling under a bar (the scroll edge effect).
- Offer a clear-to-opaque choice, as System Settings does. Readability beats translucency.

CSS approximation [I]:

```css
.glass {
  background: rgba(30, 30, 30, 0.55);
  backdrop-filter: blur(24px) saturate(160%);
  border: 0.5px solid rgba(255, 255, 255, 0.12);     /* specular edge */
  box-shadow: inset 0 0.5px 0 rgba(255, 255, 255, 0.18), /* top highlight */
              0 0 0 0.5px rgba(0, 0, 0, 0.35),        /* darkened edge */
              0 8px 28px rgba(0, 0, 0, 0.35);
}
```

`backdrop-filter` repaints when anything behind it moves, so over an animated background keep glass panes few and small, and measure them.

## Motion [A]

Motion must be purposeful and optional. Keep feedback brief and precise. Avoid motion on frequent actions. Never make people wait for an animation; let them interrupt it. Respect Reduce Motion. Apple publishes no durations or curves for macOS, so the timings below are measured from recordings, not specified by Apple.

### Motion, measured [M]

Measured frame by frame on macOS 27 Golden Gate, November 2026, from two third-party 60 fps screen recordings by one creator (`KXPbf8T5GM0` and `VhNhgBcpykk` on YouTube). Size came from the object's edges, opacity from comparison with the settled frame, sheet position from template matching.

How far to trust it: one frame is 16.7 ms, so times are good to about that. Recordings sometimes repeat a frame. No Mac was available, so real-time playback could not be proven, only that the cursor moves smoothly and the recordings agree. Sizes are in video pixels, so use them as ratios.

| What | Measured | Samples |
|---|---|---|
| Menu or popover opens | Spring: response 0.29-0.31 s, damping 0.81-0.84. Starts near scale 0 at the anchor. From the first visible frame: 1.2% over at about 190 ms, at rest by about 370 ms. The fitted spring starts 45-70 ms earlier, so on an animation's own clock that is about 260 and 440 ms. Content scales with it, no reflow. Opaque within about 120 ms | 3 (fit error under 1%) |
| Popover closes | About 133 ms. Shrinks toward the anchor while fading; under 20% of its width when last visible | 2 |
| Menu chosen from | Shrinks and fades in about 75 ms | 1 |
| Menu-bar item menu closes | Fade only, no scale, about 200 ms, fast then slowing | 1 |
| Moving between open menus | Hard cut | 2 |
| Menu item highlight | Instant: jumps between frames | 3 |
| Sheet opens | Moves down about 36 px on a 460 px sheet (7.6%), width unchanged, no overshoot seen. Ease-in-out fits best at 280-300 ms, part of it before the first visible frame. Body opaque after about 150 ms, near linear. Dim near linear, about 250 ms | 2 |
| Sheet closes | Mirrors it: moves back up, ease-in-out fits best at about 300 ms; fades near linear in about 250 ms; no scale | 1 |
| Toggle turned on | Track colour mostly done in about 100 ms, small tail to about 300 ms. Thumb at rest by about 230 ms. Thumb is larger and glassy while pressed and moving | 1 |
| Page change inside a window | Hard cut, one frame | 2 |
| Window closes | Pure fade, about 100 ms, no scale | 1 |
| Spotlight bar opens | Appears at once about 8.6% too wide, settles to size in about 117 ms | 1 |

What the numbers say: what floats springs out of its source and leaves faster than it came. What belongs to a window slides and fades with no bounce. Frequent actions don't animate at all. Exits take a quarter to a half of the entrance.

Not established: the toggle's damping (values from 0.6 to 1.0 fit the visible part about equally, and the cursor covers it). Ease-in-out only narrowly beats the other curves for sheets, by under a pixel. One spring per element is an inference from three samples, not Apple's stated design.

Not measured, no clean sample found: sidebar collapse, list reorder, new messages arriving, button press, window open, minimize. Use your own judgement there and say so.

In CSS, `linear()` carries a real spring curve and can go over 1. Sample the step response with `w = 2*pi/response`. A scale entrance on a popup breaks any code that reads its drawn size, so place it first.

## Making it your own, not a clone

Copy these: proportions, hierarchy, 13 pt density, concentric corners, restraint, window states.

Do not copy these: SF Pro, SF Symbols, Apple's app icons, its wallpapers, its exact accent, or the exact traffic-light look if you want to be distinct. Keep at least two signature elements nobody would mistake for Apple's.

## Applying this to Katana

Katana's current values, read from `src/renderer/styles.css`, against targets [I]:

| Token | Katana now | macOS 27 | Suggested |
|---|---|---|---|
| UI font | Geist Mono everywhere | SF Pro | **Inter** for UI (SF on a Mac); Geist Mono for code and terminal |
| Body size | 12 px | 13 pt | 13 px |
| Window/panel radius | 10 px | 16 | 14 to 16 px |
| Row radius (`--r`) | 6 px | 7.3 | 7 px |
| Small radius (`--r-sm`) | 4 px | n/a | 5 px |
| Sidebar width (`--side`) | 257 px | 214 to 223 | 224 px (task titles need the room) |
| Sidebar row | 38 px, 12 px bold | 32 pt, 13 regular | 32 px, 13 px regular |
| Row inset | none (full width) | 10 pt | 10 px |
| Selection | outline border | solid fill | frosted white glass (the user's choice) |
| Toolbar height | 44 px | about 52 pt | 52 px |
| Toolbar control | small icons | 36 pt | 32 to 36 px |
| Lights | 12 px, gap 8 (center 20) | 14, center 23 | keep 12 to 14; center line = toolbar's |
| Prompt bar radius | 6 px | capsule fields | 10 to 14 px |
| Prompt bar fill | hard 1.5 px border | soft fill | soft fill, 1 px hairline |
| Panels | separate floating, outlined | attached sidebar, edge to edge | decide: see below |

**Katana's signatures to keep:** live night scenes and custom backgrounds, the mono voice for code and metadata, the shining status dot, the Katana face, and frosted white glass for selection instead of Apple's solid blue.

**Built:** this is implemented as the `macos` style in `src/renderer/macos.css` (Settings > Look > Style). Change that file rather than `styles.css`. It attaches the sidebar edge to edge, as macOS 27 does.

**Constraints here:**
- By the user's choice: no full-area tints over the scene, and nothing tinted black. Surfaces are white tints, blurred where possible. Words get contrast from a text shadow, so very light backgrounds are the weak case.
- `backdrop-filter` can't blur the scene inside `.stage`, because its `mask-image` starts a new backdrop root. Chat bubbles and buttons are white tint without blur.
- Treat 1 pt as 1 CSS px. Windows display scaling then applies on its own.
- Windows has no system vibrancy, so glass is `backdrop-filter`. Check `node scripts/stress.mjs` after adding any.

## Review checklist

1. Body text is 13 px with one proportional UI font; mono only where it means code.
2. Only a few sizes and two or three weights are in use.
3. One window radius; nested corners follow `inner = outer − padding`.
4. Sidebar rows are 32 px with an inset, rounded selection.
5. Controls are at least 20 px, 28 px by default, with 12 to 24 px around them.
6. Cards step about 3% from their background, with no heavy border or shadow.
7. Color appears only on selection, accent, status and sidebar icons.
8. Glass only on navigation, never stacked, never on content.
9. Active and inactive windows look different.
10. Text passes 4.5:1 over the brightest and darkest backgrounds in use.
11. Motion is short, interruptible and off under Reduce Motion.
12. At least two elements could only be Katana.

## Common mistakes

- Copying Tahoe's floating glass and big radii, which Apple itself rolled back.
- Using iOS sizes (17 pt body, 44 pt controls) on a desktop.
- Using the 28 to 64 pt size table on HIG's [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) page, which is for visionOS.
- Blurring everything: glass stacked on glass, or glass over text.
- Applying SF's tracking table to another font.
- Treating a [R] or [P] number as exact.

## Measuring more

Known gaps: dark mode on macOS 27 itself, dark card color, the size of menus, popovers and sheets, heights of push buttons and text fields, shadow values, and the animations listed as not measured under Motion. On a Mac, read real frames with `standardWindowButton(_:)` and take retina screenshots.

Without a Mac:

- **Render pages:** HIG needs JavaScript, so use a real browser (headless Electron works) and read `document.body.innerText`.
- **Tables:** HIG color swatches are images, so read each cell's `img.alt`.
- **Dark art:** add `~dark` to HIG image names: `window-states~dark@2x.png`.
- **Ruler:** on a shot of unknown scale, `px per pt = traffic-light center spacing in px ÷ 23`. Both 23 and the 32 pt sidebar pitch come from the same capture, so agreement shows consistency, not proof.
- **Radius:** take edge pixels of the curve and least-squares fit a circle. Report the fit error.
- **Scale check:** never trust an `@2x` filename: Apple's `window-states@2x.png` works out to about 1.2 px per pt, assuming the same 23 pt light spacing.

## Sources

- Apple HIG: [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos), [Typography](https://developer.apple.com/design/human-interface-guidelines/typography), [Color](https://developer.apple.com/design/human-interface-guidelines/color), [Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Windows](https://developer.apple.com/design/human-interface-guidelines/windows), [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars), [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars), [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), [Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- Apple: [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), [macOS 27 page](https://www.apple.com/os/macos/)
- Measured screenshot: [MacRumors, All the Liquid Glass Changes in macOS Golden Gate](https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/)
- Comparisons: [Six Colors review](https://sixcolors.com/post/2026/09/macos-27-golden-gate-review-bridging-the-tahoe-gap/), [Michael Tsai, Tahoe Window Corners](https://mjtsai.com/blog/2025/10/16/tahoe-window-corners), [Norbert Heger on resizing](https://noheger.at/blog/2026/01/11/the-struggle-of-resizing-windows-on-macos-tahoe/)
