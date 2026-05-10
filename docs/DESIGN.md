# tir — design system reference

> The single source of truth for tir's voice, palette, type, motion,
> and component patterns. Visual identity is **distinct from humm**:
> humm is warm, relationship-quiet, Wes-Anderson; tir is dark,
> arcade-fast, electric. One studio (`aaam.dev`), two attitudes.

**Sister docs:** [`AGENTS.md`](../AGENTS.md) ·
[`BLUEPRINT.md`](../BLUEPRINT.md) ·
[`DEVELOPER_GUIDE.md`](./DEVELOPER_GUIDE.md) ·
[`APPS_AND_FEATURES.md`](./APPS_AND_FEATURES.md)

This doc is **citation-driven**. Every claim points at a primary
platform doc (Apple HIG, Material 3), recognised research source
(NN/g, Laws of UX, WCAG), or recent industry analysis. Sources are
linked inline.

---

## 1. Voice

- **lowercase by default**, like humm. studio-wide.
- **fast, terse, bodily**. "tap to start", "you're up", "3", "first
  to ocean". no flourish.
- **the word is the speaker**. screens speak through the hero word,
  not through paragraphs.
- **second person only** when we have to address the player —
  "your word", "your move", "you finished 2nd". never "the user".
- **microcopy length budgets:** button labels ≤ 2 words. section
  labels ≤ 4. body sentences ≤ 12 words. Source: NN/g microcopy
  research, https://www.nngroup.com/articles/consistency-and-standards.
- **"one term per concept"**. "round" never becomes "match" or
  "game". "target" never becomes "goal" or "objective".
  Source: NN/g Heuristic #4 (Consistency & Standards).

The voice is *not* humm. humm is musical, intimate, cooperative. tir
is the call-out, the timer, the scoreboard. lowercase but louder.

---

## 2. Color

### Philosophy

