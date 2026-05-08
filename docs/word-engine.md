# Word engine (v1)

This doc defines:

- What a “word” is in `tir`
- How we generate the **4 options** each move
- How we add **variety** while staying “closest”
- The minimal interfaces the rest of the system depends on

## Definitions

- **Word**: a single English token (ASCII letters), lowercased for internal IDs, displayed with original casing if desired.
- **Disallowed**: profanity; plural/tenses variants (v1); multi-word phrases (v1).
- **Proper nouns**: allowed (v1), but filtered via a configurable policy (see below).
- **Distance**: semantic similarity via embeddings (v1 target), but the game loop must work with a stub provider first.

## Primary contract

Given:

- `currentWord`
- `targetWord` (always visible to player)
- optional `playerId`, `roomId` (for future personalization)

Return:

- `options[4]` (distinct words, none equal to `currentWord`)
- plus a `generationMeta` payload (for debugging/telemetry only; not shown to players)

## Option generation rule (“3 nearest + 1 diversifier”)

We want “4 closest” but also avoid trapping players in one narrow semantic domain.

### Step 1 — Candidate pool

- Compute nearest neighbors to `currentWord` using embedding cosine similarity.
- Take the top K candidates after filtering (policy filters below).
  - v1 default: `K = 50` (tunable).

### Step 2 — Choose the first 3 (pure nearest)

- Sort candidate pool by similarity to `currentWord` descending.
- Pick the top 3 distinct words.

### Step 3 — Choose the 4th (diversifier via MMR)

Pick one additional word from the remaining pool that’s still close **but** not redundant with the top 3.

Use Maximal Marginal Relevance (MMR):

score(c) = \alpha \cdot sim(current,c) - (1-\alpha)\cdot \max_{s \in selected} sim(c,s)

- `selected` is the set of the 3 chosen nearest options.
- sim(\cdot,\cdot) is cosine similarity between embeddings.
- v1 default: \alpha = 0.85 (tunable).

Then pick `argmax(score(c))`.

### Notes

- This preserves “closest” because the diversifier is still chosen from a top-K nearest pool.
- We can optionally bias the pool toward words that *also* reduce distance to target, but v1 will keep it simple to avoid being “solvable”.

## Filters / policies (v1)

- **Profanity**: hard blocklist.
- **Morphology**: basic lemmatization gate (or a curated allowed-list) to avoid plural/tenses.
- **Proper nouns**: configurable `properNounsPolicy`:
  - `allow_some`: allow but cap the fraction in the top-K pool
  - `allow_all`
  - `block_all`

## Stub provider (Phase 1)

Before embeddings exist, we will ship a stub provider that:

- uses a small curated vocabulary
- uses a precomputed neighbor map (JSON)
- returns 4 options using the same selection interface

This unblocks:

- realtime rooms, finish window, target rotation
- UI/UX iteration
- reward plumbing

## Embeddings provider (Phase 2 / v1)

Firebase-friendly approach:

- Implement a pluggable `EmbeddingProvider` interface.
- Start with **server-side on-demand** embedding + neighbor lookup + caching.
- Cache:
  - `embedding(word)` in Firestore/Redis-like store (later) or in-memory (short TTL) plus Firestore persistent cache
  - `neighbors(word)` (top-K list) in Firestore to avoid recomputation

Provider options (we’ll implement as interchangeable backends):

- `OpenAI` (if you provide an API key)
- `Vertex AI` (if we enable GCP project + service account)
- Local model (Cloud Run container) if cost/latency requires