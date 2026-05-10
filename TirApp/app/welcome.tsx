import { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import firestore from '@react-native-firebase/firestore';
import { useAuth, useUserProfile } from '../lib/auth';
import { colors, radius, space, layout } from '../lib/theme';
import { glyph, type as typo } from '../lib/typography';
import { ENTRANCE } from '../lib/motion';
import { PressableScale } from '../components/MenuKinetics';

// ---------------------------------------------------------------------------
// /welcome — three-card "show, don't tell" tutorial.
//
// Design intent (ux-design-expert pass 2026-05-10):
//   - "Best onboarding is invisible: players should learn through play"
//     (gameconsole.link 2026 retention). We can't be fully invisible
//     because the player explicitly asked for orientation, but we can
//     teach with the SAME UI vocabulary they'll see in-game (target
//     card, option chips, avatar row) instead of abstract diagrams or
//     paragraphs of prose. Each card is a static demo of one mechanic.
//   - 30-60s budget. Three cards × ~8s of reading + scroll = ~25s,
//     well inside the "meaningful play within 60s" envelope (Plotline
//     2026, Adoptkit 2026).
//   - No skip. NN/g's "skip is sacred" rule is for long, value-prop
//     marketing carousels where the user already wants to use the app
//     and the tutorial is friction. Here the tutorial is 3 cards / ~25s
//     teaching THE core mechanic of the game (target, move, sync). A
//     player who skips it lands in the global room not knowing what
//     they're picking toward and bounces. Removed 2026-05-10 after the
//     team decided 25s of forced learning beats a 30% bounce on round 1.
//   - Restraint motion (KB §Restraint over decoration). One value-
//     change animation per card, fired ONCE on entry. No idle loops.
//   - Same accent + display vocabulary as /name and home, so the three
//     screens feel like one continuous surface.
//
// Sources:
//   - https://www.nngroup.com/articles/mobile-app-onboarding/
//   - https://gameconsole.link/why-mobile-games-win-or-lose-on-day-1-retention-in-2026
//   - https://www.plotline.so/blog/mobile-app-onboarding-examples
//   - Apple HIG §Onboarding (lead with content)
// ---------------------------------------------------------------------------

const CARD_COUNT = 3;

export default function WelcomeScreen() {
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const profile = useUserProfile(userId);
  const [page, setPage] = useState(0);
  const [completing, setCompleting] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const { width } = Dimensions.get('window');

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = e.nativeEvent.contentOffset.x;
    const next = Math.round(x / width);
    if (next !== page) setPage(next);
  };

  const goToPage = (i: number) => {
    scrollRef.current?.scrollTo({ x: i * width, y: 0, animated: true });
  };

  const finish = async () => {
    if (!userId || completing) return;
    setCompleting(true);
    try {
      // Single-field write; the client rule allow-list permits
      // `tutorialCompletedAt` alongside displayName/avatarEmoji. Server
      // timestamp so the field reflects ACTUAL completion time, not
      // device clock. NavigationGate sees the field flip and
      // re-routes to '/'.
      await firestore().doc(`users/${userId}`).set(
        {
          tutorialCompletedAt: firestore.FieldValue.serverTimestamp(),
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (e) {
      console.warn('welcome: tutorialCompletedAt write failed', e);
      // Best-effort — if the write fails, the user is stuck on /welcome
      // until the next attempt. Surface a soft message rather than a
      // toast loop.
      setCompleting(false);
    }
  };

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <View style={s.topBar}>
        <Animated.View entering={FadeIn.duration(ENTRANCE.duration)}>
          <Text style={s.brandTick}>TIR · 2 / 2</Text>
        </Animated.View>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScroll}
        style={s.pager}
      >
        <Card1 active={page === 0} width={width} />
        <Card2 active={page === 1} width={width} />
        <Card3
          active={page === 2}
          width={width}
          you={profile?.avatarEmoji ?? '🐺'}
        />
      </ScrollView>

      <View style={[s.bottom, { paddingBottom: insets.bottom + space[4] }]}>
        <View style={s.dotsRow}>
          {Array.from({ length: CARD_COUNT }, (_, i) => (
            <Pressable
              key={i}
              onPress={() => goToPage(i)}
              accessibilityRole="button"
              accessibilityLabel={`go to card ${i + 1}`}
              hitSlop={8}
            >
              <View style={[s.dot, i === page && s.dotActive]} />
            </Pressable>
          ))}
        </View>

        {page < CARD_COUNT - 1 ? (
          <PressableScale
            onPress={() => goToPage(page + 1)}
            accessibilityRole="button"
            accessibilityLabel="next"
            style={s.cta}
          >
            <View style={s.ctaInner}>
              <Text style={s.ctaText}>next</Text>
              <Text style={s.ctaArrow}>→</Text>
            </View>
          </PressableScale>
        ) : (
          <PressableScale
            onPress={finish}
            disabled={completing}
            accessibilityRole="button"
            accessibilityLabel="lets race"
            style={[s.cta, completing && s.ctaDisabled]}
          >
            <View style={s.ctaInner}>
              <Text style={s.ctaText}>
                {completing ? 'starting…' : "let's race"}
              </Text>
              {!completing && <Text style={s.ctaArrow}>→</Text>}
            </View>
          </PressableScale>
        )}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// CardShell — shared layout for the three tutorial cards.
//
// `active` toggles the per-card entry stagger so swiping between cards
// re-fires the local animation once (not on every scroll tick).
// ---------------------------------------------------------------------------

function CardShell({
  width,
  index,
  title,
  caption,
  children,
}: {
  width: number;
  index: number;
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[s.card, { width }]}>
      <View style={s.cardInner}>
        <Animated.Text
          entering={FadeInDown.duration(ENTRANCE.duration).delay(60)}
          style={s.cardEyebrow}
        >
          {`${index} / ${CARD_COUNT}`}
        </Animated.Text>
        <Animated.Text
          entering={FadeInDown.duration(ENTRANCE.duration).delay(120)}
          style={s.cardTitle}
        >
          {title}
        </Animated.Text>
        <View style={s.cardDemoSlot}>{children}</View>
        <Animated.Text
          entering={FadeInDown.duration(ENTRANCE.duration).delay(360)}
          style={s.cardCaption}
        >
          {caption}
        </Animated.Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Card 1 — THE GOAL (WIN condition). Big static target card; same
// `targetCard` vocabulary as the game screen, scaled.
//
// Teaching beat: what does "winning a round" mean? Answer: first
// player to land on the target wins. NOT "closest meaning wins" —
// that's Card 2's beat (the move heuristic), and conflating the two
// is the bug logged on 2026-05-10 #33 (user caught it). Each card
// teaches ONE thing the other two don't.
// ---------------------------------------------------------------------------

function Card1({ active, width }: { active: boolean; width: number }) {
  // Tiny accent halo bloom on entry — value-change motion: fires once
  // when the card becomes active. ReduceMotion.System so the halo
  // gracefully disappears on accessibility-on devices.
  const halo = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    halo.value = 0;
    halo.value = withDelay(
      280,
      withTiming(1, {
        duration: 420,
        easing: Easing.bezier(0.2, 0, 0.2, 1),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [active, halo]);
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.3 + halo.value * 0.5,
    transform: [{ scale: 1 + halo.value * 0.04 }],
  }));

  return (
    <CardShell
      width={width}
      index={1}
      title="reach the target."
      caption="first to reach wins."
    >
      <View style={s.targetWrap}>
        {/* Lowercase `target` label matches the in-game targetCard
            (which uses `<Text>target</Text>` with `typo.meta`'s
            textTransform:'uppercase' rendering it visually as
            uppercase but spelt lowercase in source — same convention
            here). KB §Cross-screen identity. */}
        <Animated.View style={[s.targetCard, haloStyle]}>
          <Text style={s.targetEyebrow}>target</Text>
          <Text style={s.targetWord}>OCEAN</Text>
        </Animated.View>
      </View>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------
// Card 2 — THE MOVE (move heuristic).
//
// Teaching beat: HOW do you move toward the target? Answer: each
// turn you see 4 options — pick the one closest in meaning to the
// TARGET. That's a bigger leap toward it.
//
// Visual layout (top-to-bottom):
//   TARGET · OCEAN    ← compact reference, accent-tinted
//   YOU'RE AT · RIVER  ← dim, marks current position
//   [STREAM✨][VALLEY] ← option chips; STREAM glows accent
//   [ROCK]   [HORSE]
//
// The spatial arrangement is the teach: target at top, you're below
// it, options at bottom; the glow on STREAM says "this one is closest
// to the word at the top". No explanatory sentence needed — the
// layout IS the explanation. KB §"show, don't tell".
//
// This is the per-MOVE optimization, NOT the win condition (Card 1).
// ---------------------------------------------------------------------------

function Card2({ active, width }: { active: boolean; width: number }) {
  const glow = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    glow.value = 0;
    glow.value = withDelay(
      380,
      withSequence(
        withTiming(1, {
          duration: 320,
          easing: Easing.bezier(0.2, 0, 0.2, 1),
          reduceMotion: ReduceMotion.System,
        }),
        withTiming(0.55, {
          duration: 240,
          easing: Easing.bezier(0.2, 0, 0.2, 1),
          reduceMotion: ReduceMotion.System,
        }),
      ),
    );
  }, [active, glow]);

  const winStyle = useAnimatedStyle(() => ({
    borderColor: glow.value > 0.5 ? colors.accent : colors.border,
    transform: [{ scale: 1 + glow.value * 0.04 }],
    shadowOpacity: 0.2 + glow.value * 0.5,
  }));

  return (
    <CardShell
      width={width}
      index={2}
      title="pick toward the target."
      caption="closest meaning, biggest leap."
    >
      <View style={s.optionsWrap}>
        {/* Compact target reference — SAME component family as Card 1's
            full target card and the in-game targetCard: vertical stack
            with `target` meta-label on top + bold word below, accent
            border at ~33% alpha, accent shadow halo, radius from the
            same scale. Just sized down so it reads as a reminder
            ("that's what you're aiming at"), not a hero. The spatial
            top-to-bottom order (target → you → options) IS the
            explanation of the game flow. KB §Cross-screen identity. */}
        <View style={s.card2TargetCard}>
          <Text style={s.card2TargetLabel}>target</Text>
          <Text style={s.card2TargetWord}>OCEAN</Text>
        </View>

        <View style={s.card2Divider} />

        <Text style={s.currentLabel}>YOU</Text>
        <Text style={s.currentWord}>RIVER</Text>

        <View style={s.optionsGrid}>
          <OptionChip word="STREAM" highlightStyle={winStyle} />
          <OptionChip word="VALLEY" />
          <OptionChip word="ROCK" />
          <OptionChip word="HORSE" />
        </View>
      </View>
    </CardShell>
  );
}

function OptionChip({
  word,
  highlightStyle,
}: {
  word: string;
  highlightStyle?: any;
}) {
  return (
    <Animated.View
      style={[
        s.optionChip,
        {
          shadowColor: colors.accent,
          shadowOffset: { width: 0, height: 0 },
          shadowRadius: 14,
        },
        highlightStyle,
      ]}
    >
      <Text style={s.optionWord}>{word}</Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Card 3 — THE RACE (sync property). Avatar row showing the player
// + 3 opponents, with the player's ring pulsing accent on entry.
// Mirrors the game HUD's roster vocabulary so the player recognises
// it in-game.
//
// Teaching beat: WHO are you playing against, and WHEN? Answer:
// every player in the room is on the SAME word at the SAME time —
// it's synchronous, not turn-based. This is what's NOT obvious from
// just seeing the avatars (could equally be 4 separate games); the
// caption locks the synchronicity in.
// ---------------------------------------------------------------------------

function Card3({
  active,
  width,
  you,
}: {
  active: boolean;
  width: number;
  you: string;
}) {
  const youGlow = useSharedValue(0);
  useEffect(() => {
    if (!active) return;
    youGlow.value = 0;
    youGlow.value = withDelay(
      300,
      withTiming(1, {
        duration: 440,
        easing: Easing.bezier(0.2, 0, 0.2, 1),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [active, youGlow]);
  const youStyle = useAnimatedStyle(() => ({
    borderColor: colors.accent,
    transform: [{ scale: 1 + youGlow.value * 0.06 }],
    shadowOpacity: 0.2 + youGlow.value * 0.6,
  }));

  return (
    <CardShell
      width={width}
      index={3}
      title="race together."
      caption="same word, same time."
    >
      <View style={s.rosterWrap}>
        <Animated.View
          style={[
            s.rosterAvatar,
            s.rosterYou,
            youStyle,
            {
              shadowColor: colors.accent,
              shadowOffset: { width: 0, height: 0 },
              shadowRadius: 12,
            },
          ]}
        >
          <Text style={s.rosterFace} allowFontScaling={false}>
            {you}
          </Text>
        </Animated.View>
        <View style={s.rosterAvatar}>
          <Text style={s.rosterFace} allowFontScaling={false}>🦊</Text>
        </View>
        <View style={s.rosterAvatar}>
          <Text style={s.rosterFace} allowFontScaling={false}>🐯</Text>
        </View>
        <View style={s.rosterAvatar}>
          <Text style={s.rosterFace} allowFontScaling={false}>🐲</Text>
        </View>
      </View>
      <View style={s.liveTag}>
        <View style={s.liveDot} />
        <Text style={s.liveText}>LIVE · 4 PLAYERS</Text>
      </View>
    </CardShell>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // ---- Top bar -----------------------------------------------------------
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: layout.pagePaddingH,
    paddingTop: space[3],
    paddingBottom: space[2],
  },
  brandTick: {
    ...typo.eyebrow,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 2.0,
  },

  // ---- Pager -------------------------------------------------------------
  pager: {
    flex: 1,
  },
  card: {
    flex: 1,
    paddingHorizontal: layout.pagePaddingH,
    justifyContent: 'center',
  },
  cardInner: {
    paddingTop: space[4],
    paddingBottom: space[5],
  },
  cardEyebrow: {
    ...typo.eyebrow,
    color: colors.dim,
    fontSize: 11,
    letterSpacing: 2.0,
    marginBottom: space[2],
  },
  cardTitle: {
    color: colors.text,
    ...typo.display,
    fontSize: 32,
    lineHeight: 36,
    letterSpacing: -0.6,
  },
  cardDemoSlot: {
    marginTop: space[6],
    marginBottom: space[5],
    alignItems: 'center',
    minHeight: 220,
    justifyContent: 'center',
  },
  cardCaption: {
    color: colors.muted,
    ...typo.body,
    textAlign: 'left',
  },

  // ---- Card 1: target — large tutorial scale ----------------------------
  // Matches the in-game `targetCard` vocabulary exactly (same border
  // alpha, same radius family, same shadow, same label token, vertical
  // stack with `typo.meta` label on top + big bold word below). Word
  // size is one notch down from the game's 56pt because the tutorial
  // surface has less width to play with than the game's full-width
  // hero card. KB §Cross-screen identity.
  targetWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  targetCard: {
    paddingVertical: space[5],
    paddingHorizontal: space[6],
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.accent + '55',
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
    elevation: 12,
    alignItems: 'center',
    minWidth: 220,
  },
  targetEyebrow: {
    color: colors.accent,
    ...typo.meta,
    letterSpacing: 3,
    marginBottom: space[2],
  },
  targetWord: {
    color: colors.text,
    fontSize: 48,
    fontWeight: '800',
    letterSpacing: -1.5,
    lineHeight: 52,
    textAlign: 'center',
  },

  // ---- Card 2: options ---------------------------------------------------
  optionsWrap: {
    alignItems: 'center',
    width: '100%',
  },
  // Compact target card — SAME component family as Card 1's targetCard
  // and the in-game targetCard. Vertical stack: meta label on top + bold
  // word below; accent border at ~33% alpha; accent shadow halo; radius
  // from the same scale (one notch down: lg vs xl). Padding scaled down
  // ~50% so it reads as a reminder, not a hero. KB §Cross-screen
  // identity: the player should recognise this card as the same shape
  // they'll see in the game and on Card 1 — just smaller.
  card2TargetCard: {
    paddingVertical: space[3],
    paddingHorizontal: space[5],
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.accent + '55',
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 14,
    elevation: 6,
    alignItems: 'center',
    minWidth: 160,
  },
  card2TargetLabel: {
    color: colors.accent,
    ...typo.meta,
    letterSpacing: 2.4,
    marginBottom: space[1],
  },
  card2TargetWord: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.6,
    lineHeight: 24,
    textAlign: 'center',
  },
  card2Divider: {
    width: 1,
    height: space[4],
    backgroundColor: colors.border,
    marginVertical: space[2],
  },
  currentLabel: {
    ...typo.eyebrow,
    color: colors.dim,
    fontSize: 10,
    letterSpacing: 1.8,
  },
  currentWord: {
    color: colors.muted,
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.2,
    marginTop: space[1],
    marginBottom: space[4],
  },
  optionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: space[2],
    width: '100%',
  },
  optionChip: {
    // Mirror the in-game `optionChip` 2x2 grid: each chip claims ~48%
    // of the row so exactly two fit per row regardless of word length.
    // Without this, short words like ROCK / HORSE pack three to a row
    // and break the 2x2 mental model players see in-game.
    width: '48%',
    paddingVertical: space[3],
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
  },
  optionWord: {
    color: colors.text,
    ...typo.option,
    fontSize: 17,
  },
  // ---- Card 3: roster ----------------------------------------------------
  rosterWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[3],
  },
  rosterAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rosterYou: {
    width: 64,
    height: 64,
    borderRadius: 32,
  },
  rosterFace: {
    ...glyph(28),
  },
  liveTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: space[5],
    paddingHorizontal: space[3],
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.success,
  },
  liveText: {
    ...typo.eyebrow,
    color: colors.success,
    fontSize: 10,
    letterSpacing: 1.4,
  },

  // ---- Bottom bar (dots + CTA) -------------------------------------------
  bottom: {
    paddingHorizontal: layout.pagePaddingH,
    paddingTop: space[3],
    gap: space[3],
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[2],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  dotActive: {
    backgroundColor: colors.accent,
    width: 18,
  },
  cta: {
    backgroundColor: colors.accent,
    paddingVertical: space[4],
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: layout.minTapTarget + 8,
    justifyContent: 'center',
  },
  ctaDisabled: { opacity: 0.4 },
  ctaInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  ctaText: {
    color: colors.bg,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  ctaArrow: {
    color: colors.bg,
    fontSize: 18,
    fontWeight: '800',
  },
});
