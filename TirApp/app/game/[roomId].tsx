import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Share, StyleSheet, Text, View, Pressable } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import firestore from '@react-native-firebase/firestore';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withSequence,
  interpolateColor,
  Easing,
} from 'react-native-reanimated';
import { useAuth, useUserProfile } from '../../lib/auth';
import { colors, radius, space, layout } from '../../lib/theme';
import { glyph, type as typo } from '../../lib/typography';
import {
  springTap,
  springTapEffect,
  springAdvance,
  springReveal,
  easeStandard,
  easeOut,
  DURATION,
} from '../../lib/motion';
import * as haptics from '../../lib/haptics';
import { shareViewAsImage } from '../../lib/share';
import {
  callAdvanceRound,
  callFinalizeFinishWindow,
  callHeartbeat,
  callLeaveRoom,
  callSubmitMove,
  isInPlacement,
  leagueTierFromElo,
  logPerf,
  myPlayerDoc,
  PLACEMENT_TOTAL_ROUNDS,
  playersCollection,
  roomDoc,
  roundDoc,
  type MyPlayerState,
  type RoundResultsSnapshot,
  type RoundState,
} from '../../src/rooms/privateRooms';

type RosterEntry = {
  id: string;
  currentWord: string;
  displayName?: string;
  avatarEmoji?: string;
  lastRoundDelta?: number;
  // Round seq the lastRoundDelta belongs to. Used to verify that a
  // delta value pulled from the player doc actually belongs to the
  // round the popup is rendering — otherwise the previous round's
  // delta can leak onto the popup for ~300ms before commitRoundDeltas
  // overwrites it. See KB §results-popup-must-render-correct-elo-on-first-frame.
  lastRoundDeltaSeq?: number;
};

