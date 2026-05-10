/**
 * Difficulty simulator — Monte Carlo estimate of average round length per
 * difficulty preset. Mirrors `functions/src/embeddingNeighbor.ts` and
 * `difficulty.ts` exactly, but runs against the local
 * `pipeline/out/neighbors.json` snapshot so no Firestore reads are needed.
 *
 * Player model ("decent player"): for each move, look up cosine distance
 * from each of the 4 options to the target. With probability OPTIMAL_PROB
 * pick the option with the smallest distance; otherwise pick uniformly
 * at random among the 4. If all distances are 1 (no signal), uniform
 * random.
 *
 * Run: `node scripts/sim_difficulty.mjs [--games 200] [--difficulty normal]`
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Difficulty configs — kept in sync with functions/src/difficulty.ts
// ---------------------------------------------------------------------------
const DIFFICULTY_CONFIGS = {
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
  // Old-normal kept around so we can baseline the change.
  normal_old: {
    breadcrumbCount: 8,
    breadcrumbScoreMax: 0.15,
    pathWordEnabled: true,
    pathScanDepth: 15,
    pathFallbackEnabled: false,
    pathFallbackDepth: 0,
    mediumSlotIdx: 3,
    diversifierDepth: 8,
    targetInject: {rank5: 0.7, rank10: 0.3, rank20: 0.1, rank35: 0, rank50: 0},
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

// ---------------------------------------------------------------------------
// Load the precomputed neighbor graph once. Schema:
//   { [word]: [{w: string, s: number}, ...] }   // top-50 sorted desc
// ---------------------------------------------------------------------------
const RAW = JSON.parse(readFileSync(resolve(REPO, 'pipeline/out/neighbors.json'), 'utf8'));
const TARGETS = JSON.parse(readFileSync(resolve(REPO, 'pipeline/out/targets.json'), 'utf8'));

// Convert into the same shape `getPrecomputedNeighbors` returns.
const NEIGHBORS = new Map();
for (const [w, arr] of Object.entries(RAW)) {
  NEIGHBORS.set(w, {
    neighbors: arr.map(x => x.w),
    scores: arr.map(x => x.s),
  });
}

const SEED_WORDS = [
  'morning', 'stone', 'forest', 'garden', 'bridge', 'crystal',
  'river', 'cloud', 'lantern', 'tower', 'meadow', 'harbor',
];

// targets.json shape: [{word, score, avg, top, inbound, strongIn}, ...]
const TARGET_POOL = TARGETS.map(t => t.word).filter(w => NEIGHBORS.has(w));

// ---------------------------------------------------------------------------
// Pure-JS port of embeddingNextMove. Identical semantics modulo the
// Firestore async wrapper.
// ---------------------------------------------------------------------------
function getNeighbors(word) {
  return NEIGHBORS.get(word.toLowerCase()) ?? null;
}

function mmrPick({candidates, selected, cosineScores, alpha}) {
  if (!candidates.length) return null;
  let best = null;
  for (const c of candidates) {
    const relevance = cosineScores.get(c) ?? 0;
    let redundancy = 0;
    for (const s of selected) {
      const sc = cosineScores.get(s) ?? 0;
      const cc = cosineScores.get(c) ?? 0;
      redundancy = Math.max(redundancy, 1 - Math.abs(cc - sc));
    }
    const score = alpha * relevance - (1 - alpha) * redundancy;
    if (!best || score > best.score) best = {c, score};
  }
  return best?.c ?? null;
}

function findBestPathWord(cfg, targetNeighbors, currentNeighborSet, exclude) {
  if (!cfg.pathWordEnabled) return null;
  const scanSlice = targetNeighbors.neighbors.slice(0, cfg.pathScanDepth);
  for (const w of scanSlice) {
    if (currentNeighborSet.has(w) && !exclude.has(w)) return w;
  }
  if (cfg.pathFallbackEnabled) {
    const fallbackSlice = targetNeighbors.neighbors.slice(0, cfg.pathFallbackDepth);
    for (const w of fallbackSlice) {
      if (!exclude.has(w)) return w;
    }
  }
  return null;
}

function nextMove({currentWord, targetWord, excludeWords, cfg, alpha = 0.6}) {
  const current = currentWord.toLowerCase();
  const target = targetWord.toLowerCase();
  const exclude = new Set(excludeWords.map(w => w.toLowerCase()).filter(Boolean));
  exclude.add(current);

  const currentNeighbors = getNeighbors(current);
  const targetNeighbors = getNeighbors(target);
  if (!currentNeighbors) return null;

  const cosineScores = new Map();
  const currentNeighborSet = new Set();
  const pool = [];
  for (let i = 0; i < currentNeighbors.neighbors.length; i++) {
    const w = currentNeighbors.neighbors[i];
    const s = currentNeighbors.scores[i] ?? 0;
    currentNeighborSet.add(w);
    cosineScores.set(w, s);
    if (!exclude.has(w)) pool.push(w);
  }

  const targetRank = currentNeighbors.neighbors.indexOf(target);
  if (targetRank !== -1 && !exclude.has(target) && !pool.includes(target)) {
    pool.push(target);
  }

  if (targetNeighbors && cfg.breadcrumbCount > 0) {
    const count = cfg.breadcrumbCount;
    for (let i = 0; i < Math.min(count, targetNeighbors.neighbors.length); i++) {
      const w = targetNeighbors.neighbors[i];
      if (!exclude.has(w) && !pool.includes(w)) {
        pool.push(w);
        const ts = cfg.breadcrumbScoreMax - (i / count) * (cfg.breadcrumbScoreMax - 0.05);
        if (!cosineScores.has(w)) cosineScores.set(w, ts);
      }
    }
  }

  if (pool.length < 4) return null;

  const sorted = [...pool].sort(
    (a, b) => (cosineScores.get(b) ?? 0) - (cosineScores.get(a) ?? 0),
  );
  const closest = sorted[0];
  const medIdx = Math.min(cfg.mediumSlotIdx, sorted.length - 1);
  const medium = sorted[medIdx] !== closest
    ? sorted[medIdx]
    : sorted[Math.min(medIdx + 1, sorted.length - 1)];

  let pathWord = null;
  if (targetNeighbors) {
    pathWord = findBestPathWord(cfg, targetNeighbors, currentNeighborSet, new Set([...exclude, closest, medium]));
  }

  const selected = [closest, medium];
  if (pathWord && pathWord !== closest && pathWord !== medium) selected.push(pathWord);

  const selectedSet = new Set(selected);
  const remaining = sorted.filter(w => !selectedSet.has(w));
  const divCandidates = remaining.slice(0, Math.max(20, cfg.diversifierDepth * 2));
  const diversifier = mmrPick({candidates: divCandidates, selected, cosineScores, alpha});
  if (diversifier) selected.push(diversifier);

  while (selected.length < 4 && remaining.length > 0) {
    const next = remaining.find(w => !selected.includes(w));
    if (!next) break;
    selected.push(next);
  }
  if (selected.length < 4) return null;

  if (targetRank !== -1 && !exclude.has(target) && !selected.includes(target)) {
    const ti = cfg.targetInject;
    let p = 0;
    if (targetRank < 5) p = ti.rank5;
    else if (targetRank < 10) p = ti.rank10;
    else if (targetRank < 20) p = ti.rank20;
    else if (targetRank < 35) p = ti.rank35;
    else p = ti.rank50;
    if (Math.random() < p) selected[selected.length - 1] = target;
  }

  // Fisher-Yates
  const opts = selected.slice(0, 4);
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  return opts;
}

// ---------------------------------------------------------------------------
// "Decent player" intuition model.
//
// A real player doesn't have raw cosine numbers — they have a sense of
// "does this word feel closer to the target?". We model that as the BFS
// hop count through the precomputed neighbor graph (top-K neighbors per
// hop). Lower hops = feels closer.
//
// We BFS from the target ONCE per game (target doesn't change), cache it,
// and then per-move score each option as `distMap.get(option) ?? Infinity`.
// This mirrors the heuristic a thoughtful player applies (chains of
// associations from candidate → target).
//
// Picker: with prob OPTIMAL_PROB pick the option with the lowest hop
// count (ties broken uniformly); else uniform random among the 4. This
// matches the calibration model used to generate the prior averages.
// ---------------------------------------------------------------------------
const BFS_DEPTH = 4; // how far ahead a "decent player" can reason
const BFS_K = 15; // neighbors-per-hop the player considers (matches findShortestPath)
const OPTIMAL_PROB = 0.7;

function bfsFromTarget(target) {
  const dist = new Map();
  dist.set(target, 0);
  let frontier = [target];
  for (let depth = 1; depth <= BFS_DEPTH; depth++) {
    const next = [];
    for (const w of frontier) {
      const n = NEIGHBORS.get(w);
      if (!n) continue;
      for (let i = 0; i < Math.min(BFS_K, n.neighbors.length); i++) {
        const nb = n.neighbors[i];
        if (!dist.has(nb)) {
          dist.set(nb, depth);
          next.push(nb);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return dist;
}

function pickOption(options, distMap) {
  if (Math.random() >= OPTIMAL_PROB) {
    return options[Math.floor(Math.random() * options.length)];
  }
  let best = Infinity;
  for (const o of options) {
    const d = distMap.get(o) ?? Infinity;
    if (d < best) best = d;
  }
  const ties = options.filter(o => (distMap.get(o) ?? Infinity) === best);
  return ties[Math.floor(Math.random() * ties.length)];
}

// ---------------------------------------------------------------------------
// Single-game simulation. Returns moves used (or null if abandoned).
// ---------------------------------------------------------------------------
const MAX_MOVES = 80;
function simulateGame({startWord, target, cfg}) {
  const distMap = bfsFromTarget(target);
  let current = startWord.toLowerCase();
  const used = []; // matches usedOptionWords on player doc
  for (let move = 1; move <= MAX_MOVES; move++) {
    const opts = nextMove({
      currentWord: current,
      targetWord: target,
      excludeWords: used,
      cfg,
    });
    if (!opts) return null; // pool drained — bail
    const pick = pickOption(opts, distMap);
    used.push(pick);
    if (pick === target) return move;
    current = pick;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Run a campaign of N games per difficulty, sampling start/target from the
// vocab. Reports avg/median/p10/p90/reach%.
// ---------------------------------------------------------------------------
function pctile(arr, p) {
  if (!arr.length) return NaN;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function runCampaign(label, cfg, games) {
  const moveCounts = [];
  let reached = 0;
  let attempted = 0;
  for (let g = 0; g < games; g++) {
    const start = SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
    let target;
    let tries = 0;
    do {
      target = TARGET_POOL[Math.floor(Math.random() * TARGET_POOL.length)];
      tries++;
    } while ((!NEIGHBORS.has(target) || target === start) && tries < 20);
    if (!NEIGHBORS.has(target)) continue;
    attempted++;
    const m = simulateGame({startWord: start, target, cfg});
    if (m != null) {
      moveCounts.push(m);
      reached++;
    }
  }
  const avg = moveCounts.reduce((s, x) => s + x, 0) / Math.max(1, moveCounts.length);
  return {
    label,
    games: attempted,
    reached,
    reachPct: (100 * reached) / Math.max(1, attempted),
    avg,
    med: pctile(moveCounts, 0.5),
    p10: pctile(moveCounts, 0.1),
    p90: pctile(moveCounts, 0.9),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const games = parseInt(arg('games', '500'), 10);
const onlyDiff = arg('difficulty', null);

const order = onlyDiff
  ? [onlyDiff]
  : ['chill', 'normal_old', 'normal', 'hard', 'expert'];

console.log(`# tir difficulty simulation`);
console.log(`# vocab=${NEIGHBORS.size} words, target_pool=${TARGET_POOL.length}, games=${games}/diff, max_moves=${MAX_MOVES}, optimal_pick=${OPTIMAL_PROB}`);
console.log('');
console.log('diff         games  reach%   avg    med   p10   p90');
console.log('-'.repeat(56));
for (const d of order) {
  const cfg = DIFFICULTY_CONFIGS[d];
  if (!cfg) continue;
  const r = runCampaign(d, cfg, games);
  console.log(
    `${d.padEnd(12)} ${String(r.games).padStart(5)}  ${r.reachPct.toFixed(1).padStart(5)}%  ${r.avg.toFixed(1).padStart(5)}  ${String(r.med).padStart(4)}  ${String(r.p10).padStart(4)}  ${String(r.p90).padStart(4)}`,
  );
}
