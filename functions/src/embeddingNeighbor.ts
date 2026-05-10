/**
 * Semantic word engine — the core of tir's gameplay.
 *
 * tir is a SEMANTIC MATCHING game: words are connected by MEANING,
 * not by spelling or letter patterns. "cat" → "dog", "kitten", "mouse" —
 * never "car" or "cap".
 *
 * Neighbors are precomputed offline using GloVe (Global Vectors for Word
 * Representation), which encodes word co-occurrence patterns from a large
 * text corpus. This produces genuine semantic similarity: words that appear
 * in similar contexts are neighbors, regardless of how they're spelled.
 *
 * A lexical overlap filter is applied during precomputation to actively
 * strip any neighbors that share character patterns (prefix/suffix > 60%).
 *
 * Data lives in Firestore at `precomputed/neighbors/words/{word}`, each
 * doc containing `neighbors: string[]` (top-50) and `scores: number[]`
 * (cosine similarity, 0–1).
 *
 * Pipeline: `pipeline/build_neighbors.py` (GloVe 300d → cosine → filter → upload).
 * Falls back to stub.ts for words missing from the precomputed graph.
 *
 * Difficulty is controlled via DifficultyConfig — see difficulty.ts for
 * the 4 presets (chill / normal / hard / expert) and the 5 tuning levers.
 */
import * as admin from 'firebase-admin';
import {DIFFICULTY_CONFIGS, DEFAULT_DIFFICULTY} from './difficulty';
import type {Difficulty, DifficultyConfig} from './difficulty';
import {stubNextMove} from './stub';
import type {WordEngineMove} from './stub';

const PRECOMP_COLL = 'precomputed/neighbors/words';

const SEED_WORDS = [
  'morning', 'stone', 'forest', 'garden', 'bridge', 'crystal',
  'river', 'cloud', 'lantern', 'tower', 'meadow', 'harbor',
];

type PrecomputedData = {neighbors: string[]; scores: number[]};

async function getPrecomputedNeighbors(
  db: admin.firestore.Firestore,
  word: string,
): Promise<PrecomputedData | null> {
  const doc = await db.collection(PRECOMP_COLL).doc(word.toLowerCase()).get();
  if (!doc.exists) return null;
  const data = doc.data()!;
  return {
    neighbors: (data.neighbors as string[]) ?? [],
    scores: (data.scores as number[]) ?? [],
  };
}

export function randomSeedWord(): string {
  return SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
}

function mmrPick(args: {
  candidates: string[];
  selected: string[];
  cosineScores: Map<string, number>;
  alpha: number;
}): string | null {
  const {candidates, selected, cosineScores, alpha} = args;
  if (!candidates.length) return null;

  let best: {c: string; score: number} | null = null;
  for (const c of candidates) {
    const relevance = cosineScores.get(c) ?? 0;

    let redundancy = 0;
    for (const s of selected) {
      const sc = cosineScores.get(s) ?? 0;
      const cc = cosineScores.get(c) ?? 0;
      redundancy = Math.max(redundancy, 1 - Math.abs(cc - sc));
    }

    const score = alpha * relevance - (1 - alpha) * redundancy;
    if (!best || score > best.score) {
      best = {c, score};
    }
  }
  return best?.c ?? null;
}

function findBestPathWord(
  cfg: DifficultyConfig,
  targetNeighbors: PrecomputedData,
  currentNeighborSet: Set<string>,
  exclude: Set<string>,
): string | null {
  if (!cfg.pathWordEnabled) return null;

  const scanSlice = targetNeighbors.neighbors.slice(0, cfg.pathScanDepth);
  for (const w of scanSlice) {
    if (currentNeighborSet.has(w) && !exclude.has(w)) {
      return w;
    }
  }

  if (cfg.pathFallbackEnabled) {
    const fallbackSlice = targetNeighbors.neighbors.slice(0, cfg.pathFallbackDepth);
    for (const w of fallbackSlice) {
      if (!exclude.has(w)) return w;
    }
  }

  return null;
}

