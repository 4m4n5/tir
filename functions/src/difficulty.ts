/**
 * Difficulty configuration for tir's word engine.
 *
 * Each difficulty level tunes 5 independent levers that control how much
 * "help" the option-generation algorithm gives the player:
 *
 *   1. Breadcrumbs — target's neighbors injected into the option pool
 *   2. Bridge word — dedicated option slot pointing toward the target
 *   3. Target injection — probability of showing the target word itself
 *   4. Medium slot — how "close" the second-best option is
 *   5. Diversifier depth — how random the fourth option is
 *
 * Validated via Monte Carlo simulation (decent-player model, 70% optimal
 * pick rate) across 30+ start→target pairs per config. See README for
 * simulation methodology and results.
 */

export type Difficulty = 'chill' | 'normal' | 'hard' | 'expert';

export interface DifficultyConfig {
  /** Number of target-neighbor words injected as breadcrumbs (0 = none) */
  breadcrumbCount: number;
  /** Max fake cosine score assigned to injected breadcrumbs */
  breadcrumbScoreMax: number;
  /** Whether a dedicated bridge-word slot is reserved */
  pathWordEnabled: boolean;
  /** How deep into the target's neighbors to scan for bridge overlap */
  pathScanDepth: number;
  /** Whether to fall back to any target neighbor if no bridge found */
  pathFallbackEnabled: boolean;
  /** Depth of fallback scan */
  pathFallbackDepth: number;
  /** Index in the sorted pool for the "medium" (2nd) option */
  mediumSlotIdx: number;
  /** How deep into the remaining pool the diversifier is picked from */
  diversifierDepth: number;
  /** Target injection probability by rank bracket */
  targetInject: {rank5: number; rank10: number; rank20: number; rank35: number; rank50: number};
}

// Simulation results (decent-player model, 3000 games each).
// Player intuition modeled as BFS hop-count from target through top-15
// neighbors per hop, depth ≤ 4. Picks lowest-hop option with prob 0.7,
// uniform-random otherwise. Ties broken uniformly. Run via:
//   node scripts/sim_difficulty.mjs --games 3000
//
//   CHILL:  avg=3.8  med=3   p10=2  p90=6   reach=100%
//   NORMAL: avg=11.9 med=8   p10=3  p90=26  reach=95%
//   HARD:   avg=30.7 med=26  p10=7  p90=64  reach=67%
//   EXPERT: avg=32.4 med=27  p10=7  p90=66  reach=63%
//
// Note: the BFS-based player is significantly weaker on HARD/EXPERT than
// a real human, who can chain semantic associations beyond 4 hops. Treat
// HARD/EXPERT averages as upper bounds; expect real-player avgs ~30–50%
// lower (HARD ≈ 16–22 moves, EXPERT ≈ 22–28 moves).

export const DIFFICULTY_CONFIGS: Record<Difficulty, DifficultyConfig> = {
  chill: {
    breadcrumbCount: 25,
    breadcrumbScoreMax: 0.25,
    pathWordEnabled: true,
    pathScanDepth: 50,
    pathFallbackEnabled: true,
    pathFallbackDepth: 50,
    mediumSlotIdx: 1,
    diversifierDepth: 5,
    targetInject: {rank5: 1.0, rank10: 0.85, rank20: 0.6, rank35: 0.35, rank50: 0.15},
  },

  normal: {
    breadcrumbCount: 5,
    breadcrumbScoreMax: 0.15,
    pathWordEnabled: true,
    pathScanDepth: 12,
    pathFallbackEnabled: false,
    pathFallbackDepth: 0,
    mediumSlotIdx: 3,
    diversifierDepth: 8,
    targetInject: {rank5: 0.6, rank10: 0.2, rank20: 0.1, rank35: 0, rank50: 0},
  },

  hard: {
    breadcrumbCount: 3,
    breadcrumbScoreMax: 0.10,
    pathWordEnabled: false,
    pathScanDepth: 0,
    pathFallbackEnabled: false,
    pathFallbackDepth: 0,
    mediumSlotIdx: 4,
    diversifierDepth: 10,
    targetInject: {rank5: 0.5, rank10: 0.15, rank20: 0, rank35: 0, rank50: 0},
  },

  expert: {
    breadcrumbCount: 0,
    breadcrumbScoreMax: 0,
    pathWordEnabled: false,
    pathScanDepth: 0,
    pathFallbackEnabled: false,
    pathFallbackDepth: 0,
    mediumSlotIdx: 1,
    diversifierDepth: 5,
    targetInject: {rank5: 0, rank10: 0, rank20: 0, rank35: 0, rank50: 0},
  },
};

export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

export function isDifficulty(s: unknown): s is Difficulty {
  return typeof s === 'string' && s in DIFFICULTY_CONFIGS;
}
