import { Platform, TextStyle } from 'react-native';

// ---------------------------------------------------------------------------
// Typography tokens — DESIGN.md §3
// iOS: SF Pro (system). Android: Roboto (system).
// tabular-nums on every numeral that changes in place.
// maxFontSizeMultiplier capped per token for Dynamic Type safety.
// ---------------------------------------------------------------------------

const BASE_FAMILY = Platform.select({
  ios: 'System',
  android: 'Roboto',
  default: 'System',
});

// Monospaced for data grids, eyebrow labels, room codes, and any text that
// reads "system / data / chrome" rather than "content". Apple Sports uses
// SF Mono in their score grids; Menlo is the closest pre-installed iOS
// equivalent that's available without bundling a custom font.
const MONO_FAMILY = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

type TypeToken = TextStyle & { maxFontSizeMultiplier: number };

function t(style: TextStyle & { maxFontSizeMultiplier?: number }): TypeToken {
  return {
    fontFamily: BASE_FAMILY,
    ...style,
    maxFontSizeMultiplier: style.maxFontSizeMultiplier ?? 1.4,
  };
}

export const type = {
  displayHero: t({
    fontSize: 64,
    fontWeight: '700',
    letterSpacing: -0.03 * 64,
    lineHeight: 64,
    maxFontSizeMultiplier: 1.2,
  }),

  display: t({
    fontSize: 36,
    fontWeight: '700',
    letterSpacing: -0.02 * 36,
    maxFontSizeMultiplier: 1.2,
  }),

  title: t({
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.01 * 20,
    maxFontSizeMultiplier: 1.3,
  }),

  option: t({
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0,
    maxFontSizeMultiplier: 1.2,
  }),

  body: t({
    fontSize: 15,
    fontWeight: '400',
    lineHeight: 22,
    maxFontSizeMultiplier: 1.6,
  }),

  meta: t({
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.06 * 12,
    textTransform: 'uppercase' as const,
    maxFontSizeMultiplier: 1.4,
  }),

  numeric: t({
    fontSize: 17,
    fontWeight: '600',
    fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
    maxFontSizeMultiplier: 1.3,
  }),

  micro: t({
    fontSize: 11,
    fontWeight: '500',
    maxFontSizeMultiplier: 1.5,
  }),

  // Monospaced eyebrow label: 'DIFFICULTY', 'PRIVATE', 'LEADERBOARD', etc.
  // Used to delimit sections without taking visual weight from the content.
  eyebrow: t({
    fontFamily: MONO_FAMILY,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.6,
    textTransform: 'uppercase' as const,
    maxFontSizeMultiplier: 1.4,
  }),

  // Monospaced data cell: rank/elo in the leaderboard, room code in chips.
  // Apple Sports vocabulary — data feels "fast" while sitting still.
  mono: t({
    fontFamily: MONO_FAMILY,
    fontSize: 13,
    fontWeight: '500',
    fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
    maxFontSizeMultiplier: 1.3,
  }),

  monoLg: t({
    fontFamily: MONO_FAMILY,
    fontSize: 17,
    fontWeight: '700',
    fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
    maxFontSizeMultiplier: 1.2,
  }),
} as const;

export type TypeTokenName = keyof typeof type;

// ---------------------------------------------------------------------------
// Emoji glyph helper.
//
// iOS RN renders Apple Color Emoji with inconsistent metrics when the
// `<Text>`'s fontFamily is unset (RN issue #47621, still open as of
// 2026): the emoji's line-box inflates by roughly 1.2–1.4× the font
// size, the baseline drifts a few px relative to adjacent latin text,
// and the inflation amount differs per emoji glyph. Result: the same
// avatar emoji renders visibly differently across screens (e.g. 🐺 in
// the home identity circle vs in the game stats bar) even when the
// fontSize matches.
//
// The canonical workaround is to pin `fontFamily: 'System'` (forcing
// CoreText into the same emoji-in-system-font code path everywhere)
// AND clamp `lineHeight` to ~1.1× fontSize so the line-box matches the
// glyph box. `includeFontPadding: false` suppresses the analogous
// Android padding so the rendered metrics match across platforms.
//
// Usage: `<Text style={glyph(18)}>🐺</Text>` — for any STANDALONE
// emoji. For emoji rendered inline inside a text token (e.g. inside
// `typo.body` text), no helper is needed because the parent style
// already pins fontFamily.
//
// Sizes used in the app:
//   16 — peer / roster face (game stats bar, league tier inline)
//   18 — your face (game stats bar self-avatar, leaderboard rows)
//   24 — home identity card avatar
//   26 — name-picker grid cell
//   40 — name-picker preview
//   56 — game results popup celebration glyph
//
// Keep the size palette short; if you need a new size, justify why
// the existing five don't fit the surface.
// ---------------------------------------------------------------------------
export function glyph(size: number): TextStyle {
  return {
    fontFamily: BASE_FAMILY,
    fontSize: size,
    lineHeight: Math.round(size * 1.1),
    includeFontPadding: false,
  };
}
