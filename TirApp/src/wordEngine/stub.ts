export type WordEngineMove = {
  currentWord: string;
  targetWord: string;
  options: [string, string, string, string];
  generationMeta: {
    provider: 'stub';
    k: number;
    alpha: number;
  };
};

const VOCAB = [
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

// Hand-curated neighbor lists for Phase 1. Not “semantic”, but stable.
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

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function neighborsFor(word: string): string[] {
  return NEIGHBORS[word] ?? [];
}

function mmrPick(args: {
  current: string;
  candidates: string[];
  selected: string[];
  alpha: number;
}): string | null {
  const { current, candidates, selected, alpha } = args;
  if (!candidates.length) return null;

  // Similarity is approximated by rank proximity in neighbor lists.
  const sim = (a: string, b: string): number => {
    const list = neighborsFor(a);
    const idx = list.indexOf(b);
    if (idx === -1) return 0;
    return 1 - idx / Math.max(1, list.length);
  };

  let best: { c: string; score: number } | null = null;
  for (const c of candidates) {
    const rel = sim(current, c);
    let red = 0;
    for (const s of selected) {
      red = Math.max(red, sim(c, s));
    }
    const score = alpha * rel - (1 - alpha) * red;
    if (!best || score > best.score) {
      best = { c, score };
    }
  }
  return best?.c ?? null;
}

/** Pick a new target different from `currentWord` (and optionally the prior target). */
export function pickNextTargetWord(params: {
  currentWord: string;
  avoidTarget?: string;
}): string {
  const c = params.currentWord.toLowerCase();
  const avoid = params.avoidTarget?.toLowerCase();
  const candidates = VOCAB.filter(w => w !== c && w !== avoid);
  const pool = candidates.length ? candidates : VOCAB.filter(w => w !== c);
  return pool[Math.floor(Math.random() * pool.length)] ?? 'ocean';
}

export function stubNextMove(params: {
  currentWord: string;
  targetWord: string;
  /** Words already chosen this round; must not appear as options again. */
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
    ...VOCAB,
  ])
    .filter(w => !exclude.has(w))
    .slice(0, k);

  const sorted = [...pool].sort((a, b) => {
    const ai = neighborsFor(current).indexOf(a);
    const bi = neighborsFor(current).indexOf(b);
    const as = ai === -1 ? 999 : ai;
    const bs = bi === -1 ? 999 : bi;
    return as - bs;
  });

  const first3 = sorted.slice(0, 3);
  const remaining = sorted.slice(3);
  const fourth = mmrPick({
    current,
    candidates: remaining,
    selected: first3,
    alpha,
  });

  const options = uniq([...first3, ...(fourth ? [fourth] : [])]).slice(0, 4);
  while (options.length < 4) {
    const fallback = VOCAB.find(w => !options.includes(w) && !exclude.has(w));
    if (!fallback) break;
    options.push(fallback);
  }

  return {
    currentWord: current,
    targetWord: target,
    options: options as [string, string, string, string],
    generationMeta: { provider: 'stub', k, alpha },
  };
}