Dark canvas, electric accent, restrained chrome. Per the 2026 review
of arcade-style game palettes
([Lemon Web Solutions, 2026](https://www.lemon-web.net/lemon-blog/designs-artworks/why-arcade-style-gaming-interfaces-still-favour-dark-palettes)):

> "Dark backgrounds recede unused space, making central content
> appear stronger without extra decoration… Cyan is particularly
> popular for competitive gaming because it feels digital and sharp
> without overwhelming the composition."

Apple HIG's color rule for interactivity holds: **one key color**
drives every interactive surface so the eye learns where to look.
Source: Apple HIG Color, https://developer.apple.com/design/human-interface-guidelines/color.

### Token table (proposed v0)

Three accent variants. Pick one for v0; the rest become "later
seasons".

| Token | Hex | Use |
|---|---|---|
| `bg` | `#0B0B12` | canvas — warm near-black, OLED-friendly. Half-step from cool-tir toward the aaam.dev family (2026-05-10 hybrid shift). |
| `surface` | `#13141F` | elevated panels, the round card |
| `card` | `#191B29` | inner cards, the option chips |
| `border` | `#28293B` | default chrome dividers |
| `text` | `#F7F7F7` | primary text — neutral off-white |
| `muted` | `#9D9EAE` | secondary text, roster lines |
| `dim` | `#686A80` | tertiary, micro-labels |
| `accent` | **#00E5FF** *(electric cyan)* | global interactive accent — primary CTA, your-word border, finish-window pulse |
| `accent-soft` | `rgba(0,229,255,0.10)` | tinted backgrounds for selected states (M3 state-layer parity) |
| `success` | `#7CFFB2` | "you reached target", round-advance toast |
| `warning` | `#FFD56B` | finish-window banner |
| `danger` | `#FF6B6B` | error states |
| `gold` | `#FFD24A` | rare reveals (boss target, photo-finish) |

**Alt accent options to swap into `accent` if cyan reads too
"developer-tool":**

- `#A1FF4C` (lime — louder, more "arcade")
- `#FF66B2` (hot pink — playful, leans Y2K)
- `#9B7BFF` (electric violet — calmer, dignified competitive)

**OLED rule**: `bg` is intentionally near-black, not pure black, to
avoid the perceived "smear" on OLED panels during fast UI changes.
Source: KB §Color & Dark Mode, citing iOS HIG Dark Mode.

**P3 wide gamut**: declare `display-p3` for the accent on iOS — the
cyan reads ~25% more saturated without banding on supported devices.
Source: KB §Color & Dark Mode.

**Color is never the only signal.** Selected option = accent border
*and* a 1.04× scale *and* haptic. Every state change has a non-color
cue. Source: WCAG 2.2 SC 1.4.1.

---

## 3. Typography

### Stack

- **iOS:** SF Pro (system). Large display sizes use SF Pro Display.
- **Android:** Roboto Flex (variable). Use the **`wght`** axis to
  animate weight transitions instead of cross-fading two static
  weights. Source: Material 3 Typography,
  https://m3.material.io/styles/typography/overview (M3 Expressive,
  Jan 2026 update).
- **Numerals:** always `tabular-nums` (`fontVariant:
  ['tabular-nums']` on RN; `.monospacedDigit()` on SwiftUI). Elo,
  countdown, round number, roster word lengths all change in place.
  Non-tabular figures jitter, which reads as "broken" on a fast
  game timer. Source: KB §Typography.
- **`maxFontSizeMultiplier`** capped per text token (see below) so
  Dynamic Type up to AX5 reflows but does not break the HUD layout.
  Source: Apple HIG Typography,
  https://developer.apple.com/design/human-interface-guidelines/typography.

### Scale

| Token | Spec | Use |
|---|---|---|
| `display-hero` | 64–72 / 700 / -0.03em / leading 1.0 | the hero word (current / chosen / target) — animates |
| `display` | 36 / 700 / -0.02em | screen titles, league name |
| `title` | 20 / 600 / -0.01em | nav titles, card headings |
| `option` | 22 / 700 / 0 | option chip text |
| `body` | 15 / 400 / leading 22 | secondary copy |
| `meta` | 12 / 500 / 0.06em uppercase | section labels, "round 7", "target" |
| `numeric` | 17 / 600 / tabular-nums | Elo, countdown, roster |
| `micro` | 11 / 500 | toasts, tertiary metadata |

**Hero-word rationale**: per the 2026 kinetic-typography trend
(KB §Mobile UX Trends, citing
https://www.3str.net/blog/kinetic-typography-in-web-design), the
chosen word should *be* the moment — scale, color brighten,
optional letter-spacing settle. We size the hero generously so it
has room to breathe and to animate without crowding the options grid.

**Variable-font animation**: if budget allows in Phase 1, animate
the hero word's `wght` axis from 600 → 800 over the round-advance
transition. This is M3 Expressive's "emotional weight as motion"
pattern. iOS RN supports `fontVariationSettings` on iOS 16+.

---

## 4. Spacing + radius

8 pt grid. (Apple HIG; M3 baseline.)

| Token | px |
|---|---|
| `space-1` | 4 |
| `space-2` | 8 |
| `space-3` | 12 |
| `space-4` | 16 |
| `space-5` | 24 |
| `space-6` | 32 |
| `space-7` | 48 |
| `space-8` | 64 |
| `radius-sm` | 8 |
| `radius-md` | 14 |
| `radius-lg` | 22 (option chips, hero card) |
| `radius-xl` | 28 (HUD shells) |
| `radius-pill` | 999 |

- Page horizontal padding: **`space-5`** (24).
- Inner card padding: **`space-4` × `space-4`** (16/16) or
  `space-5` × `space-5` (24/24) for the round card.
- Tap-target minimum: **44×44 pt** on iOS, **48×48 dp** on Android.
  Spacing between adjacent targets ≥ **8 pt**. Source: Apple HIG
  Buttons,
  https://developer.apple.com/design/human-interface-guidelines/components/menus-and-actions/buttons,
  WCAG 2.5.5 (target size).

---

## 5. Layout — the gameplay HUD (the screen that matters)

This is the only screen that has to be *perfect*. Everything else
serves it.

### Information hierarchy: target > options > current

> **The current word is the past. The target is the future. The
> options are the present.**

The cognitive flow during a round is `where am I going? → what
choices do I have? → where am I now?` The current word has near-zero
decision value once you've moved — your eye tracks options against
the target. Therefore:

1. **Target word — Tier 1, the persistent hero**, top of screen,
   ≥ 56 pt display, accent border + accent glow. The "always-visible
   action" anchor (Yu-kai Chou's Always-Visible Action Rule).
2. **Options grid — Tier 1, the action zone**, bottom ~45–50% of
   screen, 2×2, chunky chips ≥ 80 pt high. Lives in the green thumb
   zone (Bottom-First Architecture).
3. **Current word — Tier 2, retroactive context**, a small
   `body`-sized chip ("from forest") just above the option grid. NOT
   a hero. Provides "ah, that's why these options" without competing
   for attention.
4. **Status (round, players, moves) — Tier 4 ambient**, micro-meta
   in a thin top bar.

Source: Apple HIG Game UI tiers (Critical / Important / Informational /
Ambient — Sunstrike 2026); NN/g Heuristic #6 (recognition over
recall); Yu-kai Chou Always-Visible Action Rule
(https://yukaichou.com/product-gamification/why-users-quit-onboarding-always-visible-action-rule/).

### Layout (portrait, top-to-bottom)

Numbers in the gutter mark thumb zones from the 2026 Bottom-First
Architecture review
([dailylearningnews 2026](https://dailylearningnews.framer.website/blog/mobile-ux-large-screen-flagship-devices-2026)).

```
┌─────────────────────────────┐  ◀ status bar (system)
│ ← home   round 7 · 4 online │  ◀ top status — Tier 4 ambient
│                             │       micro-meta only
│                             │
│  ┌───── TARGET ─────────┐   │  ◀ Tier 1 hero — top "red zone"
│  │                      │   │       accent border + accent glow
│  │       OCEAN          │   │       56pt display, breathing room
│  │                      │   │
│  └──────────────────────┘   │
│                             │
│       from forest           │  ◀ Tier 2 breadcrumb — "yellow zone"
│                             │       small chip, dim/muted color
│                             │
│   ┌────────┐  ┌────────┐    │
│   │  tree  │  │  river │    │  ◀ Tier 1 action — "green zone"
│   │        │  │        │    │       chunky chips ≥ 80pt high
│   └────────┘  └────────┘    │       2×2 grid, both rows under
│                             │       resting thumb arc
│   ┌────────┐  ┌────────┐    │
│   │  leaf  │  │  shadow│    │
│   │        │  │        │    │
│   └────────┘  └────────┘    │
│                             │
│ 🐺 1200 silver  ●●●●  🔥 5  │  ◀ ambient stats bar (micro)
└─────────────────────────────┘  ◀ home indicator safe area
```

Notes:

- **Target is the persistent always-visible action context.** It is
  the only reason every option pick happens. It earns the hero
  treatment; the current word does not.
- **The 4-option grid is a 2×2.** A single column of 4 forces the
  thumb to travel; a 2×2 keeps every chip in the same press radius,
  with both rows under the resting thumb.
- **Picking an option reveals via container transform at small
  scale**: the pressed chip's text glides into the breadcrumb
  position over ~280 ms. The other 3 chips fade and refill. The
  *target* stays put. Source: M3 motion research,
  https://m3.material.io/blog/motion-research-container-transform.
- **Round-advance is the only place the hero kinetic typography
  fires** — and it fires on the *target* card (drop+rise+spring),
  not on a per-move basis. Reserves the peak for what matters.
  Source: NN/g peak-end rule (rare peaks register, constant peaks
  become noise).
- **Finish-window banner replaces the breadcrumb** when active — same
  vertical slot, peak-and-fade. Slow 1 Hz luminance pulse on the
  banner background, not the text. Source: KB §Reveal-moment design.
- **No tab bar on the gameplay screen** — when a round is live we
  hide chrome to keep focus on the hero. Tab bar appears on Home,
  Profile, etc. Tabs ≤ 5. Source: Apple HIG Tab Bar.

### Other screens (scaffold only — designed properly in Phase 1)

| Screen | Role |
|---|---|
| `onboarding` | first-launch sample round (no-op anonymous), 2 swipes max, then "tap to play". Skip is sacred — KB §Onboarding. |
| `home` | one CTA: "play now" (drops into a global shard). Below that: "private room" + "join code". Recent rounds list as inline history (NN/g empty-state guidance, KB §Microcopy). |
| `gameplay` | the HUD above. |
| `profile` | display name, Elo + league progress bar, lifetime counters, daily / win streaks, badges (later). |
| `results` | post-round card: winner name, your placement, Elo delta, "next round in 3 …". Auto-advances. |

---

## 6. Components

### `OptionChip` (the most-pressed thing in the app)

The chip lives in the green thumb zone and is pressed multiple
times per round. It must respond instantly and unambiguously. KB
§Per-card press feedback for binary choice UIs adapted to four:

1. **Independent spring scale on `onPressIn`** — the pressed chip
   only. Damping ~0.9, stiffness 1400 (M3 `motionSpringFastSpatial`,
   tuned), targeting `scale: 0.94`. Source: M3 Motion tokens, KB
   §Motion.
2. **Tint the pressed chip**, not the others — `interpolateColor`
   from `card` → `accent-soft` over ~140 ms (UI thread; Reanimated 4
   only). Source: M3 States,
   https://m3.material.io/foundations/interaction/states.
3. **Haptic on `onPressIn`, not `onPress`.** `Haptics.selectionAsync()`
   — picker semantics, *not* `impactLight` (impact reads as a
   collision; selection is the right grammar for "I chose this").
   Source: Apple HIG Haptics, KB §Haptics.
4. **Use `Pressable` + Reanimated**, not `TouchableOpacity`. TO
   only animates opacity, runs on the JS thread, and can't tint
   border + bg independently. Already lint-banned in humm; same rule
   here.
5. **Disabled state** during a round-advance is a 0.5 opacity dim
   *plus* the cursor not moving — color alone is never enough.

### `TargetHero`

The persistent goal. The hero kinetic typography is reserved for
this component (NOT the current word — see §5 hierarchy reversal).

1. **Always-on identity** — accent border (cyan, ~33% alpha at rest)
   and accent shadow keep it readable as "the goal" without animating.
2. **Round-advance reveal** — when the target word changes:
   drop (opacity → 0, scale → 0.94) over 120 ms, then rise (opacity
   → 1, scale spring to 1.0 with `springAdvance`, dampingRatio 0.65)
   over 280 ms. Total ~400 ms; under Doherty's threshold. Source:
   KB §Reveal moments, NN/g Doherty.
3. **Finish-window pulse** — slow 1 Hz luminance breathing on the
   border + shadow opacity (0.6 → 0.9). Background untouched.
   Source: DESIGN.md §6 FinishWindowBanner pattern, KB §Reveal moments.
4. **No particles.** Light over particles (iOS 26 ethos). Confetti is
   reserved for **first-time wins** and **photo-finish surprise**
   moments, not every round.

### `CurrentBreadcrumb`

The demoted "your word" — Tier 2 retroactive context, NOT a hero.

- `body`-sized (~13 pt label, 14 pt word emphasis), dim/muted color.
- On word change: brief opacity dip (100 ms) + 4 px Y nudge, then
  rise. Subtle enough that the eye can ignore it, present enough
  that retroactive comprehension works.
- Replaced by the FinishWindowBanner during the 3-second peak — same
  vertical slot, taller treatment.

### `RoundCard`

Surface elevation for the gameplay area. Single elevated card with
`bg: card`, `border: accent/15`, `shadow: rgba(0,0,0,0.4) blur 32 y8`.
KB §Standalone hero cards: a card stripped to a single hero element
should *feel* like a destination, not an empty container. Tinted
border + accent-matching shadow do that work.

### `FinishWindowBanner`

The 3-second pulse. This is a peak moment.

- Enter: scale 0.92 → 1.00 with M3 `motionSpringDefaultSpatial`
  (damping 0.9, stiffness 700) over ~280 ms.
- Sustain: a slow 1 Hz luminance oscillation (opacity 0.85 → 1.0)
  on the banner background, not the text.
- Single haptic apex: `Haptics.notificationAsync(Success)` exactly
  on the visible bloom apex (per KB §Reveal moments — "single haptic
  apex, not a crescendo"). Source: KB §Haptics.
- Countdown numerals **swap, not crossfade** — slot-machine
  semantics are gambling-coded; one clean swap with `tabular-nums`
  reads as a digital timer.
- Exit: 200 ms fade + 0.98× scale on dismissal — entries are slightly
  longer than exits per NN/g
  (https://www.nngroup.com/articles/animation-duration/).

### `LiquidGlassNavBar` (iOS 26 only, when available)

Per Apple's explicit rule for Liquid Glass: **navigation layer only,
never on content**.
Source: https://developer.apple.com/design/human-interface-guidelines/liquid-glass,
SwiftUI Liquid Glass Guide (atelier-socle, 2026-01-31).

For tir specifically:

- Use `glassEffect(.regular.interactive(), in: Capsule())` for the
  bottom tab bar background **only on Home / Profile / Results** —
  *never* on the gameplay screen, where every ms of GPU matters and
  the focus must be on the hero word.
- Group glass surfaces via `GlassEffectContainer`. Do not stack
  glass on glass.
- Use `glassEffectID` only when we add a "many → one" animation in
  Phase 2 (e.g. friends list collapsing into a "play with friend"
  CTA).
- **Battery / thermal caveat:** Liquid Glass increases SoC wake time
  and can cause thermal throttling during sustained gameplay
  (Source: powerapp.pro 2026 analysis,
  https://powerapp.pro/liquid-glass-vs-battery-life-designing-for-polished-ui-witho).
  Reinforces: glass off the gameplay screen.
- iOS < 26: solid frosted fallback. Detect with `if #available(iOS 26.0, *)`.

For Android: a flat `surface` with a 1px `border/40` bottom divider.
No glass equivalent; trying to fake it costs more frame time than
it gives.

---

## 7. Motion

### Library

- **Reanimated 4** (already aligned with humm). All UI-thread
  animations. Babel uses `react-native-worklets` (not the legacy
  reanimated plugin). Source: KB §Reanimated 4.
- **Legacy `Animated` is banned.** It can't animate color/opacity on
  the UI thread and drops frames during dense interaction. Source:
  KB §Reanimated 4.

### Token source: `lib/motion.ts` (to be created)

Every animation imports from a single token file. Inline
`Easing.bezier(...)` and inline spring configs are banned in feature
code (mirrors humm's discipline).

### Spring tokens (M3-aligned, perceptual API)

| Token | dampingRatio | stiffness | Use |
|---|---|---|---|
| `springTap` | 0.9 | 1400 | option chip press |
| `springTapEffect` | 1.0 | 3800 | color/opacity tied to a press |
| `springAdvance` | 0.65 | 700 | hero-word landing (one visible bounce) |
| `springScreen` | 0.9 | 300 | screen push/pop |
| `springReveal` | 0.55 | 600 | finish-window enter (peak moment) |

Source: KB §Spring physics — Material 3 tokens.

### Easing tokens

| Token | Curve | Use |
|---|---|---|
| `easeStandard` | `cubic-bezier(0.2, 0, 0, 1)` | M3 emphasized — most entrances |
| `easeOut` | `cubic-bezier(0, 0, 0.2, 1)` | dismissals / fades-out |
| `easeInOut` | `cubic-bezier(0.4, 0, 0.2, 1)` | scrubbing / drags |

Source: M3 Motion easing,
https://m3.material.io/styles/motion/easing-and-duration; KB
§Motion.

### Duration budgets

| Interaction | Budget |
|---|---|
| chip press feedback | 100–140 ms |
| hero-word advance | 240–360 ms (under Doherty 400 ms) |
| finish-window enter | 280 ms |
| finish-window exit | 200 ms |
| screen push/pop | 280–320 ms |
| round-end results card | ≤ 600 ms total |

The most common failure is **animations being too long, not too
short**. Source: NN/g animation duration research,
https://www.nngroup.com/articles/animation-duration/.

### Reduce-motion

- Every `withSpring` / `withTiming` ships with an explicit
  `reduceMotion: ReduceMotion.Never` configured on top of a calm
  fallback (≤ 5% scale, ≤ 320 ms timing, opacity-led). The default
  `ReduceMotion.System` *snaps to the toValue immediately* — that's
  the recurring bug to never re-introduce. Source: KB §Reduce-motion.
- The hero-word animation has a calm reduce-motion path: cross-fade
  + 4% scale, no overshoot. The card border tint still interpolates
  (color is allowed under reduce-motion).
- Verify with iOS simulator → Settings → Accessibility → Motion →
  Reduce Motion. Look for `[Reanimated] Reduced motion setting is
  enabled on this device` in Metro logs.

### Haptic vocabulary

| Event | Haptic | Why |
|---|---|---|
| chip `onPressIn` | `selectionAsync()` | picker grammar — "I chose this" |
| target reached (you) | `notificationAsync(Success)` on visible bloom apex | single peak; matches KB §Reveal moments |
| photo-finish (you) | `notificationAsync(Success)` × 1, slightly delayed | bigger but not louder |
| finish-window starts (others) | `selectionAsync()` × 1 | acknowledgement, not collision |
| Elo crossed league | `notificationAsync(Success)` × 1 | rare, deserves the one peak |
| error | `notificationAsync(Error)` | sparingly |

**Never**: a sequence of `impactLight` ticks during the finish-window
countdown — slot-machine connotations + Apple SR pushback risk.
Source: KB §Mobile UX Trends ("Fading: literal slot-machine reels
— regulatory pressure on gambling mechanics").

---

## 8. Accessibility

Mobile-first audit gates. Every PR that touches UI passes these
before merge.

| Gate | Requirement | Source |
|---|---|---|
| Color contrast | 4.5:1 for body text, 3:1 for large text and UI components | WCAG 2.2 SC 1.4.3 / 1.4.11 — https://www.w3.org/WAI/WCAG22/quickref/ |
| Touch targets | ≥ 44×44 pt iOS, ≥ 48×48 dp Android, 8 pt min between | Apple HIG Buttons + WCAG 2.5.5 |
| Dynamic Type | Body text scales to ≥ 200% without truncation; layouts reflow | Apple HIG Typography + App Store accessibility criteria — https://developer.apple.com/help/app-store-connect/manage-app-accessibility/larger-text-accessibility-evaluation-criteria/ |
| Reduce Motion | Calm fallback with explicit `ReduceMotion.Never` and ≤ 5% scale | KB §Reduce-motion + Apple HIG Motion |
| Reduce Transparency | Solid `bg/surface` fallback when iOS Reduce Transparency on | iOS 26 Liquid Glass settings (atelier-socle 2026) |
| Screen-reader labels | Every interactive element has `accessibilityLabel`; decorative elements `accessibilityElementsHidden={true}` | RN accessibility API + WCAG 4.1.2 |
| Color is not the only signal | Selection = color *and* scale *and* haptic. Error = color *and* icon *and* text | WCAG SC 1.4.1 |
| Focus order | Matches visual reading order (target → your-word → options L→R, T→B) | WCAG SC 2.4.3 |

---

## 9. Implementation discipline (rules that are easy to break)

These are bumper-rails to keep tir consistent as it grows.

1. **Tokens, not hex.** No raw `#xxxxxx` in feature code. Add to
   `theme.ts` and reference. Single exception: motion lib internals.
2. **`Pressable` + Reanimated**, never `TouchableOpacity`. Lint
   should fail on new TO usage (mirroring humm).
3. **Reanimated 4 for color and opacity**, not legacy `Animated`. KB
   §Reanimated 4.
4. **Inline easing/springs banned.** Import from `lib/motion.ts`.
5. **`maxFontSizeMultiplier` set on every layout-participating
   `Text`.** Prevents Dynamic Type AX5 breakage.
6. **`tabular-nums` on every numeral that changes in place** (Elo,
   countdown, round seq, roster word lengths).
7. **Liquid Glass on navigation chrome only**, never on the gameplay
   screen. Detect availability with `if #available(iOS 26.0, *)`.
8. **One key color (`accent`) for interactivity.** Feature-specific
   tones live on ambient surfaces (halos, decorative borders) only.
   Source: Apple HIG Color, KB §Color & Dark Mode.
9. **No particles for repeat actions.** Light over particles. KB
   §Reveal moments. First-time wins and rare events earn a confetti
   exception.
10. **Animation duration ceilings.** Chip ≤ 140 ms; hero advance
    ≤ 360 ms; reveal ≤ 2.5 s. The most common error is too long.

---

## 10. What we explicitly will NOT do (and why)

- **No explicit "warmer / colder" text meter.** Distance is
  communicated through ambient background glow, not a numeric widget
  or progress bar.
- **No slot-machine reel reveals.** Gambling-coded; M3 motion
  research found Fade-Through (the closest pattern) was perceived as
  "overwhelming and uncomfortable" for premium moments. Source: KB
  §Material 3 motion patterns.
- **No bright flat illustration heroes.** Doesn't fit the dark
  arcade vibe. Hero is always typography on near-black.
- **No carrying humm's mendl-pink palette.** Different brand,
  different feel. Studio-shared elements (lowercase voice, the
  `AmbientGlow` pattern, `Pressable+Reanimated` discipline) carry
  forward; the *colors* don't.
- **No Liquid Glass on the gameplay surface.** Battery + thermal
  cost during sustained play (powerapp.pro 2026), and Apple's own
  rule says navigation only.

---

## 11. Open design questions

1. **The accent color.** Cyan `#00E5FF` is the recommended pick;
   lime `#A1FF4C`, hot pink `#FF66B2`, electric violet `#9B7BFF`
   are the documented alternates. Decide before Phase 1 lands.
2. **Variable font on Android.** Do we ship Roboto Flex now or use
   the system Roboto static? (Variable adds ~200 KB; M3 Expressive
   benefits depend on it.)
3. **Sound.** Currently silent. Should target-reached have a
   subtle blip? Apple HIG warns games over-relying on sound; v0
   recommendation: silent + haptic, audio in a Phase 3 polish pass.
4. **Hero-word language switching.** When Hindi lands (Phase 3),
   does the hero word stay one font, or do we ship a Devanagari
   pair? Source decisions deferred.
5. **Liquid Glass tab bar on Android.** No Material equivalent.
   Decide if we accept platform divergence (recommended — platform
   honesty per KB §Apple HIG / Material).

---

*Last reviewed: 2026-05-09. Next refresh trigger: any new feature
adding a peak moment, a new screen archetype, or a major iOS
release.*
