# tir — blueprint

> Full product + technical spec for `tir`. Source of design intent;
> implementation status lives in [`AGENTS.md`](./AGENTS.md), routes/code
> ownership in [`docs/DEVELOPER_GUIDE.md`](./docs/DEVELOPER_GUIDE.md), visual
> language in [`docs/DESIGN.md`](./docs/DESIGN.md), live brainstorm in
> [`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md).

---

## 1. One-line pitch

> race from a word to a word, one of four steps at a time. first to land
> wins. you've got three seconds.

(working pitch — refine before App Store listing.)

---

## 2. Vibe + design intent

- **fast twitch.** target session 2–5 minutes; round target ~15 seconds.
- **minimal but exciting.** dark canvas, two-thumb HUD, the chosen word
  is the visual hero of every reveal.
- **distance hidden, target visible.** curiosity engine: the four
  options are the only signal.
- **no pay-to-win.** rerolls are earned. cosmetics may exist; never
  power.
- **competitive without anxious.** rounds advance whether or not you're
  watching; mistakes are cheap; the next round is always 3 seconds away.

Voice rules and palette decisions live in
[`docs/DESIGN.md`](./docs/DESIGN.md).

---

## 3. Core loop (single round)

1. Server publishes a **target word** to the room (`rounds/current`).
2. Each player has a **current word** and **4 option words**.
3. Player taps an option → server runs the word engine → player gets a
   new current word and 4 new options.
4. When a player's pick equals the target, server transitions the round
   to **`finish_window`**, sets `phaseEndsAt = now + 3s`, records the
   player as `primaryWinnerUid`, and broadcasts to all subscribers.
5. During the 3-second window, any other player whose pick equals the
   target is added to `windowFinishers`.
6. After the window expires, **any client** can call
   `finalizeFinishWindow` (idempotent — CAS on `phaseEndsAt`). The
   server picks a new target, regenerates options for everyone (each
   from their *current* word), resets `usedOptionWords`, increments
   `roundSeq`, and applies rewards.

There is no per-pick timer. Pacing comes from the round itself.

---

## 4. Multiplayer topology

- **Default mode = global.** `meta/globalRooms.roomIds[]` holds one
  room per shard; `assignGlobalRoom` hashes the user's UID into a
  shard and lazily creates the shard room. Shard count is `3` today
  (constant `SHARD_COUNT` in `functions/src/globalRooms.ts`); it must
  scale with active player count and likely needs **rotation** later
  so a single shard room doesn't accumulate forever.
- **Private rooms.** `createPrivateRoom` returns a `roomId` the
  creator shares as a join code. Invite friends, same lifecycle.
- **No matchmaking by skill in v1.** Mixing happens organically via
  shard hashing; Elo exists for league display, not matchmaking yet.
- **No spectators in v1.**

### Mid-round join (the seeding rule)

When a player joins mid-round, server seeds them **behind the median
distance** of currently active players from the target, with a small
randomized backoff (median + 1–2 rank steps). Goal is the *chase
experience* — feels reachable, not pre-cooked. See
`pickJoinCurrentWord` in [`functions/src/callables.ts`](./functions/src/callables.ts).

---

## 5. Word engine (semantic similarity)

> **Core principle:** tir is a **semantic matching game**. Words are
> connected by **meaning**, not by spelling or letter patterns.
> "cat" → "dog", "kitten", "mouse" — never "car" or "cap".

The engine produces, for any `(currentWord, targetWord)` pair, a tuple
of **four distinct options** none of which equals `currentWord` and
none of which appear in `excludeWords` (the player's
`usedOptionWords` for the round).

### Selection rule

1. Read top-50 precomputed **semantic** neighbors from Firestore
   (`precomputed/neighbors/words/{word}`).
2. Select: **1 closest** + **1 medium-range** + **1 path-toward-target**
   + **1 MMR diversifier** (alpha ~0.6).
3. **Minimum-moves guard**: target excluded until ≥ 2 moves in the round.
4. Shuffle and return 4 options.
5. Fallback to stub (28-word graph) if word is missing from precomputed data.

### Engine: GloVe precomputed neighbors

| Item | Value |
|---|---|
| **Model** | GloVe 300d (`glove.6B.300d`) — trained on word co-occurrence in Wikipedia + Gigaword |
| **Why GloVe** | Captures genuine semantic similarity (meaning, not spelling). Unlike sentence transformers (e.g., all-MiniLM-L6-v2) which use subword tokenization and produce character-level noise for single words. |
| **Vocab** | ~900 curated, common English words — lexically simple, semantically rich |
| **Lexical filter** | Active filter strips neighbors with shared prefix/suffix > 60% |
| **Storage** | `precomputed/neighbors/words/{word}` — `neighbors[]` + `scores[]` (cosine 0–1) |
| **Pipeline** | `pipeline/build_neighbors.py` (Python, GloVe 300d → cosine → filter → Firestore upload) |
| **Latency** | ~30ms per move (one Firestore read) |
| **Cost** | ~$0 (one-time compute, Firestore reads ≈ $0.06 / 100k) |
| **Failure modes** | None after import |

### Fallback: Stub

28-word hand-curated graph in `functions/src/stub.ts`. Same MMR interface,
just a smaller graph. Used only when precomputed data is missing.

### Vocab policy (v1)

- **English only at launch.** Hindi planned for a later season — needs
  its own GloVe or fastText embeddings for semantic neighbors.
- **Single tokens, ASCII letters only.** Enforced by
  `assertAllowedWord` ([`functions/src/contentPolicy.ts`](./functions/src/contentPolicy.ts)).
- **No plurals or verb tenses.** Enforce via a curated lemma allow-list
  during the precompute step (the runtime gate in `contentPolicy.ts` is
  intentionally permissive; the offline pipeline is where morphology
  is filtered).
- **Proper nouns: allowed but capped.** Allow up to ~15% of any
  candidate pool to be proper nouns; this is what gives variety
  without flooding the game with names.
- **Profanity: hard-blocked.** Small in-code list today; replace with
  a curated blocklist file in the precompute pipeline.

### Anti-solve / variety knobs

- `excludeWords` per round prevents tight cycles (you cannot revisit a
  word you already used this round).
- The MMR diversifier (slot #4) keeps players from being boxed into one
  semantic domain — there's always one option that pulls sideways.
- Per-player options (everyone gets their own pool from their own
  `currentWord`) means there's no shared "optimal path" across the
  shard.
- Future: a small **personalization signal** (1 of 4 options gently
  biased to a long-term user-level affinity) for subtext without
  unfairness. Tracked in [`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md).

