// Slim motion utilities for the home/menu surface.
//
// REVISED 2026-05-09: dropped LogoMark / KineticTagline / PlayButtonHalo /
// PillShimmer / LivePulseDot / LiveLeaderLine. Per Apple HIG Motion + Linear
// 2026 refresh + Things 3 critique, idle decoration on a non-immersive home
// screen is the wrong vocabulary — it reads as "free game on the App Store",
// not as "world-class polished app". Motion now lives in three places only:
//
//   1. Entrance stagger on first paint (handled inline with Reanimated's
//      `entering={FadeInDown.delay(...)}` API in app/index.tsx — no wrapper
//      needed, the runtime handles it).
//   2. Value-change animations on real data (`EloCountUp` below).
//   3. Press response on every tappable (`PressableScale` below).
//
// No always-on loops. No ambient decoration. See ux-design-expert KB
// §"Restraint over decoration on non-immersive home screens".

import { useEffect, useRef, useState } from 'react';
import { Pressable, PressableProps, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { colors, radius, space } from '../lib/theme';
import { glyph, type as typo } from '../lib/typography';
import { springTap } from '../lib/motion';

// ---------------------------------------------------------------------------
// PressableScale — wraps any tappable with a tasteful press response.
//
// scale 1.0 → 0.97 + opacity 1.0 → 0.86 with the existing snappy springTap.
// This is the only "interaction motion" the home screen uses; it gives every
// button the same considered feel (Linear / Things 3 vocabulary) without
// us having to remember to add `style={pressed && {opacity: 0.7}}` everywhere.
// ---------------------------------------------------------------------------

type PressableScaleProps = Omit<PressableProps, 'style'> & {
  style?: any;
  pressedScale?: number;
  pressedOpacity?: number;
};

// Reanimated-animated Pressable. We need the touchable element AND the
// styled element to be the same view, otherwise the styled surface
// (padding, background, radius) extends beyond the Pressable's
// children and creates a "dead zone" where taps land on the wrapper
// View instead of the Pressable. Logged + corrected 2026-05-10 #36
// after the user reported "the start and next buttons only work when
// I click directly on the text" — this was the root cause for every
// call site of PressableScale (home PLAY, leaderboard rows, dot
// indicators, /name CTA, /welcome CTAs, dice button, emoji cells).
//
// Reference: Reanimated v4 docs §createAnimatedComponent
// https://docs.swmansion.com/react-native-reanimated/docs/core/createAnimatedComponent/
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function PressableScale({
  children,
  style,
  onPressIn,
  onPressOut,
  disabled,
  pressedScale = 0.97,
  pressedOpacity = 0.86,
  ...rest
}: PressableScaleProps) {
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value * (disabled ? 0.4 : 1),
  }));

  return (
    <AnimatedPressable
      style={[style, animStyle]}
      disabled={disabled}
      onPressIn={e => {
        scale.value = withSpring(pressedScale, springTap);
        opacity.value = withTiming(pressedOpacity, {
          duration: 80,
          reduceMotion: ReduceMotion.System,
        });
        onPressIn?.(e);
      }}
      onPressOut={e => {
        scale.value = withSpring(1, springTap);
        opacity.value = withTiming(1, {
          duration: 120,
          reduceMotion: ReduceMotion.System,
        });
        onPressOut?.(e);
      }}
      {...rest}
    >
      {children}
    </AnimatedPressable>
  );
}

// ---------------------------------------------------------------------------
// EloCountUp — animates a numeric value from previous reading to current.
//
// Honest motion: only animates when the underlying value actually changes
// (e.g. user returned from a winning round and Elo updated by +18). On
// first mount (prev === target) it just renders the value statically — no
// fake "0 → real" land animation that misleads about the score.
//
// Uses ease-out cubic over 700ms; tabular-nums on the Text style by the
// caller (we don't enforce it here so the number can adopt whatever
// surrounding type vocabulary the screen uses).
// ---------------------------------------------------------------------------

