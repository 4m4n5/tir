import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  FadeInDown,
  FadeOutUp,
  LinearTransition,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import auth from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { useAuth, useUserProfile } from '../lib/auth';
import { deleteCurrentAccount } from '../lib/account';
import { colors, radius, space, layout } from '../lib/theme';
import { glyph, type as typo } from '../lib/typography';
import { ENTRANCE, easeStandard } from '../lib/motion';
import {
  EloCountUp,
  LeagueBadgePulse,
  LivePulse,
  PlayShimmer,
  PressableScale,
} from '../components/MenuKinetics';
import {
  callAssignGlobalRoom,
  callCreatePrivateRoom,
  callJoinPrivateRoom,
  isInPlacement,
  leagueTierFromElo,
  logPerf,
  PLACEMENT_TOTAL_ROUNDS,
  useGlobalLivePulse,
  type Difficulty,
} from '../src/rooms/privateRooms';

// ---------------------------------------------------------------------------
// Home / menu screen
//
// Information architecture (ux-design-expert pass 2026-05-10 #18):
//   1. LivePulse — broadcasts the global pool's current target + round.
//   2. Wordmark — small (32pt), no tagline. Brand presence, not the hero.
//   3. Identity card — me, with a scoreboard-style data grid on the right
//      (`#3 RANK` / `1042 ELO`) — Apple Sports vocabulary. ELO is the
//      canonical positive label so the `NO ELO` tag on the private
//      disclosure has a positive referent on the same screen.
//   4. PLAY — the only chunky CTA. Two-tone label `PLAY · LIVE` carries
//      the live-pool metadata inside the button, removing the need for
//      a separate hint line. One-shot shimmer fires when the global
//      pool advances a round (value-change motion, 8s cooldown).
//   5. Leaderboard — top 10 with a sticky "you" row pinned at the top of
//      the card if the player is ranked beyond top 10. Row layout
//      transitions when rankings actually shift.
//   6. Private rooms — collapsed disclosure at the bottom. Lower in the
//      hierarchy because the returning-player loop is "did I move?",
//      not "host a friend" (chess.com canon).
//
// Cite: NN/g Progressive Disclosure
// (https://www.nngroup.com/articles/progressive-disclosure/),
// Battlesnake leaderboard docs (rating vs rank vs Elo terminology —
// https://docs.battlesnake.com/guides/leaderboards), Lickability on
// Apple Sports' dense data grid (https://lickability.com/blog/apple-sports),
// KB §Single-CTA home screen, KB §Restraint over decoration,
// KB §Tier ladders, KB §Live-data tickers, KB §Stat chips.
// ---------------------------------------------------------------------------

const DIFFICULTIES: Difficulty[] = ['chill', 'normal', 'hard', 'expert'];

const LEADERBOARD_VISIBLE = 10;

type LeaderboardEntry = {
  uid: string;
  displayName: string;
  avatarEmoji: string;
  ratingElo: number;
  league: string;
};

function useLeaderboard(ready: boolean) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  useEffect(() => {
    if (!ready) return;
    return firestore()
      .collection('publicProfiles')
      .orderBy('ratingElo', 'desc')
      .limit(LEADERBOARD_VISIBLE)
      .onSnapshot(
        snap => {
          if (!snap) return;
          setEntries(
            snap.docs.map(d => ({
              uid: d.id,
              displayName: (d.data()?.displayName as string) ?? 'anon',
              avatarEmoji: (d.data()?.avatarEmoji as string) ?? '👤',
              ratingElo: Number(d.data()?.ratingElo ?? 1000),
              league: (d.data()?.league as string) ?? 'Bronze',
            })),
          );
        },
        err => {
          console.warn('leaderboard query failed:', err.message);
        },
      );
  }, [ready]);
  return entries;
}

// ---------------------------------------------------------------------------
// useMyGlobalRank — exact rank in the global pool, not bounded by top-N.
//
// Uses Firestore's `count()` aggregate so this is a single round-trip
// regardless of how many players are above the user. Refreshes whenever
// the player's Elo changes (i.e. they finish a ranked round). Returns
// null while booting / on transient errors so the UI can fall back to a
// neutral display rather than a misleading "#0".
//
// Cite: Firestore aggregate count
// (https://firebase.google.com/docs/firestore/query-data/aggregation-queries#count_aggregation).
// ---------------------------------------------------------------------------

