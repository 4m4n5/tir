# Word engine (semantic similarity)

> **Core principle:** tir is a **semantic matching game**. Words are connected
> by **meaning**, not by spelling or letter patterns. "cat" → "dog", "kitten",
> "mouse" — never "car" or "cap". "piano" → "violin", "guitar", "melody" —
> never "piano" → "pint" or "pine".

## Definitions

- **Word**: a single English token (ASCII letters), lowercased internally.
- **Similarity**: semantic (meaning-based) similarity via word embeddings.
  NOT edit distance, NOT letter overlap, NOT spelling patterns.
- **Disallowed**: profanity; plural/tenses variants (v1); multi-word phrases.
- **Proper nouns**: configurable via policy.

## Embedding model: GloVe

We use **GloVe** (Global Vectors for Word Representation) — specifically
`glove.6B.300d` — trained on Wikipedia + Gigaword corpus (6B tokens).

**Why GloVe over sentence transformers (e.g., all-MiniLM-L6-v2)?**

- Sentence transformers use subword tokenization (WordPiece/BPE), which causes
  words with similar character sequences to have similar embeddings even when
  semantically unrelated ("cat"/"car"/"cap" share the "ca" subword token).
- GloVe is trained on **word co-occurrence**: words that appear in similar
  contexts get similar vectors. This captures genuine semantic relationships
  without any character-level noise.

## Vocabulary

~900 curated, common English words — **lexically simple** (words people know)
but **semantically rich** (diverse meaning domains: nature, animals, food,
emotions, places, actions, science, etc.).

No NLTK padding or obscure dictionary words. Every word in the vocab should be
recognizable to a typical English speaker.

Edit `SEED_WORDS` in `pipeline/build_neighbors.py` to expand the vocabulary.

## Lexical overlap filter

Even with GloVe, occasional character-similar words can appear as neighbors.
The pipeline applies a **lexical overlap filter** (threshold 60%) that measures
shared prefix/suffix ratio and substring containment. Any neighbor exceeding
the threshold is stripped and replaced with the next-best semantic neighbor.

## Option generation (server-side)

Given `(currentWord, targetWord, excludeWords)`, produce 4 distinct options:

1. **Candidate pool**: read top-50 precomputed neighbors from Firestore.
2. **Selection mix**: 1 closest + 1 medium-range + 1 path-toward-target + 1 MMR diversifier.
3. **MMR diversifier** (alpha ~0.6): maximizes cosine relevance while minimizing
   redundancy with already-selected options.
4. **Minimum-moves guard**: target word is excluded from options until ≥ 2 moves
   have been made in the round.
5. **Shuffle**: options are shuffled before returning to the client.

Falls back to `stub.ts` (28-word hand-curated graph) if the word is missing
from precomputed data.

## Data model

```
precomputed/neighbors/words/{word}
  neighbors: string[]   # top-50 semantic neighbors (by meaning)
  scores: number[]      # cosine similarity scores (0–1)
```

## Pipeline

```bash
cd pipeline
python3 build_neighbors.py --upload
```

Source: `pipeline/build_neighbors.py`  
Model: GloVe 300d (downloaded from Stanford NLP)  
Output: JSON + Firestore upload to `precomputed/neighbors/words/`

## Server entry point

`functions/src/embeddingNeighbor.ts` → `embeddingNextMove()`

Reads precomputed neighbors, applies MMR selection, returns 4 options.
`generationMeta.provider` is `'precomputed'` for GloVe-backed moves,
`'stub'` for fallback.
