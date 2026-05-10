export type WordEngineMove = {
  currentWord: string;
  targetWord: string;
  options: [string, string, string, string];
  generationMeta: {provider: 'stub' | 'precomputed'; k: number; alpha: number; [key: string]: unknown};
};

/**
 * Compact 28-word stub vocabulary — fallback for when a word is missing
 * from the precomputed semantic neighbor graph. The real game uses ~1200+
 * GloVe-powered words where neighbors reflect MEANING similarity
 * (not spelling). This stub is a safety net, not the primary engine.
 */
const STUB_VOCAB = [
  'start',
  'stone',
  'rock',
  'pebble',
  'mountain',
  'hill',
  'river',
  'stream',
  'ocean',
  'lake',
  'forest',
  'tree',
  'leaf',
  'fire',
  'flame',
  'ember',
  'smoke',
  'cloud',
  'rain',
  'storm',
  'wind',
  'snow',
  'ice',
  'sun',
  'light',
  'shadow',
  'night',
  'day',
];

const NEIGHBORS: Record<string, string[]> = {
  start: ['stone', 'rock', 'pebble', 'hill', 'river', 'forest', 'fire', 'wind'],
  stone: ['rock', 'pebble', 'hill', 'mountain', 'river', 'forest'],
  rock: ['stone', 'pebble', 'hill', 'mountain'],
  pebble: ['stone', 'rock', 'river', 'stream'],
  mountain: ['hill', 'stone', 'rock', 'snow', 'ice'],
  hill: ['mountain', 'stone', 'rock', 'forest', 'tree'],
  river: ['stream', 'lake', 'ocean', 'pebble', 'forest'],
  stream: ['river', 'lake', 'forest'],
  ocean: ['lake', 'river', 'storm', 'wind', 'cloud'],
  lake: ['river', 'stream', 'ocean', 'forest'],
  forest: ['tree', 'leaf', 'river', 'hill', 'shadow'],
  tree: ['leaf', 'forest', 'shadow'],
  leaf: ['tree', 'forest', 'wind'],
  fire: ['flame', 'ember', 'smoke', 'light', 'shadow'],
  flame: ['fire', 'ember', 'smoke', 'light'],
  ember: ['fire', 'flame', 'smoke'],
  smoke: ['fire', 'flame', 'cloud', 'shadow'],
  cloud: ['rain', 'storm', 'wind', 'shadow'],
  rain: ['storm', 'cloud', 'river', 'lake'],
  storm: ['wind', 'rain', 'cloud', 'ocean'],
  wind: ['storm', 'cloud', 'leaf', 'snow'],
  snow: ['ice', 'mountain', 'wind', 'night'],
  ice: ['snow', 'lake', 'mountain', 'shadow'],
  sun: ['light', 'day', 'shadow'],
  light: ['sun', 'day', 'shadow', 'fire'],
  shadow: ['night', 'light', 'forest', 'cloud'],
  night: ['day', 'shadow', 'snow'],
  day: ['night', 'sun', 'light'],
};

/**
 * Hardcoded fallback targets — used only if the dynamic target list
 * from Firestore (precomputed/targets) can't be loaded. In normal
 * operation these are never used; the pipeline auto-scores 1000+ words
 * for target suitability and uploads them to Firestore.
 */
const FALLBACK_TARGETS = [
  'ocean', 'forest', 'mountain', 'castle', 'dragon', 'crystal',
  'volcano', 'glacier', 'desert', 'jungle', 'temple', 'diamond',
  'falcon', 'whale', 'tiger', 'eagle', 'dolphin', 'wolf',
  'pearl', 'ruby', 'emerald', 'sapphire', 'jade',
  'storm', 'blizzard', 'aurora', 'twilight', 'lightning',
  'dream', 'legend', 'myth', 'treasure', 'mystery',
  'crown', 'throne', 'sword', 'hammer',
  'violin', 'piano', 'guitar',
  'rocket', 'nebula', 'galaxy',
  'orchid', 'lotus', 'rose',
  'lighthouse', 'pyramid', 'fountain',
];

let _cachedTargets: string[] | null = null;
let _cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Load auto-scored target words from Firestore.
 * The pipeline (build_neighbors.py) scores every word in the vocab for
 * target suitability based on:
 *   - Word length >= 4
 *   - Average neighbor score in [0.19, 0.45] (connected but not clustered)
 *   - Top neighbor score >= 0.25
 *   - Inbound links >= 5 (reachable from multiple directions)
 *   - Not a basic verb/adjective/color
 *
 * Results are cached in-memory for 5 minutes to avoid repeated reads.
 */
