import { useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  LinearTransition,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import firestore from '@react-native-firebase/firestore';
import { useAuth } from '../lib/auth';
import { colors, radius, shadows, space, layout } from '../lib/theme';
import { glyph, type as typo } from '../lib/typography';
import { ENTRANCE } from '../lib/motion';
import { PressableScale } from '../components/MenuKinetics';

// ---------------------------------------------------------------------------
// /name — first-launch identity capture.
//
// Voice (ux-design-expert pass 2026-05-10 #32 — verbosity audit):
//   - Imperative title with a period (`pick a name.`), parallel to the
//     /welcome card titles (`reach the target.` / `pick a synonym.` /
//     `race together.`).
//   - No subtitle, no section labels, no CTA caption. The preview card
//     IS the answer to "what does it look like"; the dice glyph IS the
//     shuffle affordance; the eyebrow `1 / 2` IS the progress indicator.
//   - NN/g 3 C's of microcopy: Clarity > Concision > Character. Mobile
//     must be "even more concise" than desktop — secondary info gets
//     cut harder. Source:
//     https://www.nngroup.com/articles/3-cs-microcopy/
//     https://www.nngroup.com/articles/mobile-sharpens-usability-guidelines/
//
// Mechanics:
//   - Smart defaults > empty fields. Input pre-filled with a generated
//     handle; dice button reseeds. A player can ship in one tap.
//   - Live identity preview mirrors the home identityCard so the player
//     recognises their card the moment they land on home.
//     (KB §Cross-screen identity treatment.)
//   - Avatar grid is 30 emojis = 5×6 = 6×5. Cell width is computed from
//     viewport width so the grid renders as exactly 6 columns × 5 rows
//     on every device — no flex-wrap drift, no orphan rows. World-class
//     designers don't let the grid happen to them.
//   - Motion: entrance stagger on first paint + LinearTransition on the
//     preview + PressableScale on every tappable. No idle loops.
//     (KB §Restraint over decoration.)
// ---------------------------------------------------------------------------

// 30 = 5×6 = 6×5. Mix of zoo, nature, abstract, and objects so every
// player can find a glyph that feels like them in <3 seconds.
const EMOJI_AVATARS = [
  '🐺', '🦊', '🐯', '🦁', '🐼', '🐸',
  '🦅', '🐙', '🦈', '🐝', '🦋', '🐲',
  '🐢', '🦉', '🦄', '🐧', '🌟', '⚡',
  '🔥', '💎', '🌊', '🍀', '🌙', '🍄',
  '🎯', '🚀', '🎭', '🎪', '🏆', '🎲',
];

// Avatar-grid layout constants. Kept here (not in styles) because the
// cell size is computed at runtime from `useWindowDimensions()`.
const GRID_COLS = 6;
const GRID_GAP = 8; // matches space[2]

// Two-syllable, English-readable handles. Adjective + noun + 2-digit
// suffix to (a) give every player a name with personality even if they
// never type, and (b) avoid collisions on the public leaderboard. The
// 14-char ceiling sits inside the 16-char Firestore field cap with
// room for the suffix.
const HANDLE_ADJ = [
  'swift', 'silent', 'lucid', 'wild', 'crisp', 'bright',
  'quick', 'bold', 'noble', 'keen', 'lone', 'sharp',
  'royal', 'sly', 'brave', 'feral', 'spry', 'cosmic',
];
const HANDLE_NOUN = [
  'wolf', 'fox', 'tiger', 'hawk', 'otter', 'raven',
  'lynx', 'shark', 'cobra', 'panther', 'eagle', 'falcon',
  'bear', 'whale', 'orca', 'puma', 'finch', 'crane',
];

function suggestHandle(): string {
  const a = HANDLE_ADJ[Math.floor(Math.random() * HANDLE_ADJ.length)];
  const n = HANDLE_NOUN[Math.floor(Math.random() * HANDLE_NOUN.length)];
  // Two-digit suffix keeps total length predictable (≤ 14) and gives
  // a per-player tag without leaking timestamps.
  const tag = String(10 + Math.floor(Math.random() * 90));
  return `${a}-${n}${tag}`;
}

const enter = (i: number) =>
  FadeInDown.duration(ENTRANCE.duration).delay(i * ENTRANCE.step);

export default function NamePickerScreen() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { userId, ready } = useAuth();

  // Compute the avatar cell size so the grid is always exactly
  // GRID_COLS wide. Subtract the page padding on both sides + the
  // GRID_COLS-1 gaps, divide by GRID_COLS. `Math.floor` so we never
  // overflow the row by a sub-pixel and force flex-wrap to drop a
  // cell to a new line. Capped at 56pt to keep cells touch-friendly
  // on Pro Max-class devices without ballooning.
  const cellSize = Math.min(
    56,
    Math.floor(
      (width - 2 * layout.pagePaddingH - (GRID_COLS - 1) * GRID_GAP) /
        GRID_COLS,
    ),
  );

  // Initial suggestion is computed once at mount (useRef, not useState
  // initializer wrapping a function — same effect, but explicit) so
  // that re-renders during typing don't re-roll the suggestion behind
  // the user's back. A re-roll is a deliberate user action.
  const initialSuggestion = useRef(suggestHandle());
  const initialAvatar = useRef(
    EMOJI_AVATARS[Math.floor(Math.random() * EMOJI_AVATARS.length)],
  );

  const [name, setName] = useState(initialSuggestion.current);
  const [selectedEmoji, setSelectedEmoji] = useState(initialAvatar.current);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSubmit = ready && trimmed.length >= 2 && trimmed.length <= 16;

  const shuffleName = () => {
    setName(suggestHandle());
  };

  const save = async () => {
    if (!userId || !canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await firestore().doc(`users/${userId}`).set(
        {
          displayName: trimmed,
          avatarEmoji: selectedEmoji,
          updatedAt: firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      // NavigationGate will pick up the displayName change and route
      // to /welcome on its next effect tick. We do not push here —
      // single source of truth for routing.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to save');
      setSaving(false);
    }
  };

  // Memoized so React doesn't re-render the EmojiCell list every keystroke.
  const emojiCells = useMemo(
    () =>
      EMOJI_AVATARS.map(emoji => (
        <EmojiCell
          key={emoji}
          emoji={emoji}
          size={cellSize}
          selected={emoji === selectedEmoji}
          onPress={() => setSelectedEmoji(emoji)}
        />
      )),
    [selectedEmoji, cellSize],
  );

  return (
    <KeyboardAvoidingView
      style={s.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          s.scrollContent,
          {
            paddingTop: insets.top + space[5],
            paddingBottom: insets.bottom + space[5],
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Eyebrow — single tick, single grammar. The slash IS the
            "step" word; spelling it out is chrome. Matches /welcome's
            `TIR · 2 / 2` exactly so the two screens read as one
            continuous flow. */}
        <Animated.View entering={enter(0)}>
          <Text style={s.brandTick}>TIR · 1 / 2</Text>
        </Animated.View>

        {/* Hero. Imperative, lowercase, period — same grammar as the
            three /welcome card titles. No subtitle: the preview card
            below answers "what does it look like" by SHOWING. */}
        <Animated.View entering={enter(1)}>
          <Text style={s.title} accessibilityRole="header">
            pick a name.
          </Text>
        </Animated.View>

        {/* Live identity preview — mirrors the home identityCard so the
            player recognises their card the moment they land on home.
            LinearTransition lets the chip-row reflow gently when the
            name length changes. */}
        <Animated.View
          entering={enter(2)}
          layout={LinearTransition.duration(220)}
          style={s.previewCard}
        >
          <View style={s.previewAvatarSlot}>
            <Animated.Text
              key={selectedEmoji}
              entering={FadeIn.duration(180)}
              style={s.previewAvatar}
              allowFontScaling={false}
            >
              {selectedEmoji}
            </Animated.Text>
          </View>
          <View style={s.previewCenter}>
            <Text style={s.previewName} numberOfLines={1}>
              {trimmed || 'your name'}
            </Text>
            <View style={s.previewMetaRow}>
              <Text style={s.previewMetaLabel}>NEW PLAYER</Text>
              <View style={s.previewDot} />
              <Text style={s.previewMetaValue}>1000 ELO</Text>
            </View>
          </View>
        </Animated.View>

        {/* Name input — pre-filled with a suggestion so a player can
            ship in 1 tap. Shuffle button reseeds the suggestion. */}
        <Animated.View entering={enter(3)} style={s.inputBlock}>
          <View style={s.inputRow}>
            <TextInput
              style={s.input}
              value={name}
              onChangeText={setName}
              placeholder="your handle"
              placeholderTextColor={colors.dim}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={16}
              selectTextOnFocus
              returnKeyType="done"
              accessibilityLabel="enter your display name"
            />
            <PressableScale
              onPress={shuffleName}
              accessibilityRole="button"
              accessibilityLabel="suggest another handle"
              hitSlop={8}
              style={s.shuffleBtn}
            >
              <Text style={s.shuffleIcon} allowFontScaling={false}>🎲</Text>
            </PressableScale>
          </View>
          {/* Char counter only — no hint text. The dice glyph is its
              own affordance; the counter handles length validation
              visually (turns danger-colored on overflow, which can't
              happen with maxLength but the visual rhythm is honest). */}
          <Text style={s.charCount}>{trimmed.length}/16</Text>
        </Animated.View>

        {/* Avatar grid — 30 cells, deterministic 6-column layout via
            computed cellSize so every device gets the same 6×5 grid.
            No section label: the grid is self-evident, and the preview
            avatar above is visually linked by the accent halo. KB
            §Restraint over decoration ("structure should be felt, not
            seen"). */}
        <Animated.View entering={enter(4)} style={s.gridBlock}>
          <View style={s.emojiGrid}>{emojiCells}</View>
        </Animated.View>

        {error && (
          <Animated.Text entering={FadeIn.duration(160)} style={s.error}>
            {error}
          </Animated.Text>
        )}

        <View style={{ height: space[5] }} />

        {/* Primary CTA — single verb. Same accent vocabulary as home
            PLAY. No caption: the eyebrow `1 / 2` already announces
            the next step, the dot indicator on /welcome will
            re-announce position. KB §Microcopy: "drop chrome that
            doesn't help the user act". */}
        <Animated.View entering={enter(5)}>
          <PressableScale
            disabled={!canSubmit || saving}
            onPress={save}
            accessibilityRole="button"
            accessibilityLabel={saving ? 'saving' : 'start tutorial'}
            accessibilityState={{ disabled: !canSubmit || saving }}
            style={[s.cta, (!canSubmit || saving) && s.ctaDisabled]}
          >
            <View style={s.ctaInner}>
              <Text style={s.ctaText}>{saving ? 'saving…' : 'start'}</Text>
              {!saving && <Text style={s.ctaArrow}>→</Text>}
            </View>
          </PressableScale>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ---------------------------------------------------------------------------
// EmojiCell — extracted so PressableScale doesn't recompute its
// shared values every parent re-render (TextInput onChange fires every
// keystroke). Stable identity per emoji = stable scale anim.
// ---------------------------------------------------------------------------

function EmojiCell({
  emoji,
  size,
  selected,
  onPress,
}: {
  emoji: string;
  size: number;
  selected: boolean;
  onPress: () => void;
}) {
  // Glyph fontSize tracks ~50% of cell size — keeps optical density
  // consistent regardless of which device computed the cell width.
  // Min 22pt so the glyph stays readable on the narrowest phones.
  const glyphSize = Math.max(22, Math.round(size * 0.5));
  return (
    <PressableScale
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`avatar ${emoji}${selected ? ', selected' : ''}`}
      style={[
        s.emojiCell,
        { width: size, height: size },
        selected && s.emojiSelected,
      ]}
      pressedScale={0.93}
    >
      <Text
        style={glyph(glyphSize)}
        allowFontScaling={false}
        accessibilityElementsHidden
      >
        {emoji}
      </Text>
    </PressableScale>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  scrollContent: {
    paddingHorizontal: layout.pagePaddingH,
    flexGrow: 1,
  },

  // ---- Eyebrow ----------------------------------------------------------
  brandTick: {
    ...typo.eyebrow,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 2.4,
    marginBottom: space[4],
  },

  // ---- Hero ---------------------------------------------------------------
  title: {
    color: colors.text,
    ...typo.display,
    // Single-line hero now (`pick a name.`) — let lineHeight be
    // governed by the typo.display token defaults rather than the
    // tighter clamp the two-line version needed.
  },

  // ---- Live identity preview (mirrors home identityCard) -----------------
  previewCard: {
    marginTop: space[5],
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[4],
    paddingHorizontal: space[4],
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    // Soft accent tint on the bottom edge — a quiet "this is YOU"
    // signal without an idle loop. Static, not animated.
    ...shadows.card,
  },
  previewAvatarSlot: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    // Faint accent halo so the preview avatar reads as the brightest
    // glyph on the screen — orients the eye to the live preview.
    shadowColor: colors.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 10,
  },
  previewAvatar: {
    ...glyph(24),
  },
  previewCenter: {
    flex: 1,
    minWidth: 0,
  },
  previewName: {
    color: colors.text,
    ...typo.title,
    fontSize: 17,
    lineHeight: 20,
  },
  previewMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: space[1],
  },
  previewMetaLabel: {
    ...typo.eyebrow,
    color: colors.dim,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  previewDot: {
    width: 3,
    height: 3,
    borderRadius: 2,
    backgroundColor: colors.dim,
  },
  previewMetaValue: {
    ...typo.mono,
    color: colors.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
  },

  // ---- Name input --------------------------------------------------------
  inputBlock: {
    marginTop: space[5],
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: space[4],
  },
  input: {
    flex: 1,
    paddingVertical: space[4],
    color: colors.text,
    ...typo.title,
  },
  shuffleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  shuffleIcon: {
    ...glyph(18),
  },
  charCount: {
    color: colors.dim,
    ...typo.micro,
    textAlign: 'right',
    marginTop: space[1],
    paddingHorizontal: space[1],
  },

  // ---- Avatar grid -------------------------------------------------------
  // Deterministic 6-column layout: cell width is computed at runtime
  // from useWindowDimensions() and applied per-cell. The grid wrapper
  // just needs flex-wrap + gap to lay them out — no flex-basis hacks.
  gridBlock: {
    marginTop: space[6],
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: GRID_GAP,
  },
  emojiCell: {
    // width + height set inline per-cell from computed cellSize
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emojiSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },

  // ---- Error -------------------------------------------------------------
  error: {
    marginTop: space[3],
    color: colors.danger,
    ...typo.micro,
    fontWeight: '600',
  },

  // ---- CTA ---------------------------------------------------------------
  cta: {
    backgroundColor: colors.accent,
    paddingVertical: space[4],
    borderRadius: radius.md,
    alignItems: 'center',
    minHeight: layout.minTapTarget + 8,
    justifyContent: 'center',
  },
  ctaDisabled: {
    opacity: 0.4,
  },
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