export function EloCountUp({
  value,
  duration = 700,
  style,
}: {
  value: number;
  duration?: number;
  style?: any;
}) {
  const target = Math.round(value);
  const prev = useRef(target);
  const [display, setDisplay] = useState(target);

  useEffect(() => {
    const start = prev.current;
    const end = target;
    if (start === end) {
      setDisplay(end);
      return;
    }
    const startTs = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const elapsed = Date.now() - startTs;
      const t = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(start + (end - start) * eased));
      if (t < 1) {
        timer = setTimeout(tick, 16);
      } else {
        prev.current = end;
      }
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
      prev.current = end;
    };
  }, [target, duration]);

  return <Text style={style}>{display}</Text>;
}

// ---------------------------------------------------------------------------
// LiveBadge — static "● LIVE" tick (no animation).
//
// Apple Sports vocabulary: "live" is communicated by the badge being PRESENT
// in success-color, not by a pulsing dot. Pulsing reads as a notification
// counter; presence reads as data infrastructure.
//
// Pass `live={false}` to render a dim placeholder during connecting / offline.
// ---------------------------------------------------------------------------

export function LiveBadge({ live }: { live: boolean }) {
  return (
    <View style={s.liveBadge}>
      <View
        style={[
          s.liveDot,
          { backgroundColor: live ? colors.success : colors.dim },
        ]}
      />
      <Text style={[s.liveText, { color: live ? colors.success : colors.dim }]}>
        {live ? 'LIVE' : '••••'}
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// LivePulse — full-width "race ticker" pill for the home screen.
//
// Replaces the standalone LiveBadge eyebrow tick with a richer surface that
// broadcasts ACTUAL live state from the global pool: the current target
// word being chased and the running round number. The static LIVE dot
// keeps presence semantics; the kinesis comes from the data CHANGING, not
// from a perpetual loop on the dot (KB §"Restraint over decoration").
//
// Motion budget (per KB §motion):
//   - target word changes → crossfade + slide via Reanimated layout
//     animations (200ms in, 180ms out). Real value-change.
//   - round number → no animation; static text. Counter would be noise.
//
// Accessibility:
//   - Wrapped in `accessibilityLiveRegion="polite"` + role "text" so
//     VoiceOver announces target-word changes during idle without
//     interrupting active speech (WCAG 4.1.3).
//   - `accessibilityLabel` is the meaning ("live pool, current target
//     griffin, round 14"), not the glyph vocabulary.
// ---------------------------------------------------------------------------

type LivePulseProps = {
  live: boolean;
  targetWord?: string | null;
  roundSeq?: number | null;
  // 'pill'    — bordered + filled chip (legacy / standalone surface)
  // 'eyebrow' — chromeless, centered, no border/bg; for use directly
  //             above the PLAY button as the action's metadata. Adjacency
  //             to the action it qualifies (NN/g proximity) means the
  //             surrounding chrome is redundant — the button below
  //             anchors the row visually.
  variant?: 'pill' | 'eyebrow';
};

export function LivePulse({
  live,
  targetWord,
  roundSeq,
  variant = 'pill',
}: LivePulseProps) {
  const showData = live && !!targetWord;
  const a11yLabel = showData
    ? `live global pool, target word ${targetWord}, round ${roundSeq ?? 1}`
    : live
      ? 'live global pool, connecting'
      : 'global pool offline';
  return (
    <View
      style={variant === 'eyebrow' ? s.pulseEyebrow : s.pulsePill}
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={a11yLabel}
    >
      <View
        style={[
          s.liveDot,
          { backgroundColor: live ? colors.success : colors.dim },
        ]}
      />
      <Text style={[s.pulseLiveText, { color: live ? colors.success : colors.dim }]}>
        {live ? 'LIVE' : 'OFFLINE'}
      </Text>
      {showData ? (
        <>
          <Text style={s.pulseSep}>·</Text>
          {/* Data-first grammar (Apple Sports / scoreboard convention):
              the dot+LIVE prefix communicates "happening now"; the word
              right next to it IS the live thing; the round counter is the
              running tally. No verb ("chasing") between them — the
              relationship is implicit from position, not narrated.
              keyed Animated.Text → Reanimated re-mounts on word change,
              firing entering/exiting for an honest crossfade. */}
          <Animated.Text
            key={targetWord ?? 'empty'}
            entering={FadeIn.duration(220)}
            exiting={FadeOut.duration(160)}
            style={s.pulseWord}
            numberOfLines={1}
          >
            {targetWord}
          </Animated.Text>
          {roundSeq != null && roundSeq > 0 && (
            <>
              <Text style={s.pulseSep}>·</Text>
              <Text style={s.pulseRoundLabel}>ROUND</Text>
              <Text style={s.pulseRoundNum}>{roundSeq}</Text>
            </>
          )}
        </>
      ) : (
        <>
          <Text style={s.pulseSep}>·</Text>
          <Text style={s.pulseRoundLabel}>connecting</Text>
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// PlayShimmer — one-shot diagonal glint that crosses the PLAY button face.
//
// Fires when `triggerKey` changes (e.g. the global pool advances a round)
// and the home screen wants to whisper "fresh round just started, jump in".
// This is value-change motion, not idle decoration: the first non-null
// trigger is REMEMBERED but does NOT fire (so the shimmer never plays on
// app open / first paint), and a per-mount cooldown rate-limits subsequent
// fires so a noisy global pool can't strobe the button.
//
// Visual: 60pt-wide white-tinted bar at low opacity, skewed -15deg, sweeps
// from left-of-button to right-of-button over 900ms (KB §motion: short
// peak, ease-out). The bar lives inside `overflow: 'hidden'` so it clips
// to the button radius — the parent must set `overflow: 'hidden'`.
// ---------------------------------------------------------------------------

export function PlayShimmer({
  triggerKey,
  width = 720,
}: {
  triggerKey: string | number | null | undefined;
  width?: number;
}) {
  const x = useSharedValue(-160);
  const lastTrigger = useRef<typeof triggerKey>(undefined);
  const lastFiredAt = useRef(0);
  const COOLDOWN_MS = 8000;
  const TRAVEL = width;

  useEffect(() => {
    // First non-null reading: remember but don't fire. Otherwise the
    // shimmer plays on every cold start, which violates the
    // "value-change, not idle" rule.
    if (lastTrigger.current === undefined) {
      lastTrigger.current = triggerKey;
      return;
    }
    if (triggerKey == null) return;
    if (lastTrigger.current === triggerKey) return;
    lastTrigger.current = triggerKey;
    const now = Date.now();
    if (now - lastFiredAt.current < COOLDOWN_MS) return;
    lastFiredAt.current = now;
    x.value = -160;
    x.value = withTiming(TRAVEL, {
      duration: 900,
      easing: Easing.bezier(0.2, 0, 0.2, 1),
      // Reduce-motion path: skip the sweep entirely (it's purely
      // decorative; the button is fully usable without it).
      reduceMotion: ReduceMotion.System,
    });
  }, [triggerKey, x, TRAVEL]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { skewX: '-15deg' }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: 80,
          backgroundColor: 'rgba(255,255,255,0.18)',
        },
        animStyle,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// LeagueBadgePulse — icon-only league chip that briefly accent-tints its
// border the moment the player crosses into a new tier.
//
// The pulse is value-change motion (KB §"Restraint over decoration"): no
// loop, no idle decoration, fires only on true tier transitions. First
// render after mount is a quiet baseline so a returning player doesn't
// see a phantom pulse for a tier they earned weeks ago.
//
// Implementation note: chip icon style sets `fontFamily: 'System'` and
// `lineHeight` matched to the chip text lineHeight (14pt) — without these
// the Apple Color Emoji glyph rides ~2pt above the body baseline (RN issue
// #47621), causing the league chip to visually un-align with the username
// above it.
// ---------------------------------------------------------------------------

export function LeagueBadgePulse({
  tierKey,
  icon,
  accessibilityLabel,
  variant = 'chip',
}: {
  tierKey: string;
  icon: string;
  accessibilityLabel?: string;
  // 'chip'   — bordered pill, used when standing alone in a chip row.
  // 'inline' — bare glyph, used when prefixing a username (chess.com
  //            title-prefix convention: GM Magnus → 🥇 player). No
  //            border/padding/minWidth so it sits on the name baseline
  //            without competing with the avatar circle next to it.
  variant?: 'chip' | 'inline';
}) {
  const flash = useSharedValue(0);
  const prevKey = useRef<string | null>(null);

  useEffect(() => {
    // Baseline: capture initial tier without animating.
    if (prevKey.current === null) {
      prevKey.current = tierKey;
      return;
    }
    if (prevKey.current === tierKey) return;
    prevKey.current = tierKey;
    flash.value = 1;
    flash.value = withTiming(0, {
      duration: 1400,
      easing: Easing.bezier(0, 0, 0.2, 1),
      reduceMotion: ReduceMotion.System,
    });
  }, [tierKey, flash]);

  // Chip: border-color flash + 6% scale (the border carries half of
  // the tier-change signal).
  const chipAnimStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(
      flash.value,
      [0, 1],
      [colors.border, colors.accent],
    ),
    transform: [{ scale: 1 + flash.value * 0.06 }],
  }));

  // Inline: no border to animate, so the scale carries the whole pulse.
  // Bumped to 12% for parity with the chip variant's combined effect.
  const inlineAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + flash.value * 0.12 }],
  }));

  if (variant === 'inline') {
    return (
      <Animated.View
        style={inlineAnimStyle}
        accessible
        accessibilityLabel={accessibilityLabel ?? 'league'}
      >
        <Text style={s.leagueInlineIcon} allowFontScaling={false}>
          {icon}
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={[s.leagueBadge, chipAnimStyle]}
      accessible
      accessibilityLabel={accessibilityLabel ?? 'league'}
    >
      <Text style={s.leagueBadgeIcon} allowFontScaling={false}>
        {icon}
      </Text>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  liveText: {
    ...typo.eyebrow,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  pulsePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: space[3],
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  // Eyebrow variant — chromeless row stretched to the parent's full
  // width, content LEFT-aligned. Sits directly above the PLAY button.
  //
  // Why stretch + flex-start, not center: when two stacked elements
  // (the eyebrow and the centered PLAY label) have different content
  // widths AND both are centered, the apparent alignment shifts every
  // time the underlying data changes (a long target word recenters the
  // row to a different apparent midpoint than a short one). The cure
  // is to anchor at least one element to a stable axis. Apple HIG's
  // canonical form-row pattern (LabeledContent) puts labels on the
  // left and values on the right — labels live on a stable left edge.
  // Here the eyebrow row IS the label-side metadata for the action
  // below, so it left-aligns to the button's outer edge. The PLAY
  // label stays centered (HIG canon for full-width primary buttons),
  // and the two elements share a bounding box rather than a centroid.
  // Source: Apple HIG Buttons + LabeledContent; KB §Restraint over
  // decoration ("structure should be felt, not seen").
  pulseEyebrow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 8,
    paddingVertical: 4,
  },
  pulseLiveText: {
    ...typo.eyebrow,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  pulseSep: {
    color: colors.dim,
    fontSize: 12,
    lineHeight: 14,
  },
  pulseWord: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 14,
    letterSpacing: -0.2,
    flexShrink: 1,
  },
  pulseRoundLabel: {
    ...typo.eyebrow,
    color: colors.dim,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  pulseRoundNum: {
    ...typo.mono,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 4,
  },

  // ---- League badge (icon-only chip, used in identity card) ----------
  // Ghost variant by default; LeagueBadgePulse animates the border to
  // colors.accent on tier transitions. lineHeight + fontFamily on the
  // glyph are deliberate: see LeagueBadgePulse comment / RN #47621.
  leagueBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 22,
    minWidth: 22,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  leagueBadgeIcon: {
    // Sourced from the shared `glyph()` helper so every emoji
    // surface in the app uses identical font-family + line-height
    // metrics. See RN issue #47621 and lib/typography.ts.
    ...glyph(13),
    textAlign: 'center',
  },
  // Inline name-prefix variant — sized to optically sit on the same
  // cap-height as the username it precedes (identityName: 17pt). Emoji
  // glyphs render slightly larger than text at the same fontSize, so
  // this is intentionally one step down (16pt). The shared glyph
  // helper handles the lineHeight clamp.
  leagueInlineIcon: {
    ...glyph(16),
    textAlign: 'center',
  },
});