async function loadTargetPool(
  db: import('firebase-admin').firestore.Firestore,
): Promise<string[]> {
  if (_cachedTargets && Date.now() - _cacheTimestamp < CACHE_TTL_MS) {
    return _cachedTargets;
  }

  try {
    const doc = await db.collection('precomputed').doc('targets').get();
    if (doc.exists) {
      const words = (doc.data()?.words as string[]) ?? [];
      if (words.length > 0) {
        _cachedTargets = words;
        _cacheTimestamp = Date.now();
        return words;
      }
    }
  } catch {
    // Fall through to hardcoded fallback
  }

  return FALLBACK_TARGETS;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export function neighborsFor(word: string): string[] {
  return NEIGHBORS[word] ?? [];
}

function mmrPick(args: {
  current: string;
  candidates: string[];
  selected: string[];
  alpha: number;
}): string | null {
  const {current, candidates, selected, alpha} = args;
  if (!candidates.length) return null;
  const sim = (a: string, b: string): number => {
    const list = neighborsFor(a);
    const idx = list.indexOf(b);
    if (idx === -1) return 0;
    return 1 - idx / Math.max(1, list.length);
  };
  let best: {c: string; score: number} | null = null;
  for (const c of candidates) {
    const rel = sim(current, c);
    let red = 0;
    for (const s of selected) {
      red = Math.max(red, sim(c, s));
    }
    const score = alpha * rel - (1 - alpha) * red;
    if (!best || score > best.score) {
      best = {c, score};
    }
  }
  return best?.c ?? null;
}

/**
 * Pick the next target word for a new round.
 *
 * Reads the auto-scored target list from Firestore (precomputed/targets).
 * Ensures the new target is semantically distant from the previous one
 * by excluding its top-20 precomputed neighbors.
 *
 * The target list is generated by the pipeline (build_neighbors.py) which
 * scores every word for: connectivity, reachability, semantic richness,
 * and interestingness. No static curation required — just expand the
 * seed vocabulary and re-run the pipeline.
 */
export async function pickNextTargetWord(params: {
  currentWord: string;
  avoidTarget?: string;
  db?: import('firebase-admin').firestore.Firestore;
}): Promise<string> {
  const c = params.currentWord.toLowerCase();
  const avoid = params.avoidTarget?.toLowerCase();
  const avoidSet = new Set<string>();
  avoidSet.add(c);
  if (avoid) avoidSet.add(avoid);

  // Exclude semantically close words to the previous target
  if (avoid && params.db) {
    try {
      const doc = await params.db
        .collection('precomputed/neighbors/words')
        .doc(avoid)
        .get();
      if (doc.exists) {
        const neighbors = (doc.data()?.neighbors as string[]) ?? [];
        for (const n of neighbors.slice(0, 20)) {
          avoidSet.add(n);
        }
      }
    } catch {
      // Fall through
    }
  }

  if (avoid) {
    for (const n of neighborsFor(avoid)) avoidSet.add(n);
  }

  // Load dynamic target pool from Firestore
  const targetPool = params.db
    ? await loadTargetPool(params.db)
    : FALLBACK_TARGETS;

  const pool = targetPool.filter(w => !avoidSet.has(w));

  if (pool.length > 0) {
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // Ultra-fallback: any target not identical to current/avoid
  const fallback = targetPool.filter(w => w !== c && w !== avoid);
  return fallback[Math.floor(Math.random() * fallback.length)] ?? 'ocean';
}

export function stubNextMove(params: {
  currentWord: string;
  targetWord: string;
  excludeWords?: string[];
  k?: number;
  alpha?: number;
}): WordEngineMove {
  const k = params.k ?? 50;
  const alpha = params.alpha ?? 0.85;
  const current = params.currentWord.toLowerCase();
  const target = params.targetWord.toLowerCase();
  const exclude = new Set(
    (params.excludeWords ?? []).map(w => w.toLowerCase()).filter(Boolean),
  );
  exclude.add(current);
  const pool = uniq([
    ...neighborsFor(current),
    ...neighborsFor(target),
    ...STUB_VOCAB,
  ])
    .filter(w => !exclude.has(w))
    .slice(0, k);
  const sorted = [...pool].sort((a, b) => {
    const ai = neighborsFor(current).indexOf(a);
    const bi = neighborsFor(current).indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  const first3 = sorted.slice(0, 3);
  const remaining = sorted.slice(3);
  const fourth = mmrPick({current, candidates: remaining, selected: first3, alpha});
  const options = uniq([...first3, ...(fourth ? [fourth] : [])]).slice(0, 4);
  while (options.length < 4) {
    const fallback = STUB_VOCAB.find(w => !options.includes(w) && !exclude.has(w));
    if (!fallback) break;
    options.push(fallback);
  }
  return {
    currentWord: current,
    targetWord: target,
    options: options as [string, string, string, string],
    generationMeta: {provider: 'stub', k, alpha},
  };
}

export {STUB_VOCAB as VOCAB};