---

## 6. Rewards + progression

### Per round (issued in `applyRoundRewards`)

| Outcome | ratingElo | counters |
|---|---|---|
| **primary winner** (first to target) | +25 | `roundsWon +1`, `winStreak +1`, `roundsPlayed +1` |
| **photo-finisher** (target during 3s window) | +10 | `roundsPhotoFinish +1`, `roundsPlayed +1` |
| participant (no target reached) | 0 | `roundsPlayed +1` |

`lastPlayedDay` is stamped for everyone in the room.

### Leagues

| League | Elo |
|---|---|
| Bronze | < 1200 |
| Silver | 1200 – 1399 |
| Gold | 1400 – 1599 |
| Platinum | 1600 – 1799 |
| Diamond | ≥ 1800 |

Starting Elo is 1200 (default-on-read; users doc is created lazily on
first reward).

### Streaks (planned)

- **`winStreak`** is incremented today but **never reset on a loss**.
  Fix: reset to 0 when `applyRoundRewards` runs and the user is *in*
  `allPlayerUids` but *not* the winner or a photo-finisher. See
  [`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md).
- **`dailyStreak`** not yet implemented. Compare `lastPlayedDay` to
  yesterday's `dayKey` in IST or UTC (decide one) when issuing
  rewards; bump if consecutive, reset if there's a gap.

### Reward-formula future inputs (per `QUESTIONS.md` §9)

Beyond placement, the long-term formula will weight:

- **final distance** for non-winners (closer at round end → smaller
  consolation Elo / participation bonus)
- **speed** (moves taken / time to target) for the winner
- **rolling avg active players in shard** (more players → larger
  rewards, scaled — the `population size` knob)
- **upset factor** (beating higher-Elo players)
- **comeback factor** (started behind median, finished top-3)
- **streak multiplier** (win-streak + daily-streak)

None of these are wired today. Track in
[`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md).

### Rerolls (planned)

- Replaces **all 4 options** for the player (not just one slot).
- Earned, not bought. Source TBD: streak milestones, daily challenges,
  one free per round, etc.
- Server contract: new callable `reroll(roomId)` that calls the engine
  for fresh options without consuming a move. Add a player-doc field
  `rerollsAvailable: number`.

---

## 7. Anti-cheat posture (v1)