export async function embeddingNextMove(params: {
  db: admin.firestore.Firestore;
  currentWord: string;
  targetWord: string;
  excludeWords?: string[];
  movesThisRound?: number;
  difficulty?: Difficulty;
  alpha?: number;
}): Promise<WordEngineMove> {
  const alpha = params.alpha ?? 0.6;
  const cfg = DIFFICULTY_CONFIGS[params.difficulty ?? DEFAULT_DIFFICULTY];
  const current = params.currentWord.toLowerCase();
  const target = params.targetWord.toLowerCase();
  const exclude = new Set(
    (params.excludeWords ?? []).map(w => w.toLowerCase()).filter(Boolean),
  );
  exclude.add(current);

  const [currentNeighbors, targetNeighbors] = await Promise.all([
    getPrecomputedNeighbors(params.db, current),
    getPrecomputedNeighbors(params.db, target),
  ]);

  if (!currentNeighbors) {
    return stubNextMove({currentWord: current, targetWord: target, excludeWords: [...exclude]});
  }

  const cosineScores = new Map<string, number>();
  const currentNeighborSet = new Set<string>();
  const pool: string[] = [];

  for (let i = 0; i < currentNeighbors.neighbors.length; i++) {
    const w = currentNeighbors.neighbors[i];
    const s = currentNeighbors.scores[i] ?? 0;
    currentNeighborSet.add(w);
    cosineScores.set(w, s);
    if (!exclude.has(w)) {
      pool.push(w);
    }
  }

  const targetRank = currentNeighbors.neighbors.indexOf(target);
  if (targetRank !== -1 && !exclude.has(target) && !pool.includes(target)) {
    pool.push(target);
  }

  // Inject target's neighbors as directional breadcrumbs (count controlled by difficulty)
  if (targetNeighbors && cfg.breadcrumbCount > 0) {
    const count = cfg.breadcrumbCount;
    for (let i = 0; i < Math.min(count, targetNeighbors.neighbors.length); i++) {
      const w = targetNeighbors.neighbors[i];
      if (!exclude.has(w) && !pool.includes(w)) {
        pool.push(w);
        const targetScore = cfg.breadcrumbScoreMax - (i / count) * (cfg.breadcrumbScoreMax - 0.05);
        if (!cosineScores.has(w)) cosineScores.set(w, targetScore);
      }
    }
  }

  if (pool.length < 4) {
    return stubNextMove({currentWord: current, targetWord: target, excludeWords: [...exclude]});
  }

  const sorted = [...pool].sort(
    (a, b) => (cosineScores.get(b) ?? 0) - (cosineScores.get(a) ?? 0),
  );

  // Slot 1: closest — highest cosine to current word
  const closest = sorted[0];

  // Slot 2: "medium" — position controlled by difficulty
  const medIdx = Math.min(cfg.mediumSlotIdx, sorted.length - 1);
  const medium = sorted[medIdx] !== closest ? sorted[medIdx] : sorted[Math.min(medIdx + 1, sorted.length - 1)];

  // Slot 3: path/bridge word (enabled/disabled by difficulty)
  let pathWord: string | null = null;
  if (targetNeighbors) {
    pathWord = findBestPathWord(cfg, targetNeighbors, currentNeighborSet, new Set([...exclude, closest, medium]));
  }

  const selected = [closest, medium];
  if (pathWord && pathWord !== closest && pathWord !== medium) {
    selected.push(pathWord);
  }

  // Slot 4: diversifier via MMR (depth controlled by difficulty)
  const selectedSet = new Set(selected);
  const remaining = sorted.filter(w => !selectedSet.has(w));
  const divCandidates = remaining.slice(0, Math.max(20, cfg.diversifierDepth * 2));
  const diversifier = mmrPick({
    candidates: divCandidates,
    selected,
    cosineScores,
    alpha,
  });

  if (diversifier) selected.push(diversifier);

  while (selected.length < 4 && remaining.length > 0) {
    const next = remaining.find(w => !selected.includes(w));
    if (!next) break;
    selected.push(next);
  }

  if (selected.length < 4) {
    return stubNextMove({currentWord: current, targetWord: target, excludeWords: [...exclude]});
  }

  // Progressive target injection (probability controlled by difficulty)
  if (targetRank !== -1 && !exclude.has(target) && !selected.includes(target)) {
    const ti = cfg.targetInject;
    let injectProb = 0;
    if (targetRank < 5) injectProb = ti.rank5;
    else if (targetRank < 10) injectProb = ti.rank10;
    else if (targetRank < 20) injectProb = ti.rank20;
    else if (targetRank < 35) injectProb = ti.rank35;
    else injectProb = ti.rank50;

    if (Math.random() < injectProb) {
      selected[selected.length - 1] = target;
    }
  }

  const options = selected.slice(0, 4);

  // Fisher-Yates shuffle
  for (let i = options.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [options[i], options[j]] = [options[j], options[i]];
  }

  return {
    currentWord: current,
    targetWord: target,
    options: options as [string, string, string, string],
    generationMeta: {provider: 'precomputed', k: pool.length, alpha, difficulty: params.difficulty ?? DEFAULT_DIFFICULTY},
  };
}

/**
 * BFS through the precomputed neighbor graph to find the shortest
 * semantic path from startWord to targetWord. Returns the path as
 * an array of words, or null if unreachable within maxDepth hops.
 */
export async function findShortestPath(
  db: admin.firestore.Firestore,
  startWord: string,
  targetWord: string,
  maxDepth: number = 6,
): Promise<string[] | null> {
  const start = startWord.toLowerCase();
  const target = targetWord.toLowerCase();
  if (start === target) return [start];

  const queue: {word: string; path: string[]}[] = [{word: start, path: [start]}];
  const visited = new Set<string>([start]);

  while (queue.length > 0) {
    const {word, path} = queue.shift()!;
    if (path.length > maxDepth) break;

    const neighbors = await getPrecomputedNeighbors(db, word);
    if (!neighbors) continue;

    for (const n of neighbors.neighbors.slice(0, 15)) {
      if (n === target) return [...path, target];
      if (!visited.has(n)) {
        visited.add(n);
        queue.push({word: n, path: [...path, n]});
      }
    }
  }
  return null;
}

export async function computeCosineDist(
  db: admin.firestore.Firestore,
  word: string,
  target: string,
): Promise<number> {
  const data = await getPrecomputedNeighbors(db, word);
  if (!data) return 1;
  const idx = data.neighbors.indexOf(target.toLowerCase());
  if (idx !== -1) return 1 - (data.scores[idx] ?? 0);
  return 1;
}