function useMyGlobalRank(userId: string | null, elo: number): number | null {
  const [rank, setRank] = useState<number | null>(null);
  useEffect(() => {
    if (!userId) {
      setRank(null);
      return;
    }
    let cancelled = false;
    firestore()
      .collection('publicProfiles')
      .where('ratingElo', '>', elo)
      .count()
      .get()
      .then(snap => {
        if (cancelled) return;
        const above = snap.data().count ?? 0;
        setRank(above + 1);
      })
      .catch(err => {
        console.warn('myRank query failed:', err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, elo]);
  return rank;
}

const enter = (i: number) =>
  FadeInDown.duration(ENTRANCE.duration).delay(i * ENTRANCE.step);

// ---------------------------------------------------------------------------
// StatChip — compact icon + mono-number pill for the identity card.
//
// Replaces the prior text-meta string ("12-win streak · 3-day streak · …")
// which truncated on narrow screens. Single visual style; semantic color
// variants (ghost / muted / success) per KB §"Restraint over decoration"
// (color reserved for meaning). Each chip is independently presence-gated
// — nothing gets rendered for an empty stat.
//
// `accessibilityLabel` is the meaning ("12 day streak"), not the glyph
// ("flame 12") — Apple HIG accessibility. Wrap-friendly so iPhone SE
// drops to two lines instead of clipping.
// ---------------------------------------------------------------------------

type StatChipProps = {
  icon?: string;
  value?: number;
  text?: string;
  variant: 'ghost' | 'muted' | 'success';
  accessibilityLabel?: string;
};

function StatChip({ icon, value, text, variant, accessibilityLabel }: StatChipProps) {
  const variantStyle =
    variant === 'success'
      ? s.chipSuccess
      : variant === 'muted'
        ? s.chipMuted
        : s.chipGhost;
  const textStyle =
    variant === 'success'
      ? s.chipTextSuccess
      : variant === 'muted'
        ? s.chipTextMuted
        : s.chipTextGhost;
  return (
    <View
      style={[s.chip, variantStyle]}
      accessible
      accessibilityLabel={accessibilityLabel ?? text ?? ''}
    >
      {icon && <Text style={s.chipIcon}>{icon}</Text>}
      {value != null && <Text style={[s.chipValue, textStyle]}>{value}</Text>}
      {text && <Text style={[s.chipText, textStyle]}>{text}</Text>}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Caret — rotates 0 → 180deg when the disclosure opens.
// ---------------------------------------------------------------------------

function DisclosureCaret({ open }: { open: boolean }) {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withTiming(open ? 1 : 0, {
      ...easeStandard,
      reduceMotion: ReduceMotion.Never,
    });
  }, [open, progress]);
  const animStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(progress.value, [0, 1], [0, 180])}deg` }],
  }));
  return (
    <Animated.Text style={[s.caret, animStyle]}>⌄</Animated.Text>
  );
}

// ---------------------------------------------------------------------------
// CodeInput — 4-box segmented entry for the room join code.
//
// Replaces the prior free-text TextInput with a placeholder string of "ABCD"
// that users repeatedly read as content rather than as a hint. The slot ITSELF
// communicates "4 chars expected" (Apple HIG OTP authentication / iOS 17+
// segmented digit entry / DIGIT design system) — no placeholder required.
//
// Implementation: single hidden TextInput owns the value (so paste, SMS
// auto-fill, accessibility, and the system keyboard all behave correctly);
// 4 display boxes render value[i]. When the user taps any box, the hidden
// input takes focus. The "cursor" box is whichever slot is the next to
// fill — it gets an accent border, no animation (KB §"Restraint over
// decoration" — cursor presence ≠ pulse).
//
// Input character set is the same curated alphabet the server uses
// (A–HJKMNP–Z + 2–9, no 0/O/1/I/L) so paste-from-message-app strips invalid
// chars on the way in.
// ---------------------------------------------------------------------------

const CODE_LEN = 4;

function CodeInput({
  value,
  onChange,
  editable,
}: {
  value: string;
  onChange: (next: string) => void;
  editable: boolean;
}) {
  const inputRef = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      onPress={() => inputRef.current?.focus()}
      accessibilityRole="none"
      style={s.codeRowOuter}
    >
      <View style={s.codeRow} pointerEvents="none">
        {Array.from({ length: CODE_LEN }).map((_, i) => {
          const ch = value[i] ?? '';
          const isCursor = focused && i === Math.min(value.length, CODE_LEN - 1) && ch === '';
          return (
            <View
              key={i}
              style={[
                s.codeBox,
                ch ? s.codeBoxFilled : null,
                isCursor ? s.codeBoxCursor : null,
              ]}
            >
              <Text style={s.codeBoxChar}>{ch}</Text>
            </View>
          );
        })}
      </View>
      {/* Hidden input — stays in the layout (not absolute) so the keyboard
          can find it, but visually invisible. caretHidden because the
          display boxes ARE the cursor. */}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={raw =>
          onChange(
            raw
              .toUpperCase()
              .replace(/[^A-HJKMNP-Z2-9]/g, '')
              .slice(0, CODE_LEN),
          )
        }
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        editable={editable}
        autoCapitalize="characters"
        autoCorrect={false}
        keyboardType="ascii-capable"
        maxLength={CODE_LEN}
        caretHidden
        selectTextOnFocus
        style={s.codeHiddenInput}
        accessibilityLabel="enter 4 character room code"
      />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// OrDivider — horizontal hairline + "OR" word, signals an exclusive choice
// between the two sub-cards (host / join) inside the private disclosure.
// Discord / Skype / Zoom join-or-create canon.
// ---------------------------------------------------------------------------

function OrDivider() {
  return (
    <View style={s.orDivider} accessible accessibilityLabel="or">
      <View style={s.orLine} />
      <Text style={s.orText}>OR</Text>
      <View style={s.orLine} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Avatar wins-today glow ramp.
//
// The avatar slot border + halo intensity scale with the player's
// wins-today count (resets at UTC midnight via server-side `firstWinAt`
// gating). Three goals:
//   (a) Make repeated daily wins feel earned — each win visibly
//       brightens the user's identity card without a popup.
//   (b) Span an emotionally legible ramp: cool (success mint) → warm
//       (gold) → electric (accent cyan). Color does the perceptual
//       work; thickness/shadow do the energy work.
//   (c) Cap at a generous PEAK so even a long session keeps reading
//       (saturated past 7 wins is fine — it's already maximally hot).
//
// Pure JS (no Reanimated worklet) because the ramp is computed once
// per home-screen render from a stable server value, not animated.
// Static glow is correct on a non-immersive surface — KB §Restraint
// over decoration.
// ---------------------------------------------------------------------------

const AVATAR_GLOW_PEAK_WINS = 7;

function avatarGlowFor(wins: number): {
  borderColor: string;
  borderWidth: number;
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
} | null {
  if (wins <= 0) return null;
  const intensity = Math.min(1, wins / AVATAR_GLOW_PEAK_WINS);
  // Color tiers — discrete (not interpolated) so each color reads as
  // a meaningful threshold rather than a muddy in-between. Crossing
  // 3 wins / 6 wins is a celebratory event the eye can recognise.
  const glowColor =
    wins < 3
      ? colors.success
      : wins < 6
        ? colors.warning
        : colors.accent;
  return {
    borderColor: glowColor,
    borderWidth: 1.5 + intensity * 1.5, // 1.5pt → 3pt
    shadowColor: glowColor,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4 + intensity * 0.45, // 0.4 → 0.85
    shadowRadius: 6 + intensity * 7, // 6pt → 13pt
  };
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { userId, ready } = useAuth();
  const profile = useUserProfile(userId);
  const elo = profile?.ratingElo ?? 1000;
  const leaderboard = useLeaderboard(ready);

  const [joinCode, setJoinCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [privateOpen, setPrivateOpen] = useState(false);

  const enterGlobal = async () => {
    if (!userId) return;
    setError(null);
    setLoading(true);
    try {
      await auth().currentUser?.getIdToken(true);
      const t0 = Date.now();
      const { roomId } = await callAssignGlobalRoom();
      logPerf('assignGlobalRoom', t0);
      const t1 = Date.now();
      await callJoinPrivateRoom(roomId);
      logPerf('joinPrivateRoom(global)', t1);
      router.push(`/game/${roomId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  };

  const createPrivate = async () => {
    if (!userId) return;
    setError(null);
    setLoading(true);
    try {
      await auth().currentUser?.getIdToken(true);
      const t0 = Date.now();
      const roomId = await callCreatePrivateRoom(difficulty);
      logPerf('createPrivateRoom (auto-joined)', t0);
      router.push(`/game/${roomId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  };

  const joinByCode = async () => {
    if (!userId || !joinCode.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await auth().currentUser?.getIdToken(true);
      // Codes are uppercase A–Z + 2–9 server-side. The input field
      // already auto-uppercases and strips junk, but we re-trim here
      // as a defence in depth before the round-trip.
      const code = joinCode.trim().toUpperCase();
      const t0 = Date.now();
      await callJoinPrivateRoom(code);
      logPerf('joinPrivateRoom', t0);
      router.push(`/game/${code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setLoading(false);
    }
  };

  // Reset progress = delete account in this anonymous-auth-only app.
  // Apple App Review 5.1.1(v) compliance for guest accounts. Friendly
  // "reset" framing on the trigger; alert body contains the literal
  // words "permanently delete" for App Review keyword search and so
  // consequence is unambiguous. NN/g destructive-confirm canon:
  // explicit verb on the destructive button, named consequence in the
  // body, Cancel as the safe default.
  //
  // Post-delete flow (matters because `Alert.alert` is dispatched
  // asynchronously by the OS — the destructive `onPress` handler fires
  // off the React render path):
  //   1. `deleteCurrentAccount()` calls the server `deleteAccount`
  //      callable (admin SDK does the actual Firestore + auth deletes,
  //      bypassing rules) then `auth().signOut()` locally so
  //      `onAuthStateChanged` fires immediately.
  //   2. `router.replace('/')` resets the navigation stack to the home
  //      route so any non-home screen (private-room flow, game
  //      screen, etc.) is dismissed BEFORE its listeners can fire on
  //      the now-deleted uid. Using `replace` (not `push`) so back-
  //      gesture can't return to a stale screen.
  //   3. `AuthProvider`'s second effect calls `signInAnonymously()`,
  //      assigning a fresh uid with zero progress.
  //   4. `useUserProfile(newUid)` returns a profile with no
  //      displayName.
  //   5. `NavigationGate` sees `!hasName && !onNameScreen` and
  //      `router.replace('/name')` — the user lands on the onboarding
  //      name screen, which is the closest thing this app has to a
  //      "sign in" page. Clean transition, no crash.
  const onResetProgress = useCallback(() => {
    Alert.alert(
      'reset progress?',
      "this will permanently delete your account, your rating, your stats, and your daily streak. you can't undo this.",
      [
        { text: 'cancel', style: 'cancel' },
        {
          text: 'reset',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteCurrentAccount();
              // Reset to the home route so any non-home screen (game,
              // private-room flow, etc.) is unmounted before its
              // listeners can fire on the now-deleted uid and crash.
              // NavigationGate will then bounce to /name on the next
              // render once the new anon user has loaded.
              router.replace('/');
            } catch (e) {
              const msg = e instanceof Error ? e.message : 'unknown error';
              Alert.alert(
                'reset failed',
                `couldn't delete the account (${msg}). check your connection and try again.`,
              );
            }
          },
        },
      ],
      { cancelable: true },
    );
  }, []);

  const dailyStreak = profile?.dailyStreak ?? 0;
  const winStreak = profile?.winStreak ?? 0;
  const lifetimeWins = profile?.roundsWon ?? 0;
  const todayKey = new Date().toISOString().slice(0, 10);
  // Effective wins-today — gate the raw counter on `firstWinAt`
  // matching today's UTC key. Server only advances `winsToday` when
  // the user wins; if their last win was yesterday, the field is
  // stale and must read as 0 until they win again. KB §Server-side
  // counters with client-side freshness gates.
  const wonTodayCount =
    profile?.firstWinAt === todayKey ? (profile?.winsToday ?? 0) : 0;
  const avatarGlow = avatarGlowFor(wonTodayCount);
  const live = ready && !loading;

  const tier = leagueTierFromElo(elo);
  // Placement period: hide the league badge, ELO column, and global rank
  // until the player has completed PLACEMENT_TOTAL_ROUNDS ranked rounds.
  // Riot LP placement-match canon — a numeric Elo/league assignment from
  // a single-digit sample size is statistical theatre, and showing it
  // makes a day-1 loss feel like an identity demotion. Replace with a
  // single "calibrating N/5" affordance so the player understands the
  // hidden state instead of seeing a missing field. Elo math itself
  // still runs underneath — only the surface representation is hidden.
  const placement = isInPlacement(profile?.roundsPlayed);
  const placementCount = Math.min(
    profile?.roundsPlayed ?? 0,
    PLACEMENT_TOTAL_ROUNDS,
  );
  // Pass the local uid so the ticker resolves the shard the user is
  // destined to be assigned to (uid-hash deterministic, mirrors
  // `assignGlobalRoomId` in functions/src/globalRooms.ts). Without this,
  // the ticker showed the busiest shard, which often differed from the
  // shard PLAY actually drops the user into — surfaced 2026-05-10 as
  // "live target on home is `plaza`, in-game target is `osprey`".
  const livePulse = useGlobalLivePulse(ready, userId);
  // Exact rank in the global pool (not bounded by the visible top-N).
  // Drives both the identity card RANK row and whether the leaderboard
  // shows a sticky-self pin above the top-10 list.
  const myGlobalRank = useMyGlobalRank(userId, elo);

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          s.container,
          {
            paddingTop: insets.top + space[3],
            paddingBottom: insets.bottom + space[6],
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* 1) Wordmark — anchors the brand at the top of the screen.
            Tagline removed (LivePulse / PLAY · LIVE already speak the
            action). Wordmark restored to 76pt (2026-05-10 #19). */}
        <Animated.View entering={enter(0)} style={s.hero}>
          <Text style={s.wordmark} accessibilityRole="header">tir</Text>
        </Animated.View>

        {profile && (
          <Animated.View entering={enter(1)} style={s.identityCard}>
            {/* Avatar slot — the border + glow intensity ramps with
                the player's wins-today count, resetting at UTC
                midnight. State-as-container-quality (KB §Restraint):
                the user IS the container, the container's quality
                changes with their hot streak. Color ramp:
                  • 0 wins: default hairline (cold)
                  • 1–2 wins: success mint (warm)
                  • 3–5 wins: gold (hot)
                  • 6+ wins: accent cyan (electric)
                Border thickness, shadow opacity, and shadow radius
                all scale with the same intensity so the glow feels
                physically brighter, not just recolored. Static (no
                idle animation) — KB §Restraint over decoration. */}
            <View
              style={[s.identityAvatarSlot, avatarGlow]}
              accessible
              accessibilityLabel={
                wonTodayCount > 0
                  ? `${profile.avatarEmoji ?? 'avatar'}, ${wonTodayCount} ${wonTodayCount === 1 ? 'win' : 'wins'} today`
                  : profile.avatarEmoji ?? 'avatar'
              }
            >
              <Text style={s.identityAvatar}>{profile.avatarEmoji ?? '🐺'}</Text>
            </View>
            <View style={s.identityCenter}>
              {/* Name row — chess.com title-prefix convention: the
                  league medal sits BEFORE the username on the same
                  baseline (cf. `GM Magnus Carlsen`). The medal is an
                  emoji glyph, so it carries its own visual
                  differentiation — no chip wrapper needed (would
                  compete with the avatar circle to the left). The
                  inline LeagueBadgePulse retains the tier-change
                  scale pulse (12% — 2× the chip variant since the
                  border highlight is gone). KB §Title-prefix
                  convention; chess.com canon. */}
              <View style={s.identityNameRow}>
                {/* Title-prefix glyph suppressed during placement — there is
                    no meaningful tier yet, so showing one would be wrong
                    (chess.com canon: title prefixes are earned, not
                    interim). The name slot just runs flush with the
                    avatar; the ELO column on the right carries the
                    "calibrating" affordance for the whole identity card. */}
                {!placement && (
                  <LeagueBadgePulse
                    tierKey={tier.key}
                    icon={tier.icon}
                    variant="inline"
                    accessibilityLabel={`${tier.name} league`}
                  />
                )}
                <Text
                  style={s.identityName}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {profile.displayName ?? 'player'}
                </Text>
              </View>
              {/* Stat chips — order is identity → multi-day →
                  multi-game (ascending volatility): 🏆 lifetime
                  wins (slowest-changing, identity-defining), 🔥
                  daily streak (multi-day), ⚡ win streak (most
                  volatile). Row only renders when at least one
                  chip exists so brand-new players get a tighter
                  identity card. KB §Don't reserve space for empty
                  rows. */}
              {(lifetimeWins > 0 || dailyStreak > 1 || winStreak > 0) && (
                <View style={s.identityChips}>
                  {lifetimeWins > 0 && (
                    <StatChip
                      icon="🏆"
                      value={lifetimeWins}
                      variant="muted"
                      accessibilityLabel={`${lifetimeWins} lifetime ${lifetimeWins === 1 ? 'win' : 'wins'}`}
                    />
                  )}
                  {dailyStreak > 1 && (
                    <StatChip
                      icon="🔥"
                      value={dailyStreak}
                      variant="muted"
                      accessibilityLabel={`${dailyStreak} day streak`}
                    />
                  )}
                  {winStreak > 0 && (
                    <StatChip
                      icon="⚡"
                      value={winStreak}
                      variant="muted"
                      accessibilityLabel={`${winStreak} win streak`}
                    />
                  )}
                </View>
              )}
            </View>
            {/* Right column — Apple-Sports-style scoreboard data grid.
                Each datum is a small caps eyebrow over a tabular number,
                right-aligned. ELO is named here (the canonical positive
                referent for the `NO ELO` tag elsewhere); rank is named
                so the bare `#3` doesn't read ambiguously. If the player
                isn't in the top N (rank query still resolving), the rank
                row is omitted rather than showing `#?`. KB §Stat chips,
                Lickability on Apple Sports. */}
            <View style={s.identityRight}>
              {placement ? (
                /* Single CALIBRATING block replaces the RANK + ELO grid
                   for the placement period. Rank from a placement-period
                   sample isn't trustworthy and ELO is intentionally
                   hidden (Riot LP canon), so the right column collapses
                   to one stat: the placement progress fraction. The
                   small-caps eyebrow + tabular numeral matches the
                   visual treatment of the other identity stats so the
                   card doesn't look broken — just on a different
                   trajectory. */
                <View
                  style={s.identityStatBlock}
                  accessible
                  accessibilityLabel={`calibrating, ${placementCount} of ${PLACEMENT_TOTAL_ROUNDS} placement rounds played`}
                >
                  <Text style={s.identityStatLabel}>CALIBRATING</Text>
                  <Text style={s.identityStatValue}>
                    {placementCount}/{PLACEMENT_TOTAL_ROUNDS}
                  </Text>
                </View>
              ) : (
                <>
                  {myGlobalRank != null && (
                    <View style={s.identityStatBlock}>
                      <Text style={s.identityStatLabel}>RANK</Text>
                      <Text style={s.identityStatValue}>#{myGlobalRank}</Text>
                    </View>
                  )}
                  <View
                    style={[
                      s.identityStatBlock,
                      myGlobalRank != null && s.identityStatBlockSpaced,
                    ]}
                    accessible
                    accessibilityLabel={`${Math.round(elo)} elo`}
                  >
                    <Text style={s.identityStatLabel}>ELO</Text>
                    <EloCountUp value={elo} style={s.identityStatValue} />
                  </View>
                </>
              )}
            </View>
          </Animated.View>
        )}

        {/* 3) PLAY — the only chunky CTA, paired with a chromeless
            LivePulse eyebrow directly above it (2026-05-10 #19). The
            eyebrow is the metadata for the action: putting it adjacent
            to the button it qualifies (NN/g proximity) lets the button
            label itself stay clean (`play`, no `· LIVE` suffix), and
            removes the duplicate `LIVE` chip the screen previously had
            at the top. The PlayShimmer overlay still fires once when
            the LivePulse advances a round (value-change motion, 8s
            cooldown). `overflow: 'hidden'` on the button clips the
            shimmer to the button radius. Difficulty is deliberately
            absent — it doesn't apply to global rooms. */}
        <Animated.View entering={enter(2)} style={s.primaryWrap}>
          <View style={s.primaryEyebrow}>
            <LivePulse
              live={live && livePulse != null}
              targetWord={livePulse?.targetWord}
              roundSeq={livePulse?.roundSeq}
              variant="eyebrow"
            />
          </View>
          <PressableScale
            onPress={enterGlobal}
            disabled={!ready || loading}
            accessibilityLabel={
              !ready
                ? 'signing in'
                : loading
                  ? 'connecting to global match'
                  : 'play live global match, auto-matched against other players'
            }
            accessibilityRole="button"
            accessibilityState={{ disabled: !ready || loading }}
          >
            <View style={s.primaryButton}>
              <PlayShimmer triggerKey={livePulse?.roundSeq ?? null} />
              <Text style={s.primaryButtonText}>
                {!ready ? 'signing in' : loading ? 'connecting' : 'play'}
              </Text>
            </View>
          </PressableScale>
        </Animated.View>

        {error && <Text style={s.error}>{error}</Text>}

        {/* 4) Private rooms — collapsed disclosure row.
            Single recessive line by default; tap to reveal create/join +
            the difficulty selector. Difficulty lives INSIDE this
            disclosure because it only configures private rooms; placing
            it outside misleads users into thinking it changes the global
            match (it doesn't). NN/g Progressive Disclosure. */}
        <Animated.View entering={enter(3)} style={s.privateSection}>
          <PressableScale
            onPress={() => setPrivateOpen(o => !o)}
            accessibilityRole="button"
            accessibilityLabel={
              privateOpen
                ? 'collapse private rooms section'
                : 'expand private rooms — practice solo or play with friends, no elo at stake'
            }
            accessibilityState={{ expanded: privateOpen }}
          >
            <View style={s.privateHeader}>
              <View style={s.privateHeaderLeft}>
                {/* Title row: feature name + a small mono "NO ELO" tag.
                    The tag surfaces the no-stakes promise at decision
                    time — without it, a returning player can't tell
                    from the home screen whether hosting a friends room
                    risks their hard-earned Elo. The answer (no — see
                    rewards.ts: practice rooms skip Elo entirely) was
                    previously only revealed in the post-game results
                    popup. KB §"Surface scope at decision time, not
                    reveal time" (2026-05-09 #17). */}
                <View style={s.privateTitleRow}>
                  <Text style={s.privateLabel}>private rooms</Text>
                  <View style={s.privateNoEloTag}>
                    <Text style={s.privateNoEloTagText}>NO ELO</Text>
                  </View>
                </View>
                <Text style={s.privateSub}>practice or play with friends</Text>
              </View>
              <DisclosureCaret open={privateOpen} />
            </View>
          </PressableScale>

          {privateOpen && (
            <Animated.View
              entering={FadeInDown.duration(220)}
              exiting={FadeOutUp.duration(140)}
              style={s.privateBody}
            >
              {/* HOST sub-card.
                  Owns the "I am starting a room" path. Difficulty lives
                  INSIDE this card (not as a sibling) because joiners
                  inherit the host's difficulty — surfacing it elsewhere
                  would lie about its scope. NN/g Heuristic #4
                  (consistency: container = scope). */}
              <View style={s.subCard}>
                <Text style={s.subCardEyebrow}>HOST A ROOM</Text>
                {/* Subline mirrors the collapsed disclosure teaser
                    exactly ("practice or play with friends") so the
                    framing is reinforced on expand, not contradicted.
                    The previous copy ("invite friends and pick the
                    difficulty") silently dropped the practice-solo use
                    case — a narrative inconsistency users called out
                    in 2026-05-09 #17. The DIFFICULTY label below
                    communicates the configuration affordance without
                    needing the subline to mention it. */}
                <Text style={s.subCardSub}>
                  practice solo or play with friends
                </Text>

                <Text style={s.fieldLabel}>difficulty</Text>
                <View style={s.diffRow} accessibilityRole="radiogroup">
                  {DIFFICULTIES.map((d, i) => {
                    const isActive = difficulty === d;
                    return (
                      <View key={d} style={s.diffItem}>
                        {i > 0 && <Text style={s.diffSep}>·</Text>}
                        <PressableScale
                          onPress={() => setDifficulty(d)}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: isActive }}
                          accessibilityLabel={`difficulty ${d}${
                            isActive ? ', selected' : ''
                          }`}
                        >
                          <View style={s.diffWordHit}>
                            <Text
                              style={[
                                s.diffWord,
                                isActive && s.diffWordActive,
                              ]}
                            >
                              {d}
                            </Text>
                          </View>
                        </PressableScale>
                      </View>
                    );
                  })}
                </View>

                <PressableScale
                  onPress={createPrivate}
                  disabled={!ready || loading}
                  accessibilityLabel={`host a new private room with ${difficulty} difficulty`}
                  accessibilityRole="button"
                >
                  <View style={s.subCardCta}>
                    <Text style={s.subCardCtaText}>host</Text>
                  </View>
                </PressableScale>
              </View>

              <OrDivider />

              {/* JOIN sub-card.
                  Owns the "I have a code from a friend" path. Uses the
                  segmented CodeInput (4 boxes) instead of a free-text
                  TextInput with placeholder — the slot itself is the
                  hint. Apple HIG OTP authentication / iOS 17+ segmented
                  digit entry. */}
              <View style={s.subCard}>
                <Text style={s.subCardEyebrow}>JOIN A ROOM</Text>
                {/* "from a friend" not "from your friend" — less
                    presumptuous and parallels the HOST sub's neutral
                    phrasing. The "4-character" detail telegraphs the
                    expected input length so users don't need to count
                    the boxes. */}
                <Text style={s.subCardSub}>
                  enter the 4-character code from a friend
                </Text>

                <CodeInput
                  value={joinCode}
                  onChange={setJoinCode}
                  editable={ready && !loading}
                />

                <PressableScale
                  onPress={joinByCode}
                  disabled={!ready || joinCode.length !== CODE_LEN || loading}
                  accessibilityLabel={
                    joinCode.length === CODE_LEN
                      ? `join room with code ${joinCode.split('').join(' ')}`
                      : 'enter a 4 character code to join'
                  }
                  accessibilityRole="button"
                >
                  <View
                    style={[
                      s.subCardCta,
                      joinCode.length !== CODE_LEN && s.subCardCtaDisabled,
                    ]}
                  >
                    <Text
                      style={[
                        s.subCardCtaText,
                        joinCode.length !== CODE_LEN && s.subCardCtaTextDisabled,
                      ]}
                    >
                      join
                    </Text>
                  </View>
                </PressableScale>
              </View>
            </Animated.View>
          )}
        </Animated.View>

        {/* 5) Leaderboard — moved BACK below private rooms (2026-05-10 #19,
            user reverted #18 promotion). Both surfaces are secondary to
            PLAY; the user prefers the original ordering where private
            sits closer to the primary action and leaderboard reads as
            the long-tail "did I move?" surface at the bottom. Top-N +
            sticky-self pinning keeps the player visible even at
            rank 100+. Row layout-transition animates rank swaps when
            the snapshot changes (value-change motion, KB §Restraint). */}
        {leaderboard.length > 0 && (
          <Animated.View entering={enter(4)} style={s.leaderboardSection}>
            <View style={s.leaderboardHeader}>
              <Text style={s.sectionLabel}>LEADERBOARD</Text>
              <Text style={s.sectionLabelMeta}>
                TOP {Math.min(leaderboard.length, LEADERBOARD_VISIBLE)}
              </Text>
            </View>
            <View style={s.leaderboardCard}>
              {/* Sticky self row — pinned at top of the card if the
                  player is NOT in the visible top-N. Avoids the dead
                  "I'm not here" feeling for ranks 11+ (Spotify Wrapped /
                  chess.com pattern). When the player IS in the top N,
                  the row in the list itself is highlighted instead and
                  this sticky row is omitted (no duplication).

                  Placement gating (2026-05-10 #41): during the first 5
                  ranked rounds the rest of the home hides the player's
                  numerical Elo (identity card right-column collapses to
                  CALIBRATING N/5, game stats bar mirrors it). The
                  leaderboard self-row used to leak the same hidden
                  number — same player, same screen, two different
                  surface treatments. NN/g §Heuristic 4 (Consistency
                  and Standards) violation. We now treat placement as a
                  whole-screen story: the self-row replaces the Elo
                  numeral with the same `N/5 cal` chip and drops the
                  league badge (the player isn't on the ladder yet, so
                  no tier glyph is meaningful). Riot LP placements
                  canon: placement matches don't put you on the visible
                  ranked ladder until they complete
                  (https://support-leagueoflegends.riotgames.com/hc/en-us/articles/4405783687443). */}
              {profile &&
                myGlobalRank != null &&
                myGlobalRank > LEADERBOARD_VISIBLE && (
                  <View style={[s.leaderRow, s.leaderRowSelf, s.leaderRowSticky]}>
                    <Text style={[s.leaderRank, s.leaderTextSelf]}>
                      {placement ? '—' : String(myGlobalRank).padStart(2, '0')}
                    </Text>
                    <Text style={s.leaderEmoji}>
                      {profile.avatarEmoji ?? '🐺'}
                    </Text>
                    <Text
                      style={[s.leaderName, s.leaderTextSelf]}
                      numberOfLines={1}
                    >
                      {profile.displayName ?? 'player'}
                      <Text style={s.leaderSelfTag}>  you</Text>
                    </Text>
                    {placement ? (
                      <Text
                        style={[s.leaderElo, s.leaderTextSelf, s.leaderEloPlacement]}
                        accessibilityLabel={`calibrating ${placementCount} of ${PLACEMENT_TOTAL_ROUNDS}`}
                      >
                        {placementCount}/{PLACEMENT_TOTAL_ROUNDS}
                      </Text>
                    ) : (
                      <Text style={[s.leaderElo, s.leaderTextSelf]}>
                        {Math.round(elo)}
                      </Text>
                    )}
                    {!placement && (
                      <Text style={s.leaderLeague}>{tier.icon}</Text>
                    )}
                  </View>
                )}
              {leaderboard.map((item, index) => {
                const isSelf = item.uid === userId;
                // Derive the tier from ratingElo, not from item.league.
                // Legacy publicProfiles documents still hold capitalised
                // strings ("Bronze") from the old 5-tier server; deriving
                // here means the new ladder renders immediately for every
                // row without requiring a backfill.
                const rowTier = leagueTierFromElo(item.ratingElo);
                const isLast = index === leaderboard.length - 1;
                // Placement gating for the SELF row only — see the
                // sticky-self block above for the full rationale. We
                // can't gate placement on OTHER rows without adding
                // `roundsPlayed` to the publicProfiles mirror; the self
                // row is the surface that has to match the identity
                // card's CALIBRATING affordance, so that's what we fix.
                const showPlacementForSelf = isSelf && placement;
                return (
                  <Animated.View
                    key={item.uid}
                    layout={LinearTransition.duration(280)}
                    style={[
                      s.leaderRow,
                      !isLast && s.leaderRowBorder,
                      isSelf && s.leaderRowSelf,
                    ]}
                  >
                    <Text style={[s.leaderRank, isSelf && s.leaderTextSelf]}>
                      {showPlacementForSelf ? '—' : String(index + 1).padStart(2, '0')}
                    </Text>
                    <Text style={s.leaderEmoji}>{item.avatarEmoji}</Text>
                    <Text
                      style={[s.leaderName, isSelf && s.leaderTextSelf]}
                      numberOfLines={1}
                    >
                      {item.displayName}
                      {isSelf && <Text style={s.leaderSelfTag}>  you</Text>}
                    </Text>
                    {showPlacementForSelf ? (
                      <Text
                        style={[s.leaderElo, s.leaderTextSelf, s.leaderEloPlacement]}
                        accessibilityLabel={`calibrating ${placementCount} of ${PLACEMENT_TOTAL_ROUNDS}`}
                      >
                        {placementCount}/{PLACEMENT_TOTAL_ROUNDS}
                      </Text>
                    ) : (
                      <Text style={[s.leaderElo, isSelf && s.leaderTextSelf]}>
                        {Math.round(item.ratingElo)}
                      </Text>
                    )}
                    {showPlacementForSelf ? (
                      // Placeholder dot keeps the row's column rhythm
                      // intact (the league glyph cell would otherwise
                      // collapse and the Elo value would jump right).
                      <Text style={[s.leaderLeague, s.leaderLeaguePlacement]}>·</Text>
                    ) : (
                      <Text
                        style={s.leaderLeague}
                        accessibilityLabel={`${rowTier.name} league`}
                      >
                        {rowTier.icon}
                      </Text>
                    )}
                  </Animated.View>
                );
              })}
            </View>
          </Animated.View>
        )}

        {/* 6) Account footer — terminal placement for the destructive
            "reset progress" affordance. Apple App Store Review 5.1.1(v)
            requires guest/anonymous-account apps to offer in-app account
            deletion (https://developer.apple.com/support/offering-account-deletion-in-your-app).
            Wrapped in friendly "reset" copy because in this app, with
            anonymous-only auth, deleting and starting over are the same
            operation — but the confirmation Alert body contains the
            literal words "permanently delete" so App Review text searches
            still find the affordance. KB §Destructive actions: findable,
            not loud — terminal footer placement (below the leaderboard,
            small dim type, no chrome) matches Linear / Things 3 / Apple
            Sports settings convention. Color is `colors.dim`, NOT
            `colors.danger` — the destructive intent is communicated by
            the alert, not by the affordance itself, so the home screen
            doesn't shout "RED BUTTON" at every paint. */}
        <Animated.View entering={enter(5)} style={s.footerSection}>
          <Pressable
            onPress={onResetProgress}
            accessibilityLabel="reset progress, permanently deletes your account and all data"
            accessibilityRole="button"
            accessibilityHint="opens a confirmation dialog"
            hitSlop={12}
            style={({ pressed }) => [
              s.footerButton,
              pressed && { opacity: 0.45 },
            ]}
          >
            <Text style={s.footerButtonText}>reset progress</Text>
            <Text style={s.footerButtonSubtext}>
              permanently deletes account & all data
            </Text>
          </Pressable>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  container: {
    flexGrow: 1,
    paddingHorizontal: layout.pagePaddingH,
  },

  hero: {
    marginTop: space[5],
  },
  // Wordmark restored to 76pt (2026-05-10 #19). The 32pt shrink in #18
  // read as too recessive — the brand mark anchors the screen and a
  // returning player should feel the brand on first paint. Tagline
  // remains dropped (LivePulse / PLAY · LIVE already speak the action).
  wordmark: {
    color: colors.text,
    fontSize: 76,
    fontWeight: '800',
    letterSpacing: -3,
    lineHeight: 80,
    fontFamily: Platform.select({ ios: 'System', android: 'Roboto' }),
  },

  identityCard: {
    marginTop: space[5],
    flexDirection: 'row',
    alignItems: 'center',
    // 16pt internal padding (was 12pt) — sits on the canonical 8pt
    // grid step that gives identity-class cards their breathing room
    // (Linear, Apple Sports, Things 3 all use 16pt). KB §8pt grid.
    paddingVertical: space[4],
    paddingHorizontal: space[4],
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    gap: space[3],
  },
  identityAvatarSlot: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    // Default border is transparent — the wins-today glow ramp
    // (`avatarGlowFor`) overrides borderColor/Width/shadow* when
    // the player has any wins today. Static for 0 wins, ramped for
    // 1..AVATAR_GLOW_PEAK_WINS, saturated thereafter.
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  identityAvatar: {
    // Hero glyph for the user's own face inside the 44pt identity
    // circle. `glyph(24)` pins fontFamily + clamps lineHeight so the
    // emoji visually centers inside the circle (without it, iOS
    // Apple Color Emoji's inflated line-box pushes the glyph 2-3px
    // off-center). KB §Emoji baseline alignment.
    ...glyph(24),
  },
  identityCenter: {
    flex: 1,
    minWidth: 0,
  },
  // Name row — flex row that holds the inline league medal + the
  // username on the same baseline (chess.com title-prefix). 6pt gap
  // mirrors chess.com's prefix-to-name spacing. `flex: 1` on the
  // name lets it ellipsise rather than push the medal off-screen.
  identityNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  identityName: {
    color: colors.text,
    ...typo.title,
    fontSize: 17,
    lineHeight: 20,
    flexShrink: 1,
  },
  identityChips: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: space[2],
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.pill,
    gap: 4,
  },
  chipGhost: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: 'transparent',
  },
  chipMuted: {
    backgroundColor: colors.card,
  },
  chipSuccess: {
    backgroundColor: 'rgba(124,255,178,0.10)',
  },
  chipIcon: {
    // StatChip glyph (🏆 / 🔥 / ⚡). Sourced from the shared `glyph()`
    // helper so it renders with the same metrics as every other
    // emoji surface in the app — without it, RN-iOS Apple Color
    // Emoji inflates the chip's line-box and the number sits a px
    // or two below the emoji baseline.
    ...glyph(13),
  },
  chipValue: {
    ...typo.mono,
    fontSize: 12,
    fontWeight: '700',
    lineHeight: 14,
  },
  chipText: {
    ...typo.eyebrow,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.2,
  },
  chipTextGhost: {
    color: colors.muted,
  },
  chipTextMuted: {
    color: colors.text,
  },
  chipTextSuccess: {
    color: colors.success,
  },
  // Apple-Sports-style data grid on the right of the identity card.
  // Each datum is a small caps eyebrow over a tabular number,
  // right-aligned. Two stacked blocks (RANK / ELO) when the player is
  // ranked; ELO alone otherwise. KB §Stat chips, Lickability on Apple
  // Sports' dense data grid.
  identityRight: {
    alignItems: 'flex-end',
    minWidth: 64,
  },
  identityStatBlock: {
    alignItems: 'flex-end',
  },
  identityStatBlockSpaced: {
    marginTop: space[2],
  },
  identityStatLabel: {
    color: colors.dim,
    ...typo.eyebrow,
    fontSize: 9,
    letterSpacing: 1.2,
    lineHeight: 12,
  },
  identityStatValue: {
    color: colors.text,
    ...typo.monoLg,
    fontSize: 18,
    lineHeight: 22,
    marginTop: 1,
  },

  primaryWrap: {
    marginTop: space[5],
  },
  // Chromeless eyebrow above PLAY — hosts the LivePulse(variant='eyebrow').
  // Sits a hair above the button (`marginBottom: 6`) so it reads as the
  // button's metadata, not as a separate row.
  //
  // Cross-axis alignment is intentionally NOT set: default `alignItems:
  // 'stretch'` lets the LivePulse stretch to the wrapper's full width,
  // which in turn matches the PLAY button's full width. The eyebrow's
  // own `justifyContent: 'flex-start'` then left-anchors its content to
  // the button's outer left edge (Apple HIG form-row canon — labels
  // live on the left). See LivePulse `pulseEyebrow` style for the full
  // rationale on why stable left axis beats moving centered centroid.
  // 8pt grid alignment (was 6pt) — sits the eyebrow at the same
  // rhythm as every other vertical gap on the screen.
  primaryEyebrow: {
    marginBottom: space[1] * 2, // 8pt
  },
  // overflow: 'hidden' clips the PlayShimmer overlay to the button radius.
  // Single label `play` (no in-button `· LIVE` suffix — moved to the
  // chromeless eyebrow above the button so the live signal lives on
  // exactly one surface). 60pt minHeight + 20pt vertical padding
  // (was 56/18) — primary CTA substance per Apple HIG (44pt is the
  // minimum tap target; primary full-width CTAs benefit from 56–60pt).
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    paddingVertical: 20,
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    minHeight: 60,
    overflow: 'hidden',
  },
  primaryButtonText: {
    color: colors.bg,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },

  // ---- Private disclosure ---------------------------------------------
  // Restored to its original position immediately under PLAY (2026-05-10
  // #19, reverting #18). Standard section gap (space[6] = 32pt) reads
  // as part of the same primary-action cluster as PLAY, separating the
  // long-tail leaderboard below.
  privateSection: {
    marginTop: space[6],
  },
  privateHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space[3],
    paddingHorizontal: space[3],
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: 'transparent',
    minHeight: layout.minTapTarget,
  },
  privateHeaderLeft: {
    flex: 1,
    minWidth: 0,
  },
  privateTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  privateLabel: {
    color: colors.text,
    ...typo.body,
    fontSize: 14,
    fontWeight: '600',
  },
  // NO ELO tag — small mono pill next to the section title. Uses the
  // accent color in low-saturation form (accentSoft fill, full accent
  // text) so it reads as a status badge, not a CTA. The accent reuse
  // is permitted here because the badge marks scope, not interactivity
  // (KB §"Color reserved for meaning"). Tabular caps fontSize 9 fits
  // beside a 14pt body label without crowding.
  privateNoEloTag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  privateNoEloTagText: {
    ...typo.eyebrow,
    color: colors.accent,
    fontSize: 9,
    letterSpacing: 1.2,
  },
  privateSub: {
    color: colors.dim,
    ...typo.micro,
    fontSize: 11,
    marginTop: 2,
    letterSpacing: 0.2,
  },
  caret: {
    color: colors.muted,
    fontSize: 16,
    fontWeight: '700',
    width: 16,
    textAlign: 'center',
  },
  privateBody: {
    marginTop: space[2],
    padding: space[3],
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },

  // ---- Two sub-cards (HOST / JOIN) inside the private disclosure ------
  // Each sub-card is its own surface, distinct from the disclosure
  // wrapper, so the user reads HOST and JOIN as two parallel choices,
  // not as one form. Eyebrow + sub + control + CTA stack inside each.
  subCard: {
    backgroundColor: colors.card,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: space[4],
    paddingHorizontal: space[4],
  },
  subCardEyebrow: {
    color: colors.muted,
    ...typo.eyebrow,
    fontSize: 11,
  },
  subCardSub: {
    color: colors.dim,
    ...typo.body,
    fontSize: 13,
    marginTop: 2,
  },
  subCardCta: {
    marginTop: space[4],
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: 14,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: layout.minTapTarget,
  },
  subCardCtaDisabled: {
    opacity: 0.45,
  },
  subCardCtaText: {
    color: colors.text,
    ...typo.body,
    fontWeight: '700',
    fontSize: 16,
    letterSpacing: 0.5,
  },
  subCardCtaTextDisabled: {
    color: colors.muted,
  },

  // ---- OR divider between HOST and JOIN sub-cards ---------------------
  orDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: space[3],
    paddingHorizontal: space[2],
  },
  orLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  orText: {
    color: colors.dim,
    ...typo.eyebrow,
    fontSize: 10,
    marginHorizontal: space[3],
  },

  // ---- Field label inside a sub-card (e.g. "difficulty") --------------
  fieldLabel: {
    color: colors.dim,
    ...typo.eyebrow,
    fontSize: 10,
    marginTop: space[4],
  },

  sectionLabel: {
    color: colors.dim,
    ...typo.eyebrow,
  },
  sectionLabelMeta: {
    color: colors.dim,
    ...typo.eyebrow,
    fontSize: 10,
  },

  // ---- Difficulty selector --------------------------------------------
  diffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space[1],
    flexWrap: 'wrap',
  },
  diffItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  diffSep: {
    color: colors.border,
    ...typo.body,
    marginHorizontal: space[2],
  },
  diffWordHit: {
    paddingVertical: space[2],
    minHeight: layout.minTapTarget - 8,
    justifyContent: 'center',
  },
  diffWord: {
    color: colors.dim,
    ...typo.body,
    fontSize: 16,
    fontWeight: '500',
  },
  diffWordActive: {
    color: colors.text,
    fontWeight: '700',
  },

  // ---- Segmented 4-box code input -------------------------------------
  // Pressable wraps the row + the hidden input; tapping anywhere focuses
  // the input. The hidden input occupies zero visible height (1pt with
  // opacity 0) so the row's natural layout is preserved.
  codeRowOuter: {
    marginTop: space[3],
  },
  codeRow: {
    flexDirection: 'row',
    gap: space[2],
    justifyContent: 'space-between',
  },
  codeBox: {
    flex: 1,
    aspectRatio: 1,
    maxWidth: 64,
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBoxFilled: {
    borderColor: colors.muted,
    backgroundColor: colors.card,
  },
  codeBoxCursor: {
    borderColor: colors.accent,
    borderWidth: 1.5,
  },
  codeBoxChar: {
    ...typo.mono,
    color: colors.text,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: 1,
    lineHeight: 30,
  },
  codeHiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    color: 'transparent',
    bottom: 0,
    left: 0,
  },

  leaderboardSection: {
    marginTop: space[6],
  },
  leaderboardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space[3],
  },
  leaderboardCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  leaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space[3],
    paddingHorizontal: space[3],
    gap: space[3],
  },
  leaderRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  leaderRowSelf: {
    backgroundColor: colors.accentSoft,
  },
  // Sticky "you" row variant — pinned at the top of the leaderboard
  // card when the player is NOT in the visible top-N. A heavier bottom
  // border (vs the standard hairline between rows) creates a clear
  // "this is your row, the list of others starts below" affordance —
  // Spotify Wrapped / chess.com sticky-self pattern.
  leaderRowSticky: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  leaderRank: {
    color: colors.dim,
    ...typo.mono,
    width: 24,
    textAlign: 'left',
  },
  leaderEmoji: {
    // Row glyph — same metrics as the game-screen stats-bar self
    // avatar so a player who looks at their face on the leaderboard
    // and then their face on the stats bar sees identical
    // rendering. KB §Cross-screen identity treatment.
    ...glyph(18),
    width: 22,
    textAlign: 'center',
  },
  leaderName: {
    color: colors.text,
    ...typo.body,
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
    minWidth: 0,
  },
  leaderSelfTag: {
    color: colors.muted,
    ...typo.eyebrow,
    fontSize: 9,
    fontWeight: '500',
  },
  leaderElo: {
    color: colors.text,
    ...typo.mono,
    fontSize: 14,
    fontWeight: '600',
    width: 48,
    textAlign: 'right',
  },
  leaderLeague: {
    // Tier badge column — same 16pt metric used by the inline
    // league badge on the identity card and the roster glyphs in
    // the game stats bar.
    ...glyph(16),
    width: 28,
    textAlign: 'right',
  },
  // Placement-state replacements (self row only, see leaderboard
  // gating block above). Tone the Elo numeral down to muted weight
  // so the row reads "this is a status, not a score" — the player
  // hasn't earned a number yet. The league-cell middot is a visual
  // placeholder to keep the column rhythm intact when the tier
  // glyph is intentionally absent (Riot LP convention: no tier
  // badge during placements).
  leaderEloPlacement: {
    color: colors.muted,
    fontWeight: '600',
  },
  leaderLeaguePlacement: {
    color: colors.muted,
    fontSize: 14,
  },
  leaderTextSelf: {
    color: colors.accent,
  },

  error: {
    marginTop: space[4],
    color: colors.danger,
    ...typo.micro,
    fontWeight: '600',
  },

  // ---- Account footer -----------------------------------------------------
  // Terminal placement, restraint-first styling. The footer is a single
  // tap target with two centered text rows — primary verb + consequence
  // subtitle. No card chrome, no background fill, no border. The intent
  // is "barely there until you need it" — Linear / Things 3 / Apple
  // Sports settings convention. KB §Restraint over decoration on
  // non-immersive home screens. min-tap-target enforced via padding +
  // hitSlop on the Pressable; visual size is intentionally smaller than
  // the actual hit area (HIG §Tap targets — visual ≤ hit, not >).
  footerSection: {
    marginTop: space[6],
    marginBottom: space[3],
    alignItems: 'center',
  },
  footerButton: {
    paddingVertical: space[3],
    paddingHorizontal: space[4],
    alignItems: 'center',
    minHeight: layout.minTapTarget,
    justifyContent: 'center',
  },
  footerButtonText: {
    color: colors.dim,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  footerButtonSubtext: {
    color: colors.dim,
    fontSize: 11,
    marginTop: 2,
    opacity: 0.7,
  },
});