- **Server-authoritative.** Clients are read-only on every gameplay
  collection (`rooms`, `rounds`, `players`, `users`, `meta`). All
  writes go through the Cloud Functions Admin SDK. See
  [`firestore.rules`](./firestore.rules).
- **Validate every move.** `submitMove` checks the picked word is in
  the player's current options (post-content-policy), runs a Firestore
  transaction with CAS on options + phase, and rejects stale state.
- **Semantic distance hidden** server-side too — clients are not given any
  numeric similarity score. The only signal is the option set (meaning-based).
- **Basic anti-bot.** v1: rate-limit per UID per 5s window
  (not yet implemented — track in APPS_AND_FEATURES). Reject submits
  with implausible cadence (more than ~5 picks/sec).
- **Idempotent finalize.** `finalizeFinishWindow` uses CAS on
  `phaseEndsAt`. **Reward issuance is not yet fully idempotent** —
  two concurrent finalize calls could double-credit. Add a
  `finalizeLocks/{roomId}_{roundSeq}` doc as a one-shot lock, or
  deduplicate by `roundSeq` inside `applyRoundRewards`.

---

## 8. Data model (Firestore)

| Collection | Doc id | Purpose |
|---|---|---|
| `rooms/{roomId}` | autogen | room metadata: `mode`, `status`, `memberIds[]`, `shardIndex?` |
| `rooms/{roomId}/rounds/current` | always `current` | live round: `targetWord`, `phase`, `phaseEndsAt`, `roundSeq`, `primaryWinnerUid`, `windowFinishers[]` |
| `rooms/{roomId}/players/{uid}` | uid | per-player state: `currentWord`, `options[4]`, `usedOptionWords[]`, `movesThisRound`, timestamps |
| `rooms/{roomId}/events/{eventId}` | autogen | **planned**: append-only event feed (`playerReachedTarget`, `finishWindowStarted`, `newTarget`); rules already allow it. |
| `users/{uid}` | uid | `ratingElo`, `roundsWon`, `roundsPlayed`, `roundsPhotoFinish`, `winStreak`, `lastPlayedDay`, `updatedAt` |
| `meta/globalRooms` | always `globalRooms` | `roomIds[]`, `shardCount` |
| `precomputed/neighbors/words/{word}` | word | GloVe semantic neighbors (top-50) + cosine scores |
| `analytics/{YYYY-MM-DD}` | day | `roundCompletions` counter |
| `rewardLocks/{key}` / `finalizeLocks/{key}` | key | **planned**: one-shot locks for idempotent reward + finalize |
| `_debug/ping` | `ping` | dev-only round-trip check |

Field types and indexes live in
[`docs/DEVELOPER_GUIDE.md` § Firestore](./docs/DEVELOPER_GUIDE.md).

---

## 9. Cost model (back-of-envelope)

Assumptions: 10k DAU, 30 moves per session, 1 session per day.

- **Firestore reads**: ~30 reads × 10k = 300k reads/day. Free tier is
  50k/day; billable ~250k → ~$0.08/day → **~$2.40/month**.
- **Firestore writes**: ~30 writes (player doc) + 1 (round patch) +
  rewards (1 per player per round end) ≈ 60 writes per session × 10k
  = 600k writes/day. Free tier is 20k; billable 580k → ~$1.04/day →
  **~$31/month**.
- **Cloud Functions invocations**: ~30 callables per session × 10k =
  300k/day. Free tier is 2M/mo; we're at 9M/mo → ~$2.80/mo over the
  free tier (after first 2M, $0.40 / 1M).
- **Outbound** (OpenAI fallback path, *not* the default in Phase 1):
  $0 because we don't call it.
- **Embeddings storage** (Phase 1 precompute): 10k words × 384-dim
  float32 ≈ 15 MB JSON; one-shot upload to Firestore ≈ 10k writes
  ($0.02). Topk neighbor docs: 10k × ~50 strings ≈ 5 MB. Negligible
  storage cost.

Order of magnitude: **~$40/month** of infra at 10k DAU on the
precomputed-engine path. Doubles roughly with DAU. Compare with the
runtime-OpenAI path which would add ~$30–100/month at the same scale
*plus* introduce a hard external dependency.

---

## 10. Phased roadmap

### Phase 0 — what's shipped today (commit `bfe5158`)

Single-screen `App.tsx`, anonymous auth, create / join / global,
3-second finish window, target rotation, Elo + leagues, 28-word stub
engine. iOS device path validated by author. See
[`AGENTS.md` § 14](./AGENTS.md) for known gaps.

