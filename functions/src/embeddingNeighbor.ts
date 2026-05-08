import * as admin from 'firebase-admin';
import {filterVocab} from './contentPolicy';
import {neighborsFor, stubNextMove, VOCAB} from './stub';

const CACHE = 'cache';
const EMB = 'wordEmbeddings';

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

async function fetchOpenAiEmbedding(word: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('no_openai_key');
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: word,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`openai_embed_failed:${res.status}:${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    data?: Array<{embedding: number[]}>;
  };
  const vec = json.data?.[0]?.embedding;
  if (!vec?.length) {
    throw new Error('openai_embed_empty');
  }
  return vec;
}

async function getCachedEmbedding(
  db: admin.firestore.Firestore,
  word: string,
): Promise<number[] | null> {
  const doc = await db
    .collection(CACHE)
    .doc(EMB)
    .collection('words')
    .doc(word.toLowerCase())
    .get();
  const v = doc.data()?.vector as number[] | undefined;
  return v?.length ? v : null;
}

async function putCachedEmbedding(
  db: admin.firestore.Firestore,
  word: string,
  vector: number[],
): Promise<void> {
  await db
    .collection(CACHE)
    .doc(EMB)
    .collection('words')
    .doc(word.toLowerCase())
    .set(
      {
        vector,
        model: 'text-embedding-3-small',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
}

async function getEmbedding(db: admin.firestore.Firestore, word: string): Promise<number[]> {
  const cached = await getCachedEmbedding(db, word);
  if (cached) return cached;
  const vec = await fetchOpenAiEmbedding(word);
  await putCachedEmbedding(db, word, vec);
  return vec;
}

function mmrPickEmbedding(args: {
  candidates: string[];
  selected: string[];
  simCurrent: Map<string, number>;
  vectors: Map<string, number[]>;
  alpha: number;
}): string | null {
  const {candidates, selected, simCurrent, vectors, alpha} = args;
  if (!candidates.length) return null;
  let best: {c: string; score: number} | null = null;
  for (const c of candidates) {
    const rel = simCurrent.get(c) ?? 0;
    const ev = vectors.get(c);
    let red = 0;
    if (ev) {
      for (const s of selected) {
        const sv = vectors.get(s);
        if (sv) {
          red = Math.max(red, cosine(ev, sv));
        }
      }
    }
    const score = alpha * rel - (1 - alpha) * red;
    if (!best || score > best.score) {
      best = {c, score};
    }
  }
  return best?.c ?? null;
}

/**
 * 3 nearest by embedding cosine + 1 MMR diversifier from a capped pool.
 * Falls back to stub graph when OPENAI_API_KEY is unset or on any error.
 */
export async function embeddingNextMove(params: {
  db: admin.firestore.Firestore;
  currentWord: string;
  targetWord: string;
  excludeWords?: string[];
  k?: number;
  alpha?: number;
}): Promise<ReturnType<typeof stubNextMove>> {
  const k = params.k ?? 50;
  const alpha = params.alpha ?? 0.85;
  const current = params.currentWord.toLowerCase();
  const target = params.targetWord.toLowerCase();
  const exclude = new Set(
    (params.excludeWords ?? []).map(w => w.toLowerCase()).filter(Boolean),
  );
  exclude.add(current);

  if (!process.env.OPENAI_API_KEY) {
    return stubNextMove({currentWord: current, targetWord: target, excludeWords: [...exclude]});
  }

  try {
    const pool = filterVocab(
      [...new Set([...neighborsFor(current), ...neighborsFor(target), ...VOCAB])],
    )
      .filter(w => !exclude.has(w))
      .slice(0, k);

    const curVec = await getEmbedding(params.db, current);
    const simCurrent = new Map<string, number>();
    const vectors = new Map<string, number[]>();
    for (const w of pool) {
      const ev = await getEmbedding(params.db, w);
      vectors.set(w, ev);
      simCurrent.set(w, cosine(curVec, ev));
    }
    const sorted = [...pool].sort((a, b) => (simCurrent.get(b) ?? 0) - (simCurrent.get(a) ?? 0));
    const first3 = sorted.slice(0, 3);
    const remaining = sorted.slice(3);
    const fourth = mmrPickEmbedding({
      candidates: remaining,
      selected: first3,
      simCurrent,
      vectors,
      alpha,
    });
    const options = [...new Set([...first3, ...(fourth ? [fourth] : [])])].slice(0, 4);
    while (options.length < 4) {
      const fb = VOCAB.find(w => !options.includes(w) && !exclude.has(w));
      if (!fb) break;
      options.push(fb);
    }
    return {
      currentWord: current,
      targetWord: target,
      options: options as [string, string, string, string],
      generationMeta: {provider: 'stub', k, alpha},
    };
  } catch {
    return stubNextMove({currentWord: current, targetWord: target, excludeWords: [...exclude]});
  }
}
