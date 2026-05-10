import { Easing, ReduceMotion, WithSpringConfig, WithTimingConfig } from 'react-native-reanimated';

// DESIGN.md §7 — spring tokens (M3-aligned)
// Every animation imports from here. Inline spring configs are banned.

export const springTap: WithSpringConfig = {
  dampingRatio: 0.9,
  stiffness: 1400,
  reduceMotion: ReduceMotion.Never,
};

export const springTapEffect: WithSpringConfig = {
  dampingRatio: 1.0,
  stiffness: 3800,
  reduceMotion: ReduceMotion.Never,
};

export const springAdvance: WithSpringConfig = {
  dampingRatio: 0.65,
  stiffness: 700,
  reduceMotion: ReduceMotion.Never,
};

export const springScreen: WithSpringConfig = {
  dampingRatio: 0.9,
  stiffness: 300,
  reduceMotion: ReduceMotion.Never,
};

export const springReveal: WithSpringConfig = {
  dampingRatio: 0.55,
  stiffness: 600,
  reduceMotion: ReduceMotion.Never,
};

// DESIGN.md §7 — easing tokens (M3-aligned)

export const easeStandard: WithTimingConfig = {
  duration: 280,
  easing: Easing.bezier(0.2, 0, 0, 1),
  reduceMotion: ReduceMotion.Never,
};

export const easeOut: WithTimingConfig = {
  duration: 200,
  easing: Easing.bezier(0, 0, 0.2, 1),
  reduceMotion: ReduceMotion.Never,
};

export const easeInOut: WithTimingConfig = {
  duration: 320,
  easing: Easing.bezier(0.4, 0, 0.2, 1),
  reduceMotion: ReduceMotion.Never,
};

// Duration budgets (ms) — DESIGN.md §7
export const DURATION = {
  chipPress: 140,
  heroAdvance: 320,
  finishEnter: 240,
  finishExit: 180,
  screenPush: 300,
  // Results popup enter/exit. Kept short so the popup feels reactive to the
  // photo-finish countdown hitting 0 and to the round-flip on exit. Anything
  // longer (we tried 600ms) reads as the screen lagging.
  resultsCardIn: 280,
  resultsCardOut: 220,
} as const;

// Entrance stagger budget (ms). Used with Reanimated's `entering` API on
// home-screen sections so the page composes itself on first paint instead
// of appearing all-at-once. One-shot only — no looping. See ux-design-expert
// KB §"Restraint over decoration on non-immersive home screens".
export const ENTRANCE = {
  duration: 380,
  step: 60,
} as const;