### Phase 1 — playable MVP under `aaam.dev`

Goal: an iOS+Android playable beta, branded as an aaam.dev product,
on the precomputed engine.

- [ ] **aaam.dev rebrand.** New bundle id (`com.aaam.tir` or
      `dev.aaam.tir`), slug, App Store Connect record under team
      `D92AD98B9B`. New `googleServicesFile`s if Firebase project is
      renamed; otherwise reuse `tirapp-c596f` and just rename the
      iOS/Android app records inside it.
- [ ] **Visual identity pass.** Apply the design language defined in
      [`docs/DESIGN.md`](./docs/DESIGN.md) to the existing single
      screen. Adopt Reanimated 4 motion tokens.
- [ ] **Multi-screen IA.** Onboarding → Home → Game → Profile/Rank
      → Results. Use Expo Router (file-based) for parity with the
      studio's house style; `App.tsx` becomes one route.
- [ ] **Precomputed offline neighbors.** Build
      `functions/scripts/build-neighbors.ts`. Curate ~5k common
      English nouns. Compute top-50 neighbors with
      `@xenova/transformers` `all-MiniLM-L6-v2`. Write
      `cache/wordNeighbors/words/{word}` once. Add a
      `precomputedNeighborMove` provider behind the same engine
      interface.
- [ ] **Idempotent finalize + reward locks.** Drop a
      `finalizeLocks/{roomId}_{roundSeq}` doc inside the txn so
      double-fires of `finalizeFinishWindow` don't re-grant Elo.

### Phase 2 — depth + retention

- [ ] **Rerolls.** Earned via streak / daily, replaces all 4 options.
- [ ] **Win-streak reset on loss + daily-streak.** Required for the
      streak multiplier in the reward formula.
- [ ] **Event feed.** Write `rooms/{id}/events/*` for
      `playerReachedTarget`, `finishWindowStarted`, `newTarget`.
      Powers a small "killfeed" strip in the HUD.
- [ ] **Anti-bot rate limit.** 5 picks/sec ceiling per UID + an
      `abuseSignals/{uid}` doc for soft shadow-bans.
- [ ] **Global shard rotation.** Periodically retire and replace the
      shard rooms (e.g. roll a new shard each 24h or when memberIds
      grows beyond N).
- [ ] **Daily seed target.** A "target of the day" arc on top of
      whatever else is happening, for return-engagement.

### Phase 3 — social + cosmetics

- [ ] **Friends, parties, private invites with display names**
      (right now we display `uid.slice(0,6)`).
- [ ] **Emoji-only chat.** Per-room ephemeral reactions. Per
      `QUESTIONS.md` §11: emoji only, no text.
- [ ] **Cosmetics.** Tasteful avatar / name / theme tints.
      **Strictly no power.**
- [ ] **Hindi rollout.** Multilingual embedding pipeline; per-room
      language flag.

### Phase 4 — launch

- [ ] EAS production builds, App Store + Play Store listings on
      `aaam.dev/tir/` (mirroring `aaam.dev/humm/`).
- [ ] Privacy + support pages on the studio site.
- [ ] Monetization decision: ads vs cosmetics vs both. Default
      stance: tasteful cosmetic shop, never power. (Per
      `QUESTIONS.md` §14: not decided.)

---

## 11. North-star metric + non-goals

- **North star: DAU** (per `QUESTIONS.md` §16).
- **Non-goal: pay-to-win.** Hard-banned at the engine + rules layer.
- **Non-goal: solvable optimal path.** The MMR diversifier + per-player
  pools + (eventually) per-user personalization are the antidotes.
- **Non-goal: social toxicity.** Emoji-only chat is the design choice
  that prevents harassment without a moderation team.

---

## 12. Open questions

1. **Hindi launch timing** — language toggle inside one app or
   `tir-hi` separate slug?
2. **Monetization** — App Store paid vs free + cosmetics vs ads?
   Defer until after Phase 1 telemetry exists.
3. **Anti-bot specifics** — is a server-side cadence check enough or
   do we need App Attest / Play Integrity?
4. **Reward formula tuning** — placement-only Elo for v1, then layer
   in distance/speed/upset/comeback/population multipliers in Phase 2;
   tune from telemetry.
5. **Personalization signal** — what user-level facet (favorite
   semantic domain? recent picks?) feeds slot #4 of options without
   leaking competitive advantage to long-time players?

---

*Last reconciled with code at commit `bfe5158`.*