type RoundResultView = {
  winnerUid: string | null;
  winnerName: string | null;
  winnerEmoji: string | null;
  photoFinishers: string[];
  targetWord: string;
  myOutcome: 'win' | 'photo' | 'loss';
  // null = delta hasn't landed yet (no embedded value AND no fresh
  // roster value for this round seq). Render as `…` instead of a
  // potentially-stale number.
  eloChange: number | null;
  winnerMoves: number | null;
  winnerSnap: boolean;
  myMoves: number | null;
  // false for private (practice / friends) rounds — the popup renders
  // a "PRACTICE" affordance instead of an Elo chip. Defaults to true
  // for back-compat with results blobs that pre-date the `ranked`
  // field on the server.
  ranked: boolean;
  // Post-this-round count of completed rounds for the local player.
  // null when unavailable (legacy round.results blob from before the
  // placement system existed). Drives the placement-banner branch on
  // the popup: when not null AND <= PLACEMENT_TOTAL_ROUNDS the popup
  // hides the Elo numeral and shows "Calibrating N/5" instead.
  myRoundsAfter: number | null;
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Semantic temperature: maps cosine distance (0=target, 1=far) to a glow intensity.
// Subconscious feedback per KB §Proximity feedback as ambient mood.
function distToHeat(dist: number | undefined): number {
  if (dist === undefined) return 0;
  return Math.max(0, Math.min(1, 1 - dist));
}

// ---------------------------------------------------------------------------
// OptionChip — the most-pressed thing in the app. THE marquee mechanic.
//
// Latency budget (ux-design-expert pass 2026-05-10 #39):
//   - <100ms = "instantaneous" (Doherty + DeviceLab thresholds).
//   - Visual feedback fires synchronously inside `onPressIn` (UI-thread
//     animations via Reanimated shared values).
//   - The server submitMove call ALSO fires from `onPressIn` (not the
//     usual `onPress`), saving 100-250ms of touchUp + iOS gesture-
//     disambiguation grace. Drag-out-to-cancel is sacrificed; the
//     84pt-tall chip + game-pace tapping make that a non-issue.
//   - The picked chip LATCHES (tint=1, scale=0.97) until the server
//     acknowledges, while the other 3 chips DIM to 0.4. This carries
//     visual confirmation across the 300-800ms server round-trip so
//     there is no "did it register?" gap. Optimistic UI pattern
//     (https://simonhearne.com/2021/optimistic-ui-patterns/).
//   - Haptic switched from selectionAsync to impactAsync(Light) per
//     Apple HIG: selection is for incremental value changes (pickers),
//     impact is for button presses. See lib/haptics.ts.
// ---------------------------------------------------------------------------

function OptionChip({
  word,
  onPress,
  disabled = false,
  latched = false,
  dimmed = false,
}: {
  word: string;
  onPress: () => void;
  // True once the player has reached the target (winner or photo
  // finisher). Chip stays mounted but non-interactive + 50% opacity.
  // Apple HIG disabled-state guidance.
  disabled?: boolean;
  // True when this is the chip the player just picked and we're
  // waiting for the server to confirm. Chip holds at scale 0.97 +
  // accent tint until the server-confirmed `myPlayer.currentWord`
  // matches `word`, at which point the parent clears `pendingPick`
  // and this prop flips back to false (and the new options arrive).
  latched?: boolean;
  // True when ANOTHER chip is latched (a sibling pick is in flight).
  // This chip dims to 0.4 and becomes non-interactive so the player
  // can't double-tap mid-flight and so the visual hierarchy obviously
  // shows which one was picked.
  dimmed?: boolean;
}) {
  const scale = useSharedValue(1);
  const tintProgress = useSharedValue(0);
  const opacity = useSharedValue(1);

  // Latch animation. Triggered by the parent setting `latched` after it
  // sees this chip's onPressIn. Smoothly hands off from the in-flight
  // press animation (scale toward 0.94) to the latched rest position
  // (scale 0.97 with springTap's slight overshoot — the satisfying
  // "settled" beat). Keeping tint at 1 here is the persistent visual
  // proof of "this is the one you chose" through the network wait.
  useEffect(() => {
    if (latched) {
      scale.value = withSpring(0.97, springTap);
      tintProgress.value = withTiming(1, { duration: 90 });
    } else {
      // Unlatch — happens when the server confirms (and the chip is
      // about to unmount because new options replace this grid) OR
      // when an error reverts the optimistic state.
      scale.value = withSpring(1, springTap);
      tintProgress.value = withTiming(0, { duration: DURATION.chipPress });
    }
  }, [latched]);

  // Sibling-pick dim. 0.4 instead of 0.5 (the disabled state) so the
  // dimmed-during-pending state is visually distinguishable from the
  // dimmed-because-finish-window state — the player can read at a
  // glance "I'm waiting for my own pick" vs "the round is locked".
  useEffect(() => {
    opacity.value = withTiming(dimmed ? 0.4 : 1, {
      duration: DURATION.chipPress,
    });
  }, [dimmed]);

  const effectiveDisabled = disabled || dimmed;

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
    backgroundColor: interpolateColor(
      tintProgress.value,
      [0, 1],
      [colors.card, colors.accentSoft],
    ),
    borderColor: interpolateColor(
      tintProgress.value,
      [0, 1],
      [colors.border, colors.accent],
    ),
  }));

  return (
    <AnimatedPressable
      style={[s.optionChip, animStyle, disabled && s.optionChipDisabled]}
      disabled={effectiveDisabled}
      onPressIn={() => {
        if (effectiveDisabled) return;
        // Synchronous, UI-thread-driven press response. Fires INSIDE
        // onPressIn so visual + haptic + server commit all happen on
        // touchdown — no waiting for touchUp + iOS's ~80ms gesture
        // disambiguation. Total perceived latency: a single frame.
        haptics.chipSelect();
        // springTapEffect (stiffness 3800, dampingRatio 1.0) reaches
        // 0.94 fast with no overshoot — perfect for the compression
        // beat. The latched useEffect (one render later) hands off
        // to springTap for the slight rebound to 0.97.
        scale.value = withSpring(0.94, springTapEffect);
        tintProgress.value = withTiming(1, { duration: 90 });
        // Fire the server commit. Parent will set `latched` on its
        // next render, which holds these values in place until the
        // server confirms. If the server rejects, parent clears
        // pendingPick and the latched useEffect snaps everything back.
        onPress();
      }}
      // No onPressOut / onPress — the press IS the commit. Spring-back
      // to neutral happens via the latched useEffect once the parent
      // signals one way or the other.
      accessibilityLabel={`choose ${word}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: effectiveDisabled }}
    >
      <Text
        style={s.optionText}
        numberOfLines={1}
        // Note: dropped adjustsFontSizeToFit + minimumFontScale here.
        // Vocab is curated to lexically-simple ≤10 chars (see
        // AGENTS.md §Word vocabulary), and at 22pt with ~48% chip
        // width on iPhone 17 Pro Max, no overflow risk. The dynamic-
        // resize pass triggers a Yoga relayout on every render — a
        // measurable perf cost on the most-rendered component in the
        // app, paid for nothing in practice. Removed 2026-05-10 #39.
      >
        {word}
      </Text>
    </AnimatedPressable>
  );
}

// ---------------------------------------------------------------------------
// TargetHero — the persistent goal. Always-Visible Action Rule (Yu-kai Chou).
// Pulses on round-advance; otherwise sits quietly with accent glow.
// ---------------------------------------------------------------------------

function TargetHero({
  word,
  isFinishWindow,
  isNewRound,
}: {
  word: string;
  isFinishWindow: boolean;
  isNewRound: boolean;
}) {
  const scale = useSharedValue(0.94);
  const opacity = useSharedValue(0);
  const pulse = useSharedValue(0);
  const prevWord = useRef<string>(word);

  useEffect(() => {
    // First mount: rise in.
    if (opacity.value === 0) {
      scale.value = withSpring(1, springAdvance);
      opacity.value = withTiming(1, { duration: DURATION.heroAdvance });
      prevWord.current = word;
      return;
    }
    if (prevWord.current !== word) {
      if (isNewRound) {
        // Round-advance reveal — stronger than in-round word change.
        // Container-transform-style: card collapses to ~0.82 and surges
        // back with a single overshoot beat (KB §reveal-moment design,
        // Disney anticipation + follow-through).
        opacity.value = withSequence(
          withTiming(0, { duration: 160, easing: Easing.in(Easing.cubic) }),
          withTiming(1, { duration: 380, easing: Easing.out(Easing.cubic) }),
        );
        scale.value = withSequence(
          withTiming(0.82, { duration: 160 }),
          withSpring(1.04, { damping: 11, stiffness: 180, mass: 0.9 }),
          withSpring(1, { damping: 14, stiffness: 220 }),
        );
      } else {
        // In-round target update (rare — only when target is corrected
        // mid-round, e.g. by an admin reset). Keep it understated.
        opacity.value = withSequence(
          withTiming(0, { duration: 120, easing: Easing.in(Easing.cubic) }),
          withTiming(1, { duration: 280, easing: Easing.out(Easing.cubic) }),
        );
        scale.value = withSequence(
          withTiming(0.94, { duration: 120 }),
          withSpring(1, springAdvance),
        );
      }
      prevWord.current = word;
    }
  }, [word, isNewRound]);

  useEffect(() => {
    // Slow luminance breathing during finish window.
    if (isFinishWindow) {
      pulse.value = withSequence(
        withTiming(1, { duration: 600, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 600, easing: Easing.inOut(Easing.sin) }),
      );
    } else {
      pulse.value = withTiming(0, { duration: 200 });
    }
  }, [isFinishWindow]);

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
    borderColor: interpolateColor(
      pulse.value,
      [0, 1],
      [colors.accent + '55', colors.accent],
    ),
    shadowOpacity: 0.6 + pulse.value * 0.3,
  }));

  return (
    <Animated.View style={[s.targetCard, cardStyle]}>
      <Text style={s.targetLabel}>target</Text>
      <Text
        style={s.targetWord}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.55}
        accessibilityLabel={`target word: ${word}`}
        accessibilityRole="header">
        {word}
      </Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// CurrentBreadcrumb — small chip that gives retroactive context for the options.
// Fades+rises on every word change (lighter than the previous hero treatment).
// ---------------------------------------------------------------------------

function CurrentBreadcrumb({ word }: { word: string }) {
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(4);
  const prevWord = useRef<string>(word);

  useEffect(() => {
    if (opacity.value === 0) {
      opacity.value = withTiming(1, { duration: 240 });
      translateY.value = withTiming(0, easeStandard);
      prevWord.current = word;
      return;
    }
    if (prevWord.current !== word) {
      opacity.value = withSequence(
        withTiming(0, { duration: 100, easing: Easing.in(Easing.cubic) }),
        withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) }),
      );
      translateY.value = withSequence(
        withTiming(-4, { duration: 100 }),
        withTiming(0, easeStandard),
      );
      prevWord.current = word;
    }
  }, [word]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View style={[s.breadcrumb, animStyle]}>
      <Text style={s.breadcrumbText} accessibilityLabel={`your word: ${word}`}>
        from <Text style={s.breadcrumbWord}>{word}</Text>
      </Text>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export default function GameScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const insets = useSafeAreaInsets();
  const { userId } = useAuth();
  const profile = useUserProfile(userId);
  const elo = profile?.ratingElo ?? 1000;

  const [roomMode, setRoomMode] = useState<string | null>(null);
  const [round, setRound] = useState<RoundState | null>(null);
  const [myPlayer, setMyPlayer] = useState<MyPlayerState | null>(null);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Optimistic UI for the marquee mechanic. When the player taps an
  // option, we set `pendingPick` immediately and update the breadcrumb
  // + chip visuals locally without waiting for the server. The server
  // round-trip is 300-800ms; absorbing that into a render that already
  // shows the picked word is the difference between "snappy" and
  // "laggy" on the most-pressed surface in the app. Cleared by a
  // useEffect when the server confirms (currentWord matches), by an
  // error path on submitMove failure, or by a round flip.
  // ux-design-expert pass 2026-05-10 #39.
  const [pendingPick, setPendingPick] = useState<string | null>(null);
  const [finishCountdown, setFinishCountdown] = useState<number | null>(null);
  // Server-time countdown for the 3-sec results barrier.
  const [resultsCountdown, setResultsCountdown] = useState<number | null>(null);
  // Brief "NEW ROUND" overlay after the round flips back to active.
  const [showNewRoundTag, setShowNewRoundTag] = useState(false);
  // Render-gate for the results popup. Decoupled from `round.phase` so the
  // popup can fade OUT after the server flips phase=active (otherwise the
  // popup snap-unmounts and the queued fade animation runs on a phantom
  // view). Falls back to false ~280ms after phase!=='results'. See
  // KB §results-popup-fade-out-must-survive-phase-change.
  const [popupVisible, setPopupVisible] = useState(false);
  const popupHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPhaseRef = useRef<RoundState['phase'] | null>(null);
  const prevRoundSeqRef = useRef<number | null>(null);
  const rosterRef = useRef<RosterEntry[]>([]);
  const myMovesAtFinalizeRef = useRef<number | null>(null);

  const resultsCardRef = useRef<View>(null);

  const finishBannerScale = useSharedValue(0.92);
  const finishBannerOpacity = useSharedValue(0);
  // Bottom-sheet popup geometry — translateY-based entrance/exit (sheet
  // grammar: rise from below) replaces the prior scale-from-center
  // (centered-modal grammar). KB §Sheet entrance grammar.
  const resultsTranslateY = useSharedValue(80);
  const resultsOpacity = useSharedValue(0);
  const backdropOpacity = useSharedValue(0);
  // 3-second countdown progress bar (1.0 → 0) at the top of the sheet.
  // Visualises the forced-wait window without the giant numeral having
  // to do all the work alone. UI-thread linear easing — see
  // KB §Top progress bar for forced-wait barriers.
  const countdownProgress = useSharedValue(1);
  const newRoundTagOpacity = useSharedValue(0);
  const newRoundTagY = useSharedValue(-6);

  const heatLevel = useSharedValue(0);
  const snapFlash = useSharedValue(0);

  useEffect(() => {
    const heat = distToHeat(myPlayer?.cosineDist);
    heatLevel.value = withTiming(heat, { duration: 600 });
  }, [myPlayer?.cosineDist]);

  useEffect(() => { rosterRef.current = roster; }, [roster]);

  useEffect(() => {
    return () => {
      if (popupHideTimerRef.current) {
        clearTimeout(popupHideTimerRef.current);
        popupHideTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!roomId) return;
    const id = setInterval(() => {
      callHeartbeat(roomId).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [roomId]);

  useEffect(() => {
    if (!roomId) return;
    // Track whether we've ever seen the room exist. Without this, a brief
    // first-frame "snap.exists is false" (eventual consistency on a
    // freshly-created room) would race-bounce us back home.
    let seenAlive = false;
    return roomDoc(roomId).onSnapshot(snap => {
      if (snap.exists) {
        seenAlive = true;
        setRoomMode((snap.data()?.mode as string) ?? null);
        return;
      }
      // Room was deleted out from under us — most likely the last other
      // player left a private room and the cascade fired (callables.ts
      // §leaveRoom), or the scheduled reaper deleted an abandoned room.
      // Bounce home; the back stack is already pointing there from the
      // entry navigation.
      if (seenAlive && router.canGoBack()) {
        router.back();
      } else if (seenAlive) {
        router.replace('/');
      }
    });
  }, [roomId]);

  // Explicit leave on unmount.
  //
  // Fires the `leaveRoom` callable when the user navigates away from the
  // game screen (back button, deep-link to home, etc.). Server removes the
  // player from `memberIds` + deletes their player doc. If we're the LAST
  // member of a PRIVATE room, the server cascade-deletes the entire room
  // (players, rounds, rewardLocks, and the room doc) — so private rooms
  // never outlive the players inside them. Global rooms are always
  // retained server-side; we just unregister the player.
  //
  // App backgrounding / force-quit doesn't fire React unmount, so this
  // path won't run for those cases — that's what the scheduled reaper is
  // for (scheduled.ts §pass 3, 5-min stale window).
  useEffect(() => {
    if (!roomId) return;
    return () => {
      callLeaveRoom(roomId).catch(err => {
        // Swallow — the reaper is the safety net. Logged at debug level
        // so we don't pollute Sentry with expected races (room already
        // gone because another client raced us to be the "last" leaver).
        console.warn('leaveRoom failed (safe to ignore):', err?.message);
      });
    };
  }, [roomId]);

  // Snapshot all server phase transitions and drive the local
  // animations/haptics off the phase axis (not roundSeq), so the popup,
  // finish banner, and target-change reveal land at the same wall-clock
  // moment on every client. Per KB §game_hud_hierarchy: the popup IS the
  // phase, not a derived overlay.
  useEffect(() => {
    if (!roomId) return;
    return roundDoc(roomId).onSnapshot(snap => {
      const d = snap.data() as Partial<RoundState> | undefined;
      if (!d?.targetWord) { setRound(null); return; }
      const resultsRaw = d.results as Partial<RoundResultsSnapshot> | undefined;
      const rs: RoundState = {
        targetWord: String(d.targetWord),
        phase: (d.phase as RoundState['phase']) ?? 'active',
        phaseEndsAt: d.phaseEndsAt as RoundState['phaseEndsAt'],
        roundSeq: Number(d.roundSeq ?? 1),
        primaryWinnerUid: (d.primaryWinnerUid as string | null) ?? null,
        windowFinishers: (d.windowFinishers as string[]) ?? [],
        winnerMoves: typeof d.winnerMoves === 'number' ? d.winnerMoves : undefined,
        winnerSnap: !!d.winnerSnap,
        results: resultsRaw && typeof resultsRaw === 'object'
          ? {
              targetWord: String(resultsRaw.targetWord ?? ''),
              primaryWinnerUid: (resultsRaw.primaryWinnerUid as string | null) ?? null,
              windowFinishers: (resultsRaw.windowFinishers as string[]) ?? [],
              winnerMoves: typeof resultsRaw.winnerMoves === 'number' ? resultsRaw.winnerMoves : null,
              winnerSnap: !!resultsRaw.winnerSnap,
              completedSeq: Number(resultsRaw.completedSeq ?? 0),
              deltas: (resultsRaw.deltas && typeof resultsRaw.deltas === 'object')
                ? (resultsRaw.deltas as Record<string, number>)
                : undefined,
              // CRITICAL: must propagate `roundsAfter` so the popup uses
              // the server-embedded post-round count instead of the
              // racy `profile.roundsPlayed + 1` fallback. Without this,
              // the user-doc listener often updates BEFORE the popup
              // renders, so `min(profile.roundsPlayed + 1, 5)` reads
              // the post-commit count and adds 1 again — popup shows
              // 2/5 after the very first solo round (should be 1/5).
              roundsAfter: (resultsRaw.roundsAfter && typeof resultsRaw.roundsAfter === 'object')
                ? (resultsRaw.roundsAfter as Record<string, number>)
                : undefined,
              // `ranked` flag drives the practice-vs-ranked branch in
              // the popup. Defaults to `true` upstream for back-compat
              // with results blobs from before the field existed.
              ranked: typeof resultsRaw.ranked === 'boolean' ? resultsRaw.ranked : undefined,
            }
          : undefined,
      };

      const prevPhase = prevPhaseRef.current;

      // active → finish_window: photo-finish race begins.
      if (rs.phase === 'finish_window' && prevPhase !== 'finish_window') {
        finishBannerScale.value = withSpring(1, springReveal);
        finishBannerOpacity.value = withTiming(1, { duration: DURATION.finishEnter });
        if (rs.primaryWinnerUid === userId) {
          haptics.targetReached();
        } else {
          haptics.finishWindowStart();
        }
        // Capture my move count NOW — it gets reset to 0 when the round
        // advances, but the results popup needs to display it.
        myMovesAtFinalizeRef.current = myPlayer?.movesThisRound ?? null;
      }

      // finish_window → results: open the unskippable popup. All clients
      // get this snapshot at ~the same wall-clock moment; the 3s server
      // countdown then ticks in lockstep.
      if (rs.phase === 'results' && prevPhase !== 'results') {
        // Pop in fast — the user just watched the photo-finish hit 0 and
        // is waiting for THIS surface to land. Resets shared values to
        // their start state in case a prior fade-out left them at 0.
        if (popupHideTimerRef.current) {
          clearTimeout(popupHideTimerRef.current);
          popupHideTimerRef.current = null;
        }
        resultsTranslateY.value = 80; // hidden below the screen
        resultsOpacity.value = 0;
        backdropOpacity.value = 0;
        countdownProgress.value = 1;
        setPopupVisible(true);
        // Sheet rises from below + scrim fades in. Backdrop is lighter
        // than a centered-modal scrim (0.55 vs the prior 0.78) so the
        // target card stays visible-but-recessed. KB §Light scrim,
        // not blackout.
        backdropOpacity.value = withTiming(1, { duration: 200 });
        resultsTranslateY.value = withSpring(0, springReveal);
        resultsOpacity.value = withTiming(1, { duration: DURATION.resultsCardIn });
        // 3-second forced-wait barrier visualised as a top-edge progress
        // bar. Linear easing because the barrier is real wall-clock time
        // — easing curves would lie about the time pressure.
        countdownProgress.value = withTiming(0, {
          duration: 3000,
          easing: Easing.linear,
        });
        finishBannerOpacity.value = withTiming(0, { duration: DURATION.finishExit });
        heatLevel.value = withTiming(0, { duration: 400 });

        const wasWinner = rs.results?.primaryWinnerUid === userId;
        if (wasWinner && rs.results?.winnerSnap) {
          snapFlash.value = withSequence(
            withTiming(0.18, { duration: 80 }),
            withTiming(0, { duration: 460 }),
          );
        }
      }

      // results → active: the new round officially starts. Tear down the
      // popup and play the strong target-change reveal. Single haptic
      // success at the visible apex (KB §single haptic apex).
      const prevSeq = prevRoundSeqRef.current;
      const advanced = prevSeq !== null && rs.roundSeq > prevSeq;
      if (rs.phase === 'active' && (prevPhase === 'results' || advanced)) {
        backdropOpacity.value = withTiming(0, { duration: DURATION.resultsCardOut });
        resultsOpacity.value = withTiming(0, { duration: DURATION.resultsCardOut });
        // Sheet retracts downward — exit grammar mirrors the entry.
        // Spread `easeOut` (a WithTimingConfig with duration + easing +
        // reduceMotion already baked in) and override the duration to
        // match the existing resultsCardOut budget. Passing `easeOut`
        // as the `easing` field directly would crash with a worklet
        // error — `easing` expects a bare worklet function, not a
        // config object. KB §Reanimated easing must be a worklet.
        resultsTranslateY.value = withTiming(60, {
          ...easeOut,
          duration: DURATION.resultsCardOut,
        });
        // Keep the popup MOUNTED until the fade-out animation finishes —
        // otherwise the conditional render tears it down on this same
        // frame and the queued fade plays on a phantom view (i.e. the
        // popup just disappears with a hard cut).
        if (popupHideTimerRef.current) clearTimeout(popupHideTimerRef.current);
        popupHideTimerRef.current = setTimeout(() => {
          setPopupVisible(false);
          popupHideTimerRef.current = null;
        }, DURATION.resultsCardOut + 40);
        // Play the "NEW ROUND" tag — short, confident, then out of the way.
        setShowNewRoundTag(true);
        newRoundTagOpacity.value = withSequence(
          withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) }),
          withTiming(1, { duration: 900 }),
          withTiming(0, { duration: 360, easing: Easing.in(Easing.cubic) }),
        );
        newRoundTagY.value = withSequence(
          withTiming(0, { duration: 240, easing: Easing.out(Easing.cubic) }),
          withTiming(0, { duration: 900 }),
          withTiming(-4, { duration: 360 }),
        );
        setTimeout(() => setShowNewRoundTag(false), 1500);
        haptics.targetReached();
        myMovesAtFinalizeRef.current = null;
      }

      prevPhaseRef.current = rs.phase;
      prevRoundSeqRef.current = rs.roundSeq;
      setRound(rs);
    });
  }, [roomId, userId]);

  useEffect(() => {
    if (!roomId || !userId) return;
    return myPlayerDoc(roomId, userId).onSnapshot(snap => {
      const d = snap.data() as Partial<MyPlayerState> | undefined;
      if (!d?.options || !d.currentWord) { setMyPlayer(null); return; }
      const opts = d.options as string[];
      if (opts.length !== 4) { setMyPlayer(null); return; }
      setMyPlayer({
        currentWord: String(d.currentWord),
        options: opts as [string, string, string, string],
        usedOptionWords: d.usedOptionWords as string[] | undefined,
        cosineDist: typeof d.cosineDist === 'number' ? d.cosineDist : undefined,
        movesThisRound: typeof d.movesThisRound === 'number' ? d.movesThisRound : undefined,
      });
    });
  }, [roomId, userId]);

  useEffect(() => {
    if (!roomId) return;
    return playersCollection(roomId).onSnapshot(async snap => {
      const profileCache = new Map<string, {displayName?: string; avatarEmoji?: string}>();
      const uids = snap.docs.map(d => d.id);
      try {
        const profileSnaps = await Promise.all(
          uids.map(uid => firestore().doc(`publicProfiles/${uid}`).get()),
        );
        profileSnaps.forEach((ps, i) => {
          if (ps.exists) {
            profileCache.set(uids[i], {
              displayName: ps.data()?.displayName as string | undefined,
              avatarEmoji: ps.data()?.avatarEmoji as string | undefined,
            });
          }
        });
      } catch {}
      setRoster(
        snap.docs.map(doc => {
          const d = doc.data();
          const cached = profileCache.get(doc.id);
          return {
            id: doc.id,
            currentWord: String(d?.currentWord ?? '—'),
            displayName: cached?.displayName,
            avatarEmoji: cached?.avatarEmoji,
            lastRoundDelta: d?.lastRoundDelta != null ? Number(d.lastRoundDelta) : undefined,
            lastRoundDeltaSeq: d?.lastRoundDeltaSeq != null ? Number(d.lastRoundDeltaSeq) : undefined,
          };
        }),
      );
    });
  }, [roomId]);

  // Server-time countdown for the photo-finish window.
  useEffect(() => {
    if (!round || round.phase !== 'finish_window' || !round.phaseEndsAt) {
      setFinishCountdown(null);
      return;
    }
    const ends = round.phaseEndsAt.toMillis();
    const tick = () => setFinishCountdown(Math.max(0, Math.ceil((ends - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [round]);

  // Server-time countdown for the 3-sec results barrier. Drives the
  // "next round in N" numeral on the popup.
  useEffect(() => {
    if (!round || round.phase !== 'results' || !round.phaseEndsAt) {
      setResultsCountdown(null);
      return;
    }
    const ends = round.phaseEndsAt.toMillis();
    const tick = () => setResultsCountdown(Math.max(0, Math.ceil((ends - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [round]);

  const maybeFinalize = useCallback(async () => {
    if (!roomId) return;
    try {
      await callFinalizeFinishWindow(roomId);
    } catch {}
  }, [roomId]);

  const maybeAdvance = useCallback(async () => {
    if (!roomId) return;
    try {
      await callAdvanceRound(roomId);
    } catch {}
  }, [roomId]);

  // After the photo-finish window expires, any client may ask the server
  // to transition to `results`. The server CAS guarantees only one wins.
  // We schedule a setTimeout to fire AT the deadline (not just check once
  // when the snapshot arrives), then keep polling every 800ms in case the
  // first call races or fails — on success the next round-doc snapshot
  // changes `round.phase` away from finish_window and this effect tears
  // down via cleanup. Without the timeout, all clients wait silently for
  // the once-a-minute ghost finalizer to intervene.
  useEffect(() => {
    if (!roomId || !round || round.phase !== 'finish_window' || !round.phaseEndsAt) return;
    const ends = round.phaseEndsAt.toMillis();
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const fire = () => { void maybeFinalize(); };
    const initialDelay = Math.max(0, ends - Date.now());
    const timeoutId = setTimeout(() => {
      fire();
      intervalId = setInterval(fire, 800);
    }, initialDelay);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [roomId, round, maybeFinalize]);

  // After the 3-sec results barrier expires, any client may ask the server
  // to advance to the next round. CAS guarantees a single advance. Same
  // timeout-then-poll shape as the finalize effect above.
  useEffect(() => {
    if (!roomId || !round || round.phase !== 'results' || !round.phaseEndsAt) return;
    const ends = round.phaseEndsAt.toMillis();
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const fire = () => { void maybeAdvance(); };
    const initialDelay = Math.max(0, ends - Date.now());
    const timeoutId = setTimeout(() => {
      fire();
      intervalId = setInterval(fire, 800);
    }, initialDelay);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId !== null) clearInterval(intervalId);
    };
  }, [roomId, round, maybeAdvance]);

  const choose = useCallback(async (word: string) => {
    if (!roomId || !userId) return;
    setError(null);
    // Hard block during the results barrier — the server would reject this
    // anyway, but failing fast on the client keeps the haptic/UI quiet.
    if (round?.phase === 'results') return;
    if (round?.phase === 'finish_window' && round.phaseEndsAt) {
      if (round.phaseEndsAt.toMillis() <= Date.now()) {
        await maybeFinalize();
        return;
      }
    }
    // Optimistic latch — render the breadcrumb + picked-chip state
    // immediately so the player sees their pick land within 1 frame
    // instead of after the 300-800ms server round-trip. Reverted in
    // the catch below if the server rejects (rare).
    setPendingPick(word);
    try {
      const t0 = Date.now();
      await callSubmitMove(roomId, word);
      logPerf('submitMove', t0);
      // Don't clear pendingPick here — the snapshot listener will
      // deliver the new currentWord shortly, and the reconciliation
      // useEffect below clears it then. Clearing here would briefly
      // un-latch the chip in the gap between resolve and snapshot,
      // creating a visible flicker.
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Pick failed';
      if (msg.includes('finalizeFinishWindow')) {
        // Server rolled into finish-window; not a real error, just a
        // race. Don't show the message but DO clear the optimistic
        // latch so the player isn't stuck staring at a "pending" chip
        // for a move that won't land.
        setPendingPick(null);
        await maybeFinalize();
      } else {
        // Real failure — revert the optimistic state and surface the
        // error. Error haptic is the heftier notification family
        // (vs. the press's Light impact), giving the player an
        // unmistakable "no, that didn't work" beat.
        setPendingPick(null);
        setError(msg);
        haptics.errorFeedback();
      }
    }
  }, [roomId, userId, round, maybeFinalize]);

  // Reconcile the optimistic pending-pick with the server-confirmed
  // currentWord. Two paths to clear:
  //   (a) currentWord matches pendingPick -> server accepted; the
  //       new options are about to arrive in the same snapshot, so
  //       the old chips will unmount and remount with fresh keys.
  //   (b) the round flipped (roundSeq changed) -> any in-flight
  //       optimistic state belongs to a stale round; drop it.
  useEffect(() => {
    if (pendingPick && myPlayer?.currentWord === pendingPick) {
      setPendingPick(null);
    }
  }, [pendingPick, myPlayer?.currentWord]);
  useEffect(() => {
    setPendingPick(null);
  }, [round?.roundSeq]);

  const others = useMemo(() => roster.filter(p => p.id !== userId), [roster, userId]);

  const isFinishWindow = round?.phase === 'finish_window';
  const isResults = round?.phase === 'results';
  const iWon = round?.primaryWinnerUid === userId;
  const iPhotoFinished = round?.windowFinishers?.includes(userId ?? '') ?? false;

  // Derive the popup view from the server-authoritative results blob.
  // Identical on every client; no per-client reconstruction.
  const liveRoundResult: RoundResultView | null = useMemo(() => {
    if (!round?.results) return null;
    const r = round.results;
    const wasWinner = r.primaryWinnerUid === userId;
    const wasPhoto = r.windowFinishers.includes(userId ?? '');
    const winnerRoster = rosterRef.current.find(p => p.id === r.primaryWinnerUid);
    const myRoster = rosterRef.current.find(p => p.id === userId);
    // Read from the server-embedded `deltas` map first — that's written
    // in the same CAS as phase=results, so it's correct on the popup's
    // very first frame.
    //
    // Fallback to roster.lastRoundDelta is GATED on the seq matching
    // this round. Without that gate, if `r.deltas[userId]` is missing
    // for any reason (user pruned from memberIds by ghost path, joined
    // mid-round, etc.) we'd briefly display the PREVIOUS round's delta
    // until commitRoundDeltas updates the player doc ~300ms later —
    // visible jitter. With the gate, we render `null` (→ `…` in the
    // UI) until a fresh delta arrives, then snap to the real value
    // exactly once. Never display a stale value.
    // `ranked` defaults to true for back-compat with results blobs from
    // before this field was introduced (those were all global rounds).
    const isRanked = r.ranked !== false;
    const serverDelta = userId && r.deltas ? r.deltas[userId] : undefined;
    const isRosterFresh =
      myRoster?.lastRoundDeltaSeq != null &&
      myRoster.lastRoundDeltaSeq === r.completedSeq;
    const rosterFallback = isRosterFresh ? myRoster?.lastRoundDelta : undefined;
    // For practice rounds, force eloDelta to null — the popup renders
    // "PRACTICE" instead of an Elo chip and never consults this field.
    const eloDelta: number | null = isRanked
      ? (serverDelta ?? rosterFallback ?? null)
      : null;
    // Post-this-round roundsPlayed for the local player. Sourced from
    // the server-embedded `roundsAfter` map so the popup's first frame
    // is correct (gating on profile.roundsPlayed flickers because the
    // user-doc listener lags the round-doc listener by ~200ms). Legacy
    // results blobs pre-dating the placement system don't carry the
    // map → null → popup falls through to the regular Elo display.
    const myRoundsAfter =
      userId && r.roundsAfter && r.roundsAfter[userId] != null
        ? r.roundsAfter[userId]
        : null;
    return {
      winnerUid: r.primaryWinnerUid,
      winnerName: winnerRoster?.displayName ?? null,
      winnerEmoji: winnerRoster?.avatarEmoji ?? null,
      photoFinishers: r.windowFinishers,
      targetWord: r.targetWord,
      myOutcome: wasWinner ? 'win' : wasPhoto ? 'photo' : 'loss',
      eloChange: eloDelta,
      winnerMoves: r.winnerMoves,
      winnerSnap: r.winnerSnap,
      myMoves: myMovesAtFinalizeRef.current,
      ranked: isRanked,
      myRoundsAfter,
    };
  }, [round?.results, userId, roster]);

  // Freeze the result during the fade-out window. The server clears
  // `round.results` when it flips phase to active, but we want the popup
  // to keep displaying its data while it animates away. Captures the live
  // value whenever it's non-null and holds it until popupVisible flips
  // back to false.
  const [frozenResult, setFrozenResult] = useState<RoundResultView | null>(null);
  useEffect(() => {
    if (liveRoundResult) setFrozenResult(liveRoundResult);
    else if (!popupVisible) setFrozenResult(null);
  }, [liveRoundResult, popupVisible]);
  const roundResult = liveRoundResult ?? frozenResult;

  const myEmoji = profile?.avatarEmoji ?? '🐺';

  const finishAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: finishBannerScale.value }],
    opacity: finishBannerOpacity.value,
  }));

  const resultsAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: resultsTranslateY.value }],
    opacity: resultsOpacity.value,
  }));

  const countdownBarStyle = useAnimatedStyle(() => ({
    width: `${Math.max(0, Math.min(1, countdownProgress.value)) * 100}%`,
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  // Temperature glow: ambient bg shift, subconscious feedback only.
  const tempGlowStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      heatLevel.value,
      [0, 0.3, 0.6, 1],
      ['transparent', 'rgba(0,229,255,0.02)', 'rgba(0,229,255,0.06)', 'rgba(0,229,255,0.12)'],
    ),
  }));

  const snapFlashStyle = useAnimatedStyle(() => ({
    opacity: snapFlash.value,
  }));

  const newRoundTagStyle = useAnimatedStyle(() => ({
    opacity: newRoundTagOpacity.value,
    transform: [{ translateY: newRoundTagY.value }],
  }));

  const winStreak = profile?.winStreak ?? 0;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Animated.View style={[StyleSheet.absoluteFill, tempGlowStyle]} pointerEvents="none" />
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.accent }, snapFlashStyle]}
        pointerEvents="none"
      />

      {/* Top status — ambient, micro-meta only.
          Private rooms ALSO surface the 4-char join code as a tappable
          chip in the centre — tap fires the native share sheet so the
          host can invite friends in one motion. Hidden in global rooms
          (the auto-generated 20-char roomId is not shareable). */}
      <View style={s.topBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}
          accessibilityLabel="go home" accessibilityRole="button">
          <Text style={s.backText}>← home</Text>
        </Pressable>
        {roomMode === 'private' && roomId ? (
          <Pressable
            onPress={() => {
              Share.share({
                message: `join my tir room — code ${roomId}`,
              }).catch(() => {});
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`share join code ${roomId.split('').join(' ')}`}
            style={s.codeChip}
          >
            <Text style={s.codeChipLabel}>CODE</Text>
            <Text style={s.codeChipValue}>{roomId}</Text>
            <Text style={s.codeChipShare}>↗</Text>
          </Pressable>
        ) : null}
        <Text style={s.topMeta}
          accessibilityLabel={`round ${round?.roundSeq ?? 0}, ${others.length + 1} players online, ${myPlayer?.movesThisRound ?? 0} moves`}>
          round {round?.roundSeq ?? '—'} · {others.length + 1} online
          {(myPlayer?.movesThisRound ?? 0) > 0 ? ` · ${myPlayer!.movesThisRound} moves` : ''}
        </Text>
      </View>

      {/* TARGET — the persistent goal, the new hero */}
      <View style={s.targetSection}>
        <TargetHero
          word={round?.targetWord ?? '—'}
          isFinishWindow={!!isFinishWindow}
          isNewRound={showNewRoundTag}
        />
      </View>

      {/* NEW ROUND callout — floats absolutely just below the topBar
          (in the empty space between topBar and the target card)
          rather than overlaying the target card itself. The target
          card is already running its own collapse-and-surge animation
          for the round flip; piling a pill on top of it during that
          animation read as cluttered AND occluded the very word the
          user needs to register. The wrapper centres the pill
          horizontally without taking it out of pointer-event flow on
          anything else (`pointerEvents='none'`). KB §Don't occlude
          primary content with celebratory pills. */}
      {showNewRoundTag && (
        <Animated.View
          style={[
            s.newRoundTagWrap,
            { top: insets.top + 50 },
            newRoundTagStyle,
          ]}
          pointerEvents="none"
        >
          <View style={s.newRoundTag}>
            <Text style={s.newRoundTagText}>NEW ROUND · {round?.roundSeq ?? 0}</Text>
          </View>
        </Animated.View>
      )}

      {/* Finish-window banner — replaces the breadcrumb when active */}
      {isFinishWindow ? (
        <Animated.View style={[s.finishBanner, finishAnimStyle]}>
          {/* Banner copy carries the server-time countdown for ALL
              participants, including the winner. Without the
              countdown the winner sat on a static "you won!" banner
              for 3 seconds before the popup arrived — which felt
              like the app had hung. The countdown explains "the
              wait is the photo-finish window, score arrives at 0."
              KB §System status visibility (Nielsen heuristic #1):
              users should always know what's happening, especially
              during a forced wait. */}
          <Text style={s.finishText}>
            {iWon
              ? `🏆 you won!${finishCountdown !== null ? `  ·  score in ${finishCountdown}` : ''}`
              : iPhotoFinished
                ? `📸 photo finish!${finishCountdown !== null ? `  ·  score in ${finishCountdown}` : ''}`
                : `finish window${finishCountdown !== null ? `  ·  ${finishCountdown}` : ''}`}
          </Text>
        </Animated.View>
      ) : (
        // Optimistic breadcrumb — render `pendingPick` if there's an
        // in-flight pick, otherwise the server-confirmed currentWord.
        // The two converge ~300-800ms after press when the snapshot
        // arrives; until then the user sees their picked word here
        // already, which is the main thing absorbing perceived
        // latency on the marquee mechanic.
        <CurrentBreadcrumb
          word={pendingPick ?? myPlayer?.currentWord ?? '…'}
        />
      )}

      {/* OPTIONS — the action zone, fills the bottom thumb arc.
          Hidden while the popup is on screen (mount AND fade-out) so the
          option grid doesn't flicker through the backdrop. */}
      <View style={s.optionArea}>
        {myPlayer && !popupVisible && (
          <View style={s.optionGrid}>
            {myPlayer.options.map((word, i) => (
              <OptionChip
                key={`${word}-${i}-${round?.roundSeq}`}
                word={word}
                onPress={() => choose(word)}
                // Lock the grid for players who've already reached
                // the target (winner OR photo finisher) during the
                // 3-second finish window. Their next move would be
                // wasted (the round is already over from their
                // perspective) and could trigger an off-by-one move
                // submission against a stale roundSeq. KB §Disable
                // controls whose action no longer applies (Nielsen
                // heuristic #5: error prevention).
                disabled={isFinishWindow && (iWon || iPhotoFinished)}
                // Optimistic latch — this chip was the pick and we're
                // waiting for the server to acknowledge.
                latched={pendingPick === word}
                // Sibling-pick dim — another chip is the pick; this
                // one fades to 0.4 and becomes non-interactive so
                // the player can't double-tap mid-flight.
                dimmed={pendingPick != null && pendingPick !== word}
              />
            ))}
          </View>
        )}
      </View>

      {/* RESULTS bottom-sheet — server-driven sync barrier (3 sec).
          Mounted via `popupVisible` (not isResults) so the fade-out
          actually plays after phase flips to active. Unskippable; the
          "next round in N" countdown is the implicit single CTA (Yu-kai
          Chou Always-Visible Action Rule, applied as forced wait per
          AdReact 2026 natural-break guidance).

          Layout: half-sheet anchored to the bottom of the screen
          (Apple HIG `.medium` detent / M3 modal bottom sheet). The
          target hero stays VISIBLE above the sheet — celebration in
          context, "you chased GRIFFIN → you won → +24 elo" reads as
          a complete narrative arc in one glance. KB §Half-sheet, not
          center modal, for transient celebration. */}
      {popupVisible && roundResult && (
        <>
          <Animated.View
            pointerEvents="auto"
            style={[StyleSheet.absoluteFillObject, s.resultsBackdrop, backdropStyle]}
            accessibilityLabel={`round results — next round in ${resultsCountdown ?? 3} seconds`}
          />
          <Animated.View style={[s.resultsSheet, resultsAnimStyle]} pointerEvents="auto">
            <View
              ref={resultsCardRef}
              style={[s.resultsCard, { paddingBottom: insets.bottom + space[4] }]}
              collapsable={false}
            >
              {/* Top countdown progress bar — clipped by the sheet's
                  rounded top corners (overflow: hidden on resultsCard).
                  Linear easing because the barrier is real wall-clock
                  time. KB §Top progress bar for forced-wait barriers. */}
              <View style={s.countdownBarTrack}>
                <Animated.View style={[s.countdownBarFill, countdownBarStyle]} />
              </View>

              {/* Drag handle — M3 §Bottom sheets anatomy: 40×4 pill,
                  centered, top padding. Decorative here (sheet is
                  forced-wait, not draggable) but signals "this is a
                  drawer pattern" so the surface type reads
                  immediately. KB §Drag handle as sheet affordance. */}
              <View style={s.dragHandle} />

              {roundResult.myOutcome === 'win' && (
                <Text style={s.resultsBigEmoji}>🏆</Text>
              )}
              {roundResult.myOutcome === 'photo' && (
                <Text style={s.resultsBigEmoji}>📸</Text>
              )}

              <Text style={s.resultsTitle}>
                {roundResult.myOutcome === 'win'
                  ? 'you won'
                  : roundResult.myOutcome === 'photo'
                    ? 'photo finish'
                    : 'round over'}
              </Text>

              {/* Focal numeral row — three mutually-exclusive branches:
                  (1) PRACTICE — private rooms, never move Elo. Render
                      a "PRACTICE" affordance instead of an Elo delta.
                  (2) PLACEMENT — first PLACEMENT_TOTAL_ROUNDS ranked
                      rounds for this account. Elo math runs underneath
                      (the player still climbs/falls based on actual
                      results), but the numeral is hidden and replaced
                      with "Calibrating N/5". Removes the day-1 loss
                      sting from new players without softening the Elo
                      math itself. Riot LP placement-match canon.
                  (3) RANKED — normal Elo display. Default branch.
                  Order matters: practice short-circuits before
                  placement (a placement-stage user playing in a
                  private room sees PRACTICE, not the placement
                  banner — that's the right priority because the
                  private room never moved their Elo anyway).

                  Placement detection (2026-05-10 #41): the original
                  gate only checked `myRoundsAfter` (server-embedded in
                  the results blob). When that field was missing —
                  legacy rounds, races where this client wasn't in
                  `memberIds` at finalize time, etc. — the gate
                  fell through to the Elo branch and the popup leaked
                  a +N / -N delta to a player who is still being shown
                  CALIBRATING N/5 on the home and the game stats bar.
                  Same player, two surface treatments. NN/g §Heuristic
                  4 violation. We now OR the server signal with the
                  client's own `profile.roundsPlayed` so the popup
                  honours placement whenever EITHER source agrees the
                  player is still calibrating, and prefers the
                  server-embedded count when present (it's the
                  post-this-round value; profile.roundsPlayed lags by
                  ~200ms behind the user-doc snapshot). */}
              {(() => {
                const profileCount = profile?.roundsPlayed ?? 0;
                const inPlacement =
                  isInPlacement(profileCount) ||
                  (roundResult.myRoundsAfter != null &&
                    roundResult.myRoundsAfter <= PLACEMENT_TOTAL_ROUNDS);
                const placementN =
                  roundResult.myRoundsAfter ??
                  Math.min(profileCount + 1, PLACEMENT_TOTAL_ROUNDS);
                if (!roundResult.ranked) {
                  return (
                    <>
                      <Text style={[s.resultsElo, s.eloNeutral]}>—</Text>
                      <Text style={s.resultsEloLabel}>practice · no elo</Text>
                    </>
                  );
                }
                if (inPlacement) {
                  return (
                    <>
                      <Text style={[s.resultsElo, s.eloNeutral]}>
                        {placementN}/{PLACEMENT_TOTAL_ROUNDS}
                      </Text>
                      <Text style={s.resultsEloLabel}>calibrating</Text>
                    </>
                  );
                }
                return (
                  <>
                    <Text style={[
                      s.resultsElo,
                      roundResult.eloChange == null
                        ? s.eloNeutral
                        : roundResult.eloChange > 0
                          ? s.eloUp
                          : roundResult.eloChange < 0
                            ? s.eloDown
                            : s.eloNeutral,
                    ]}>
                      {roundResult.eloChange == null
                        ? '…'
                        : roundResult.eloChange > 0
                          ? `+${roundResult.eloChange}`
                          : roundResult.eloChange < 0
                            ? `${roundResult.eloChange}`
                            : '0'}
                    </Text>
                    <Text style={s.resultsEloLabel}>elo</Text>
                  </>
                );
              })()}

              <Text style={s.resultsTarget}>
                target was <Text style={s.resultsTargetWord}>{roundResult.targetWord}</Text>
              </Text>

              {roundResult.myOutcome === 'win' && roundResult.myMoves != null && (
                <View style={s.resultsBadgeRow}>
                  <View style={s.resultsBadge}>
                    <Text style={s.resultsBadgeText}>
                      {roundResult.myMoves} {roundResult.myMoves === 1 ? 'move' : 'moves'}
                    </Text>
                  </View>
                  {roundResult.winnerSnap && (
                    // Photo-finish badge — 📸 not ⚡. Lightning ⚡ is
                    // reserved app-wide for win-streak (KB §Icon
                    // vocabulary 1:1 with concept). 📸 is the literal
                    // glyph for "photo finish" (a finish so close it
                    // requires a photo to call), and frees ⚡ for the
                    // single concept it represents on the home
                    // identity chips and the game stats bar.
                    <View style={[s.resultsBadge, s.snapBadge]}>
                      <Text style={[s.resultsBadgeText, s.snapBadgeText]}>📸 snap</Text>
                    </View>
                  )}
                </View>
              )}

              {roundResult.winnerUid && roundResult.myOutcome !== 'win' && (
                <View style={s.resultsWinnerRow}>
                  <Text style={s.resultsWinner}>
                    {roundResult.winnerEmoji ?? '🏆'} {roundResult.winnerName ?? 'unknown'}
                    {roundResult.winnerMoves != null
                      ? ` · ${roundResult.winnerMoves} ${roundResult.winnerMoves === 1 ? 'move' : 'moves'}`
                      : ''}
                  </Text>
                </View>
              )}

              {roundResult.photoFinishers.length > 0 && roundResult.myOutcome !== 'photo' && (
                <Text style={s.resultsPhoto}>
                  {roundResult.photoFinishers.length} photo finish{roundResult.photoFinishers.length > 1 ? 'es' : ''}
                </Text>
              )}

              {/* Sync-barrier countdown — server-time, identical on every
                  client. Tabular-nums so the digit doesn't jitter. The
                  top progress bar carries the gestalt time pressure;
                  this is the precise count for accessibility. */}
              <View style={s.resultsCountdownRow}>
                <Text style={s.resultsCountdownLabel}>next round in</Text>
                <Text style={s.resultsCountdownNum}>
                  {resultsCountdown != null ? Math.max(0, resultsCountdown) : 3}
                </Text>
              </View>

              {/* Share — inline ghost button at the foot of the sheet
                  (Apple HIG: secondary actions inside a sheet sit
                  bottom-aligned, ghost-styled so they don't compete
                  with the celebratory focal numeral). */}
              <Pressable
                style={({ pressed }) => [s.shareButton, pressed && { opacity: 0.6 }]}
                onPress={() => shareViewAsImage(resultsCardRef)}
                accessibilityLabel="share result"
                accessibilityRole="button"
                hitSlop={6}
              >
                <Text style={s.shareText}>share</Text>
              </Pressable>
            </View>
          </Animated.View>
        </>
      )}

      {error && <Text style={s.error}>{error}</Text>}

      {/* STATS — ambient bottom bar */}
      <View style={[s.statsBar, { paddingBottom: insets.bottom + space[2] }]}>
        <View style={s.statsLeft}>
          <Text style={s.avatarEmoji}>{myEmoji}</Text>
          {/* Hide Elo + tier during the placement period (ranked rounds 1-N).
              Show "Calibrating N/5" instead. Riot LP placement-match canon —
              new players don't see numerical Elo until it's meaningful, which
              also kills the day-1 sting of an early loss. The ambient stats
              bar is the persistent place where the player learns "I am being
              measured", so it has to mirror the popup's placement story. */}
          {isInPlacement(profile?.roundsPlayed) ? (
            <>
              <Text style={s.statText}>
                {Math.min(profile?.roundsPlayed ?? 0, PLACEMENT_TOTAL_ROUNDS)}/{PLACEMENT_TOTAL_ROUNDS}
              </Text>
              <Text style={s.statTextMuted}>calibrating</Text>
            </>
          ) : (
            <>
              <Text style={s.statText}>{Math.round(elo)}</Text>
              <Text style={s.statTextMuted}>
                {leagueTierFromElo(elo).icon} {leagueTierFromElo(elo).name}
              </Text>
            </>
          )}
        </View>

        {others.length > 0 && (
          <View style={s.statsCenter}>
            {others.slice(0, 5).map(p => (
              <Text key={p.id} style={s.rosterEmoji}>{p.avatarEmoji ?? '👤'}</Text>
            ))}
            {others.length > 5 && (
              <Text style={s.statTextMuted}>+{others.length - 5}</Text>
            )}
          </View>
        )}

        <View style={s.statsRight}>
          {winStreak > 0 && (
            // App-wide icon vocabulary (KB §Icon vocabulary 1:1 with
            // concept). Lightning ⚡ ALWAYS means win-streak, fire 🔥
            // ALWAYS means daily-streak — same on the home identity
            // chips and here. The "hot" treatment for win-streaks ≥5
            // is carried by the chip COLOR (red bg + red text via
            // `streakBadgeHot` / `streakTextHot`), not by swapping
            // the glyph. Was previously `🔥 6` on the game HUD even
            // though `🔥 6` on home means "6-day streak" — same
            // glyph, two concepts, semantic collision (2026-05-10).
            <View style={[s.streakBadge, winStreak >= 5 && s.streakBadgeHot]}>
              <Text style={[s.streakText, winStreak >= 5 && s.streakTextHot]}>
                ⚡ {winStreak}
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles — all sourced from theme/typography tokens. No raw hex.
// ---------------------------------------------------------------------------

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: layout.pagePaddingH,
  },

  // -- top status row --
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space[3],
    minHeight: 36,
  },
  backText: {
    color: colors.muted,
    ...typo.micro,
    fontWeight: '600',
  },
  topMeta: {
    color: colors.dim,
    ...typo.micro,
    fontVariant: ['tabular-nums'],
  },
  codeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  codeChipLabel: {
    ...typo.eyebrow,
    color: colors.dim,
    fontSize: 9,
    letterSpacing: 1.4,
  },
  codeChipValue: {
    ...typo.mono,
    color: colors.text,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  codeChipShare: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: '700',
  },

  // -- target hero card --
  targetSection: {
    alignItems: 'center',
    marginTop: space[4],
    marginBottom: space[3],
  },
  // Floating wrapper — full-width, transparent, just below the
  // topBar (`top` set inline via `insets.top + 50` so it adapts to
  // notch / Dynamic Island). Centres the pill without forcing it
  // off normal layout, and zIndex 5 keeps it above the target card
  // glow without overlapping the card's content.
  newRoundTagWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 5,
  },
  newRoundTag: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: space[3],
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 10,
  },
  newRoundTagText: {
    color: colors.accent,
    ...typo.micro,
    fontWeight: '900',
    letterSpacing: 2,
    fontVariant: ['tabular-nums'],
  },
  targetCard: {
    width: '100%',
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.accent + '55',
    borderRadius: radius.xl,
    paddingVertical: space[5],
    paddingHorizontal: space[5],
    alignItems: 'center',
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 24,
    elevation: 12,
  },
  targetLabel: {
    color: colors.accent,
    ...typo.meta,
    letterSpacing: 3,
    marginBottom: space[2],
  },
  targetWord: {
    color: colors.text,
    fontSize: 56,
    fontWeight: '800',
    letterSpacing: -1.5,
    textAlign: 'center',
    lineHeight: 60,
  },

  // -- finish window banner (replaces breadcrumb when active) --
  finishBanner: {
    marginVertical: space[3],
    backgroundColor: 'rgba(255,213,107,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,213,107,0.40)',
    borderRadius: radius.pill,
    paddingVertical: 10,
    paddingHorizontal: space[5],
    alignSelf: 'center',
  },
  finishText: {
    color: colors.warning,
    ...typo.body,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },

  // -- breadcrumb (current word) --
  breadcrumb: {
    alignSelf: 'center',
    marginVertical: space[3],
    paddingVertical: space[1],
    paddingHorizontal: space[3],
  },
  breadcrumbText: {
    color: colors.dim,
    ...typo.body,
    fontSize: 13,
    fontWeight: '500',
  },
  breadcrumbWord: {
    color: colors.muted,
    fontWeight: '700',
    fontSize: 14,
  },

  // -- option grid (the action zone) --
  optionArea: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: space[3],
  },
  optionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  optionChip: {
    width: '48%',
    flexGrow: 1,
    borderWidth: 1.5,
    borderRadius: radius.lg,
    paddingVertical: 26,
    paddingHorizontal: space[3],
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 84,
  },
  // Disabled state — applied during finish window for players who've
  // already reached the target. Visually deemphasised (50% opacity)
  // so the grid still anchors the bottom of the screen but reads as
  // "locked, awaiting score" rather than "tappable." Apple HIG
  // disabled-state spec (https://developer.apple.com/design/human-interface-guidelines/buttons).
  optionChipDisabled: {
    opacity: 0.5,
  },
  optionText: {
    color: colors.text,
    ...typo.option,
    fontSize: 22,
    textAlign: 'center',
  },

  // -- error inline --
  error: {
    color: colors.danger,
    ...typo.micro,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: space[2],
  },

  // -- stats bar --
  statsBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: space[3],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  statsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    flex: 1,
  },
  statsCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flex: 1,
    justifyContent: 'center',
  },
  statsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    flex: 1,
    justifyContent: 'flex-end',
  },
  // Stats-bar glyphs — `glyph(size)` pins fontFamily + clamps
  // lineHeight so these emojis render with the same metrics as the
  // home identity card and leaderboard rows. Without this, iOS
  // Apple Color Emoji baselines drift 2-3px between the two
  // surfaces and the home/game identity feels visually different.
  // KB §Emoji baseline alignment + §Cross-screen identity.
  avatarEmoji: { ...glyph(18) },
  rosterEmoji: { ...glyph(16) },
  statText: {
    color: colors.text,
    ...typo.micro,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  statTextMuted: {
    color: colors.dim,
    ...typo.micro,
  },
  streakBadge: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: space[2],
  },
  streakBadgeHot: {
    backgroundColor: 'rgba(255,107,107,0.12)',
  },
  streakText: {
    color: colors.accent,
    ...typo.micro,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  streakTextHot: {
    color: colors.danger,
  },

  // -- results bottom sheet --
  // Scrim alpha is intentionally lighter than a center-modal scrim
  // (0.55 vs the prior 0.78) so the target hero card peeks through
  // above the sheet. The target IS the round's narrative context;
  // hiding it during results obscures the very thing the popup is
  // celebrating. M3 §Bottom sheets scrim guidance + Apple HIG
  // `largestUndimmedDetentIdentifier`. KB §Light scrim, not blackout.
  resultsBackdrop: {
    backgroundColor: 'rgba(6,8,15,0.55)',
    zIndex: 9,
  },
  // Sheet wrapper — anchored to the bottom of the viewport, full
  // width (no horizontal page padding so the sheet's outer edges
  // touch the screen edges, the canonical M3 / HIG sheet shape).
  resultsSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 10,
  },
  // Sheet body — rounded TOP corners only (xl), no bottom radius
  // (the sheet's bottom edge is the screen edge). `overflow:
  // 'hidden'` clips the countdown bar to the rounded corners.
  // Soft accent shadow at the top edge implies "rising from below."
  // Bottom safe-area inset is applied inline (insets.bottom +
  // space[4]) so the share button sits above the home indicator.
  resultsCard: {
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: 0, // countdown bar + drag handle handle their own spacing
    paddingHorizontal: space[5],
    alignItems: 'center',
    width: '100%',
    overflow: 'hidden',
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.35,
    shadowRadius: 24,
    elevation: 20,
  },
  // Top-edge countdown bar — track + animated fill. Track is a
  // very faint accent tint so the bar's "shrink" feels like it's
  // emptying, not jumping. Fill carries a subtle accent glow so
  // the leading edge reads as live, not static. KB §Top progress
  // bar for forced-wait barriers.
  countdownBarTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(0,229,255,0.10)',
  },
  countdownBarFill: {
    position: 'absolute',
    top: 0,
    left: 0,
    height: 3,
    backgroundColor: colors.accent,
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 4,
  },
  // Drag handle — M3 §Bottom sheets anatomy. 40×4 pill, centered.
  // Decorative (sheet is forced-wait) but the visual signals "this
  // is a drawer pattern" so users immediately recognise the
  // surface type even on first appearance.
  dragHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.muted,
    opacity: 0.35,
    alignSelf: 'center',
    marginTop: space[3],
    marginBottom: space[3],
  },
  resultsBigEmoji: {
    // Celebration glyph at the top of the bottom sheet. 56pt is
    // the canonical sheet-hero glyph size in the app; `glyph()`
    // ensures the emoji baseline sits flush above the title
    // (without it the line-box inflation pushes the title 6-8px
    // further from the glyph than the design specifies).
    ...glyph(56),
    marginBottom: space[2],
  },
  resultsTitle: {
    color: colors.text,
    ...typo.display,
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  resultsElo: {
    fontSize: 64,
    fontWeight: '900',
    letterSpacing: -2,
    marginTop: space[3],
    fontVariant: ['tabular-nums'],
  },
  resultsEloLabel: {
    color: colors.dim,
    ...typo.meta,
    letterSpacing: 4,
    marginTop: -4,
  },
  eloUp: { color: colors.accent },
  eloDown: { color: colors.danger },
  eloNeutral: { color: colors.muted },
  resultsTarget: {
    color: colors.muted,
    ...typo.body,
    marginTop: space[4],
    textAlign: 'center',
  },
  resultsTargetWord: {
    color: colors.text,
    fontWeight: '700',
  },
  resultsBadgeRow: {
    flexDirection: 'row',
    gap: space[2],
    marginTop: space[3],
  },
  resultsBadge: {
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: 'rgba(0,229,255,0.30)',
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: space[3],
  },
  resultsBadgeText: {
    color: colors.accent,
    ...typo.micro,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  snapBadge: {
    backgroundColor: 'rgba(255,213,75,0.12)',
    borderColor: 'rgba(255,213,75,0.35)',
  },
  snapBadgeText: { color: colors.gold },
  resultsWinnerRow: {
    alignItems: 'center',
    marginTop: space[3],
  },
  resultsWinner: {
    color: colors.gold,
    ...typo.body,
    fontWeight: '700',
  },
  resultsPhoto: {
    color: colors.success,
    ...typo.micro,
    fontWeight: '600',
    marginTop: space[2],
  },
  resultsCountdownRow: {
    marginTop: space[5],
    alignItems: 'center',
    paddingTop: space[4],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    width: '100%',
  },
  resultsCountdownLabel: {
    color: colors.dim,
    ...typo.micro,
    letterSpacing: 3,
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  resultsCountdownNum: {
    color: colors.accent,
    fontSize: 38,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  // Share — ghost button at the foot of the sheet. Apple HIG:
  // secondary actions inside a sheet sit bottom-aligned and
  // ghost-styled so they don't compete with the celebratory focal
  // numeral above. (Was a chunky accent CTA at the prior centered-
  // modal layout; that was justified there because the share was
  // the only action; here the dominant action is the implicit
  // "wait for the next round" countdown above, share is incidental.)
  shareButton: {
    marginTop: space[3],
    paddingVertical: space[2],
    paddingHorizontal: space[4],
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shareText: {
    color: colors.muted,
    ...typo.micro,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
});
