import { Platform } from 'react-native';

// ---------------------------------------------------------------------------
// Color tokens — DESIGN.md §2
// Dark canvas, electric accent, restrained chrome.
// Single source of truth: no raw hex in feature code.
//
// 2026-05-10 hybrid family shift: canvas warmed halfway from the original
// cool tir palette toward the aaam.dev / humm warm-near-black family so
// tir reads as a sibling of humm across the room, while keeping its own
// electric cyan accent up close. Each canvas token below is the channel-
// wise midpoint of original tir ↔ aaam.dev:
//   bg     #06080F ↔ #0F0E14  →  #0B0B12
//   surface #0E1320 ↔ #17151E →  #13141F
//   card    #141A2B ↔ #1E1C27 →  #191B29
//   border  #222A3F ↔ #2E2938 →  #28293B
//   text    #F5F7FA ↔ #FAF7F4 →  #F7F7F7
//   muted   #8C95A8 ↔ #ADA7B3 →  #9D9EAE
//   dim     #5A6378 ↔ #767089 →  #686A80
// Cyan accent is unchanged — it remains tir's signature.
// ---------------------------------------------------------------------------

export const colors = {
  bg: '#0B0B12',
  surface: '#13141F',
  card: '#191B29',
  border: '#28293B',

  text: '#F7F7F7',
  muted: '#9D9EAE',
  dim: '#686A80',

  accent: '#00E5FF',
  accentSoft: 'rgba(0,229,255,0.10)',

  success: '#7CFFB2',
  warning: '#FFD56B',
  danger: '#FF6B6B',
  gold: '#FFD24A',

  transparent: 'transparent',
} as const;

export type ColorToken = keyof typeof colors;

// ---------------------------------------------------------------------------
// Spacing — DESIGN.md §4 (8 pt grid)
// ---------------------------------------------------------------------------

export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
} as const;

export type SpaceToken = keyof typeof space;

// ---------------------------------------------------------------------------
// Border radius — DESIGN.md §4
// ---------------------------------------------------------------------------

export const radius = {
  sm: 8,
  md: 14,
  lg: 22,
  xl: 28,
  pill: 999,
} as const;

export type RadiusToken = keyof typeof radius;

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

export const layout = {
  pagePaddingH: space[5],
  minTapTarget: Platform.OS === 'ios' ? 44 : 48,
  tapTargetGap: space[2],
} as const;

// ---------------------------------------------------------------------------
// Shadows — card and elevated surfaces
// ---------------------------------------------------------------------------

export const shadows = {
  card: {
    shadowColor: 'rgba(0,0,0,0.4)',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 32,
    elevation: 8,
  },
} as const;
