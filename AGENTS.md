# tir — agent entry point

This file is the **first thing an agent reads** before touching tir.
It is intentionally exhaustive on the operational details (data
model, callable contracts, debugging) but defers product narrative,
visual identity, and machine setup to dedicated docs.

## Where to look next

| Doc | Use |
|---|---|
| **[`README.md`](./README.md)** | landing — pitch + status + one-paragraph getting-started |
| **[`BLUEPRINT.md`](./BLUEPRINT.md)** | full product + technical spec: loop, multiplayer, word engine, rewards, anti-cheat, data model, cost model, **phased roadmap** |
| **[`SETUP.md`](./SETUP.md)** | machine setup — Node, Xcode, CocoaPods, Firebase CLI, running on a real device, deploying functions |
| **[`docs/DEVELOPER_GUIDE.md`](./docs/DEVELOPER_GUIDE.md)** | architecture: client bootstrap, callable contracts, Firestore ownership, security, indexes, feature checklists |
| **[`docs/DESIGN.md`](./docs/DESIGN.md)** | visual identity — voice, palette, typography, motion tokens, components, accessibility, the gameplay HUD spec |
| **[`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md)** | living brainstorm: current build, next up, idea parking lot |
| **[`QUESTIONS.md`](./QUESTIONS.md)** | original game-design Q&A — the source of every product decision |
| `docs/game-rules-v1.md` | legacy condensed rules sheet (kept for grep) |
| `docs/word-engine.md` | word-engine spec stub (kept for grep) |

---

## 1. What tir is

tir is a mobile word-race game (iOS + Android; React Native bare + Firebase).
Players race from a **current word** to a **target word** by repeatedly
choosing **1 of 4 options related by meaning** (semantic similarity, not
letter/spelling patterns). The first player to hit the target triggers a
**dynamic finish window** for others. Then a new target rotates in.

Core constraints (full reasoning in [`BLUEPRINT.md`](./BLUEPRINT.md)):

- Target is always **visible**; numeric distance is **hidden**.
- No pay-to-win. Rerolls replace all 4 options and are earned via play.
- Default mode: **global** rooms (UID-hashed shards). Also supports **private** friend rooms.
- Joiners spawn **behind the median** distance of active players (randomized band).
- Session target: ~2–5 min, fast-twitch feel.

The visual identity is **distinct from humm** (the studio's first app):
humm is warm, intimate, Wes-Anderson; tir is dark, arcade-fast,
electric. See [`docs/DESIGN.md`](./docs/DESIGN.md) for tokens, voice,
HUD layout, and motion language.

---

## 2. Repo Structure

```
tir/
├── AGENTS.md                    ← this file (agent entry point)
├── README.md                    ← landing
├── BLUEPRINT.md                 ← product + technical spec, roadmap
├── SETUP.md                     ← machine setup
├── QUESTIONS.md                 ← original game-design Q&A
├── .firebaserc                  ← Firebase project: tirapp-c596f
├── firebase.json                ← Firestore rules + Functions config
├── firestore.rules              ← security rules (clients read-only; writes via Admin SDK)
├── firestore.indexes.json       ← (empty — no custom indexes yet)
├── docs/
│   ├── DEVELOPER_GUIDE.md       ← architecture, callables, Firestore ownership
│   ├── DESIGN.md                ← visual language, motion, components
│   ├── APPS_AND_FEATURES.md     ← living brainstorm
│   ├── game-rules-v1.md         ← legacy v1 rules sheet
│   └── word-engine.md           ← word engine spec stub
├── functions/                   ← Cloud Functions (Node 20, TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   ├── .gitignore
│   └── src/
│       ├── index.ts             ← admin.initializeApp() + re-exports callables
│       ├── callables.ts         ← 5 onCall v2 functions (the game API)
│       ├── stub.ts              ← fallback vocab + dynamic target picker (reads precomputed/targets)
│       ├── embeddingNeighbor.ts ← semantic word engine (GloVe neighbors + MMR + difficulty config)
│       ├── difficulty.ts        ← 4 difficulty presets (chill/normal/hard/expert)
│       ├── contentPolicy.ts     ← word validation (ASCII, profanity, single-token)
│       ├── rewards.ts           ← Elo/streak/round reward issuance
│       └── globalRooms.ts       ← global shard assignment (3 shards)
└── TirApp/                      ← React Native bare app (Expo dev-client)
    ├── App.tsx                  ← single-screen app (auth, room, gameplay, UI)
    ├── app.json                 ← Expo config (bundleId com.tirapp)
    ├── package.json             ← deps (expo 54, RN 0.81.5, @react-native-firebase/*)
    ├── tsconfig.json
    ├── index.js                 ← RN entry
    ├── metro.config.js
    ├── babel.config.js
    ├── src/
    │   ├── rooms/
    │   │   └── privateRooms.ts  ← Firestore refs, types, callable wrappers, logPerf
    │   ├── wordEngine/
    │   │   └── stub.ts          ← client-side copy of stub engine (not actively imported)
    │   └── firebase/
    │       └── client.ts        ← thin auth/firestore helpers (not actively imported)
    ├── ios/                     ← native iOS (Xcode, Pods, GoogleService-Info.plist)
    └── android/                 ← native Android (Gradle, google-services.json)
```

---

## 3. Firebase Project & Config

| Item | Value |
|------|-------|
| Firebase project | `tirapp-c596f` (in `.firebaserc`) |
| Functions region | `us-central1` |
| iOS bundle ID | `com.tirapp` |
| Android package | `com.tirapp` |
| iOS plist | `TirApp/ios/GoogleService-Info.plist` (also copied into `TirApp/ios/TirApp/`) |
| Android config | `TirApp/android/app/google-services.json` |

---

## 4. Firestore Data Model

### `rooms/{roomId}`
```
mode: 'private' | 'global'
status: 'active'
difficulty: 'chill' | 'normal' | 'hard' | 'expert'  # default: 'normal'
createdAt: Timestamp
updatedAt: Timestamp
memberIds: string[]      # UIDs of joined players
shardIndex?: number      # global rooms only
```

### `rooms/{roomId}/rounds/current`
```
targetWord: string
phase: 'active' | 'finish_window' | 'results'
phaseEndsAt: Timestamp | null    # server-time deadline for the current phase
roundSeq: number                 # increments each round (only on results→active)
primaryWinnerUid: string | null
windowFinishers: string[]
winnerMoves: number | null       # only set during finish_window/results
winnerSnap: boolean              # only set during finish_window/results
results: {                       # written atomically when entering 'results';
  targetWord, primaryWinnerUid,  # cleared when entering next 'active'.
  windowFinishers, winnerMoves,  # all clients render the popup off this blob.
  winnerSnap, completedSeq,
  deltas: {[uid]: number},       # per-player Elo deltas, pre-computed
                                 # before the CAS so the popup shows
                                 # correct numbers on its first frame.
                                 # The user-stat side-effects (winStreak,
                                 # ratingElo on users/{uid}) are committed
                                 # in parallel after the CAS.
} | null
updatedAt: Timestamp
```

### Round phase machine

```
active
  └─(player reaches target)─► finish_window  (3–4.5s photo-finish window)
       └─(window expires)──► results        (3s server-enforced sync barrier)
            └─(barrier expires)──► active'  (new target, +1 roundSeq, options refreshed)
```

- `active`: normal play; `submitMove` accepts moves.
- `finish_window`: photo-finish race; `submitMove` accepts moves only
  if the player picks the target. **Min 3000ms / max 4500ms** — the min
  is sized to absorb `finalizeFinishWindow`'s round-trip so the popup
  arrives feeling crisp instead of stuck-at-zero.
- `results`: 3-sec sync barrier; **`submitMove` rejects all moves**.
  Every client renders the unskippable results popup driven by the
  `results` blob and a server-time countdown derived from `phaseEndsAt`.
  Per-player Elo deltas are pre-computed BEFORE the CAS that flips
  `phase=results` and embedded into `results.deltas: {[uid]: number}`
  in the same write — so the popup reads correct numbers from the
  round doc on its very first frame. The legacy
  `players/{uid}.lastRoundDelta` value is also written (by
  `commitRoundDeltas`, in parallel after the CAS) and is tagged with
  `lastRoundDeltaSeq: roundSeq` so the client can use it as a
  freshness-validated fallback when `results.deltas[uid]` is missing
  (e.g. user pruned from `memberIds`). Never trust the player-doc
  delta unless `lastRoundDeltaSeq === results.completedSeq`.
  - **Pre-compute pattern.** During the results barrier the server
    pre-computes the next round (target + per-player options) and
    stores it on the round doc as `nextRoundPrecomputed`. This way
    `advanceRound` becomes a fast CAS-only write — no embedding reads
    on the critical path between `results.phaseEndsAt` and the new
    target appearing on every screen.
- The `results→active` flip is the canonical "next round started"
  event for all UI (target reveal animation, success haptic,
  "NEW ROUND N" tag). Drive UI off this transition, not off
  `roundSeq` alone.

### Latency budget for transitions (target: ≤ 350ms perceived lag at each `0`)

Worst case round-end on a real phone:
| stage | target |
|---|---|
| photo-finish countdown hits 0 → `setTimeout` fires | 0 |
| `finalizeFinishWindow` round-trip (CAS + rewards + precompute kicked off) | 250–500ms |
| Firestore snapshot fans out to listeners | 100–200ms |
| → **popup appears** | **≤ 700ms after 0** |
| popup countdown 3→0 | 3000ms |
| `advanceRound` round-trip — **fast path: just a CAS write** because data was precomputed | 150–300ms |
| Firestore snapshot fans out | 100–200ms |
| → **next round appears** | **≤ 500ms after popup hits 0** |

If you observe perceived lag >1s at either transition, check (a) that
`nextRoundPrecomputed.forSeq === round.roundSeq` is being written
during finalize (Firestore console → `rounds/current`), and (b) that
the client `setTimeout`-then-`setInterval` poll is firing at the
deadline rather than waiting on the next snapshot.

### `rooms/{roomId}/players/{playerId}`
```
currentWord: string
options: [string, string, string, string]
usedOptionWords: string[]   # excluded from future options this round
movesThisRound: number
joinedAt: Timestamp
lastSeenAt: Timestamp
lastPickAt: Timestamp
```

### `users/{userId}`
```
ratingElo: number        # starts at 1200 (default on read)
roundsWon: number        # lifetime wins (drives the 🏆 home-screen chip)
roundsPlayed: number
roundsPhotoFinish: number
winStreak: number
dailyStreak: number      # consecutive UTC days played (resets on gap)
firstWinAt: string       # 'YYYY-MM-DD' — set on first win of a UTC day
winsToday: number        # count of wins in the UTC day of `firstWinAt`.
                         # Atomic increment per win when prevFirstWinAt
                         # === today; reset to 1 on the first win of a
                         # new day. CLIENT MUST gate display on
                         # `firstWinAt === todayKey` because the field
                         # is NOT cleared at midnight (only re-seeded
                         # on the next win). Drives the avatar
                         # wins-today glow ramp on the home screen.
lastPlayedDay: string    # 'YYYY-MM-DD'
updatedAt: Timestamp
```

### `meta/globalRooms`
```
roomIds: string[]        # roomId per shard
shardCount: number       # currently 3
updatedAt: Timestamp
```

### `precomputed/neighbors/words/{word}`
```
neighbors: string[]      # top-50 semantic neighbors (by meaning, GloVe cosine)
scores: number[]         # cosine similarity scores (0–1)
```

### `precomputed/targets`
```
words: string[]          # auto-scored target words, sorted by quality score descending
scores: number[]         # composite quality scores (0–1)
count: number            # length of words array
criteria: {              # the filter thresholds used to generate this list
  minLen, minAvgScore, maxAvgScore, minTopScore, minInboundLinks,
  minStrongInbound, strongInboundTopK, strongInboundMinScore
}
updatedAt: Timestamp
```

### `analytics/{YYYY-MM-DD}`
```
roundCompletions: number
updatedAt: Timestamp
```

---

## 5. Cloud Functions API (v2 onCall, region us-central1)

All functions require Firebase Auth (anonymous is fine). Clients call them via `@react-native-firebase/functions`.

### `createPrivateRoom`
- **Input:** `{ difficulty? }` (default: `normal`)
- **Returns:** `{ roomId, code, targetWord, options }` — `roomId` and `code` are
  identical (kept duplicated for client back-compat).
- Creates `rooms/{CODE}` (mode: `private`, status: `active`, difficulty,
  memberIds: [uid]) + `rounds/current` (phase: `active`).
- **Short join code = room doc ID.** Generates a 4-character code from the
  curated alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no `0/O`, no `1/I/L`,
  31 chars → `31^4 = 923,521` codes) and uses it AS the Firestore doc ID.
  Uniqueness is guaranteed by `DocumentReference.create()` (which fails with
  ALREADY_EXISTS on collision); on collision we retry with a fresh code, up
  to 12 attempts. If the alphabet ever saturates (~tens of thousands of
  active rooms), we'll grow to 5 chars rather than retry harder. See
  `reserveRoomCode()` in `functions/src/callables.ts`.
- **Why the curated alphabet:** every char is unambiguous when read off
  another phone's screen (no `0`/`O` confusion). Trades off a slightly
  smaller code-space for zero "I tried to join but it kept saying not
  found" complaints.

### `joinPrivateRoom`
- **Input:** `{ roomId }` — case-insensitive for short codes.
- **Returns:** `{ ok: true }`
- Creates/updates `players/{uid}` with starting word + options. New joiners
  are seeded behind the median distance of existing players. Adds UID to
  `memberIds`.
- **Input normalisation (`normalizeRoomId`):** if the input is ≤ 6 chars
  (i.e. a private-room code) it's trimmed and uppercased before the
  Firestore lookup. Longer inputs (the 20-char auto-IDs assigned to global
  shards by `assignGlobalRoomId`) are passed through unchanged. The client's
  TextInput already strips invalid characters as the user types and
  `joinByCode` re-uppercases as a defence in depth, but the server is the
  source of truth — paste-from-message-app will always work regardless of
  the original casing.

### `submitMove`
- **Input:** `{ roomId, nextWord }`
- **Returns:** `{ ok: true }`
- Validates: word is in current options, passes content policy, phase is valid.
- If target reached during `active` phase: starts 3s finish window (sets `phase: 'finish_window'`, `phaseEndsAt`, `primaryWinnerUid`).
- If target reached during `finish_window`: adds UID to `windowFinishers`.
- Updates player's `currentWord`, `options`, `usedOptionWords`.
- Uses Firestore transaction to guard against stale state.

### `finalizeFinishWindow`
- **Input:** `{ roomId }`
- **Returns:** `{ transitioned: boolean, waiting?, phase?, raced? }`
- Called by client when `finish_window.phaseEndsAt` has passed.
  CAS-guarded on `phaseEndsAt` so only one caller wins.
- Transitions the round from `finish_window` → `results` with a
  3-sec barrier (`phaseEndsAt = now + 3000`), writes the consolidated
  `results: {...}` blob, and applies rewards (Elo deltas) once.
- **Reward pipeline split (compute vs commit).** Per-player Elo deltas
  are computed via `computeRoundDeltas` (pure read-only) **before**
  the CAS, then embedded into the `results.deltas: {[uid]: number}`
  map written *inside* the CAS. The user-doc side effects
  (`ratingElo`, `winStreak`, `roundsWon`, `lastRoundDelta` AND
  `lastRoundDeltaSeq` on player docs, analytics) are committed by
  `commitRoundDeltas` in parallel with `precomputeNextRound` after
  the CAS. This guarantees the popup snapshot lands with correct
  deltas on its very first frame — no "0 → real value" jitter from a
  separate player-snapshot update.
- **Seq-tagged player-doc deltas.** `commitRoundDeltas` tags every
  write with `lastRoundDeltaSeq: roundSeq`. The client's results
  popup uses `players/{uid}.lastRoundDelta` as a fallback ONLY when
  `lastRoundDeltaSeq === results.completedSeq` — otherwise it
  renders `…` and waits for a fresh value. This prevents the
  PREVIOUS round's delta from briefly flashing on the popup when a
  user is in the live roster but missing from `memberIds` at
  finalize time (a race condition triggered by `ghostFinalizer`'s
  member-pruning, mid-round joins, etc.). See KB
  §results-popup-must-render-correct-elo-on-first-frame for the
  full rationale.
- **Private rooms are practice (no Elo, no streaks).** Both
  `finalizeFinishWindow` and `closeFinishWindow` (ghost path) read
  `room.mode` and skip the `computeRoundDeltas` step entirely when
  `mode !== 'global'`. The `results.deltas` map is written empty
  and a `results.ranked: false` flag is set so the client renders a
  "PRACTICE · no elo" affordance in place of the Elo chip.
  `commitRoundDeltas` also re-checks the room mode and short-circuits
  before any user-doc / player-doc write — meaning private rooms
  advance NONE of `ratingElo`, `winStreak`, `dailyStreak`,
  `firstWinAt`, `winsToday`, `roundsPlayed`, `roundsWon`,
  `roundsPhotoFinish`, `lastRoundDelta`, `eloAtRoundEnd`, or the
  analytics counter. The reward lock is still acquired so duplicate
  callers no-op cleanly.
  Source of truth: `commitRoundDeltas` in `functions/src/rewards.ts`.
- After the CAS, runs `commitRoundDeltas` and `precomputeNextRound`
  **in parallel** (`Promise.all`) so both finish well within the
  3-sec results barrier. `precomputeNextRound` writes
  `nextRoundPrecomputed: { forSeq, targetWord, perPlayer, computedAt }`
  onto the round doc — `advanceRound` consumes this on its fast path.
- Does **NOT** change the target or pick new options — that is
  `advanceRound`'s job (which then uses the precomputed data).

### `advanceRound`
- **Input:** `{ roomId }`
- **Returns:** `{ advanced: boolean, waiting?: boolean, phase?: string, newTarget?: string }`
- Called by client when `results.phaseEndsAt` has passed.
  CAS-guarded on `phaseEndsAt` so only one caller wins.
- Transitions the round from `results` → `active`. **Fast path:** if
  `round.nextRoundPrecomputed.forSeq === round.roundSeq`, the
  pre-computed target + per-player options are written directly — no
  embedding reads on the critical path. **Fallback path:** if the
  pre-computation didn't run (raced or failed), computes synchronously
  exactly as before. Resets `usedOptionWords`, increments `roundSeq`,
  clears `results` and `nextRoundPrecomputed`.
- The phase flip is the canonical "next round started" event for
  every connected client (Firestore delivers the same snapshot at
  ~the same wall-clock moment to all listeners).

### `assignGlobalRoom`
- **Input:** (none)
- **Returns:** `{ roomId, shardIndex }`
- Hashes UID into one of 3 shards. Creates shard room if missing. Client then calls `joinPrivateRoom` with the returned roomId.

### `leaveRoom`
- **Input:** `{ roomId }`
- **Returns:** `{ ok: true }`
- Removes the caller from `rooms/{roomId}.memberIds` and deletes their
  `rooms/{roomId}/players/{uid}` doc inside a transaction.
- **Cascade-deletes the entire room when the last private member leaves.**
  If `mode === 'private'` AND `remaining.length === 0` after the leave,
  `deletePrivateRoomCascade(roomRef)` runs OUTSIDE the transaction and
  wipes:
  - every doc under `rooms/{roomId}/players/*`
  - every doc under `rooms/{roomId}/rounds/*` (just `current` in our schema)
  - every `rewardLocks/{roomId}_*` doc (range-queried by doc-ID prefix
    on `__name__`)
  - the `rooms/{roomId}` doc itself
- **Global rooms (`mode === 'global'`) are NEVER deleted.** The leave path
  just unregisters the player; the room continues with whatever round
  state was live, and the next joiner picks up where it left off. Both
  the callable (`leaveRoom`) and the helper (`deletePrivateRoomCascade`)
  re-assert the mode check defensively — a misuse can never wipe a
  global room.
- Client wiring: `app/game/[roomId].tsx` fires this on screen unmount
  (back button, deep-link to home, etc.). The `roomDoc` snapshot listener
  on the same screen also bounces the user home if `snap.exists` flips
  false mid-session (i.e. another client raced us to the cascade), with
  a `seenAlive` guard so first-frame eventual consistency on a
  freshly-created room doesn't cause a spurious bounce.
- Errors are swallowed by the client — the scheduled reaper is the
  safety net.

### `deleteAccount`
- **Input:** `{}` (caller identified by `request.auth.uid`)
- **Returns:** `{ ok: true }`
- **Permissions:** `unauthenticated` HttpsError if no auth context.
- Deletes the caller's entire footprint atomically via the admin SDK
  (which bypasses `firestore.rules`):
  - `users/{uid}`
  - `publicProfiles/{uid}` (also re-deleted by the
    `syncPublicProfile` trigger — idempotent)
  - `rooms/{*}/players/{uid}` for every room found via
    `where('memberIds', 'array-contains', uid)` on `rooms`
  - The Firebase Auth user record (`admin.auth().deleteUser`)
- **Why server-side and not client-side**: `firestore.rules` does not
  allow client deletes on `users/{userId}` and disallows ALL client
  writes on `publicProfiles/{userId}`. A client-side approach (v1)
  hit silent permission-denied errors and crashed the app's open
  listeners; v2 (this) uses admin SDK. See §16 "Account lifecycle"
  for full design rationale.
- **Best-effort cleanup**: if the room sweep query fails or if
  `auth.deleteUser` fails, the function logs and proceeds — the
  worst degraded state is "auth still exists, all docs gone", which
  is recoverable on next launch (the user-doc listener writes fresh
  defaults; NavigationGate routes to `/name`).
- **App Store compliance**: implements Apple App Review Guideline
  5.1.1(v) for guest/anonymous accounts. Required for review.
- Client wiring: `TirApp/lib/account.ts → deleteCurrentAccount()`
  calls this then `auth().signOut()`. Home-screen handler in
  `app/index.tsx` then `router.replace('/')`.

### Room lifecycle (private vs global)

| | private | global |
|---|---|---|
| Created via | `createPrivateRoom` (4-char code reservation) | `assignGlobalRoom` (3 hashed shards) |
| Doc ID | the 4-char code | 20-char Firestore auto-ID |
| Elo / streaks | NEVER move (`results.ranked: false`) | Move on every round (`results.ranked: true`) |
| Member churn | `leaveRoom` → if last, cascade-delete | `leaveRoom` → unregister only, room retained |
| Idle reaper | Yes — deleted after 5 min with no live presence | NEVER reaped |
| Seq across player turnover | n/a (room dies with last player) | Continues — next joiner inherits running `roundSeq` |

**The reaper** (`scheduled.ts §pass 3`) sweeps once per minute and reaps
private rooms where `mode === 'private' AND updatedAt < now - 5min AND
no member has a fresh `lastSeenAt`. Catches abandoned rooms (host
crashed at create time, force-quit, network died mid-session). Worst-case
deletion latency for a fully-abandoned private room: ~6 min
(5 min stale window + ≤1 min reaper interval). Explicit `leaveRoom`
calls cascade immediately. Composite index required:
`(mode ASC, updatedAt ASC)` on `rooms` collection — declared in
`firestore.indexes.json`.

**Why 5 min stale and not 60 s** (which is the staleness threshold for
`activeMemberIds` filtering during `advanceRound` / `closeFinishWindow`):
five minutes gives a brief app backgrounding (lock screen, app
switching, brief network drop) time to recover without nuking the room
out from under the user. The 60 s window is fine for "should we count
this player in the next round?" — that's a soft pruning. Deleting the
whole room is destructive and wants a more conservative threshold.

---

## 6. Word Engine (Semantic Similarity)

> **Core principle:** tir is a **semantic matching game**. Words are connected
> by **meaning**, not by spelling or letter patterns. "cat" leads to "dog",
> "kitten", "mouse" — never to "car" or "cap".

### Production engine: GloVe precomputed neighbors
- **~1,250 curated, common English words** — lexically simple but semantically rich.
- Neighbors precomputed offline using **GloVe** (Global Vectors, trained on
  word co-occurrence in Wikipedia + Gigaword). GloVe captures **meaning-based
  similarity** (e.g., piano→violin, ocean→beach) unlike character-level models.
- Top-50 neighbors per word stored in Firestore at `precomputed/neighbors/words/{word}`.
- A **lexical overlap filter** actively strips neighbors that share character
  patterns (prefix/suffix > 60%) to prevent any letter-based similarity leaking through.
- Server reads neighbors per move, runs **MMR diversifier** (alpha ~0.6) to mix:
  1 closest + 1 medium-range + 1 path-toward-target + 1 diversity pick.
- Pipeline: `pipeline/build_neighbors.py` (Python, GloVe 300d, uploads to Firestore).
- **Why precomputed**: zero per-call cost, ~30ms p50 latency, no external API dependency.

### Difficulty system
4 difficulty modes control how much help the engine gives players:

| Mode | Avg moves (sim) | Breadcrumbs | Bridge word | Target injection |
|------|-----------------|-------------|-------------|------------------|
| `chill` | 3.8 | 25 target neighbors | yes + fallback | aggressive |
| `normal` | 11.9 | 5 target neighbors | yes (depth 12) | moderate |
| `hard` | 30.7 | 3 target neighbors | no | rare |
| `expert` | 32.4 | none | no | none |

Config in `functions/src/difficulty.ts`. Difficulty stored per-room in
Firestore (`rooms/{id}.difficulty`). The default for new private rooms
and ALL global rooms is `normal`.

**Re-calibrating difficulty.** Edit `DIFFICULTY_CONFIGS` in
`functions/src/difficulty.ts`, then re-run the simulator:

```sh
node scripts/sim_difficulty.mjs --games 3000
```

The simulator (`scripts/sim_difficulty.mjs`) is a pure-JS port of
`embeddingNextMove` that runs against the local
`pipeline/out/neighbors.json` snapshot — no Firestore reads. Player
intuition is modeled as BFS hop-count from the target through top-15
neighbors per hop (depth ≤ 4); picks the lowest-hop option with prob
0.7, uniform-random otherwise. Note: the BFS player is significantly
weaker on HARD/EXPERT than a real human (who can chain associations
beyond 4 hops) — treat HARD/EXPERT sim numbers as upper bounds and
expect real-player avgs ~30–50% lower.

**Tuning levers** (each independent — see `difficulty.ts` JSDoc for
deeper detail):

1. `breadcrumbCount` — # of target's neighbors injected into the pool
   with low pseudo-scores. Lower = harder. Single biggest knob for
   ambient difficulty.
2. `pathWordEnabled` + `pathScanDepth` — the dedicated bridge slot.
   Turning off roughly doubles game length; depth controls how
   aggressively the bridge fires.
3. `mediumSlotIdx` — index in the sorted pool for the 2nd option.
   Higher = harder (the obvious-second-best option is further away).
4. `diversifierDepth` — depth of the 4th MMR pick. Higher = harder
   (4th option more random).
5. `targetInject.{rank5..rank50}` — probability of putting the target
   itself in your options when it's already in your current word's
   top-N neighbors. Lower = harder.

### Target word selection (auto-scored)
Target words are **not manually curated**. The pipeline auto-scores every word in the vocab for target suitability and uploads a ranked list to `precomputed/targets`. At runtime, `pickNextTargetWord()` reads from this Firestore doc.

Auto-scoring criteria (in `build_neighbors.py`):
- Word length ≥ 4
- Average neighbor score in [0.19, 0.45] — connected but not over-clustered
- Top neighbor score ≥ 0.25 — at least one strong connection
- Soft inbound links ≥ 5 — appears in someone's top-30 neighbors
- **Strong inbound ≥ 3** — appears in at least 3 other words' top-15 neighbors with cosine score ≥ 0.30. This is the principled reachability gate: a target is only playable if multiple other vocab words can lead to it in a single move with a *strong* semantic connection. Words with a poisoned GloVe embedding (e.g. dominated by surnames or company names like "griffin", "anchor", "delta", "python") fail this check and are excluded as targets even if their raw avg/top scores look acceptable.
- Not a basic verb, adjective, or color
- `FREQUENCY_ALLOWLIST` overrides the strong-inbound gate for genuinely common words whose embedding happens to be sparse (e.g. "donut", "igloo").

A small hardcoded `FALLBACK_TARGETS` list in `stub.ts` exists only for cold-start safety.

### Stub fallback
- 28-word hand-curated vocab in `functions/src/stub.ts`.
- Used only when a word is missing from precomputed data (shouldn't happen in normal play).
- Same MMR selection interface, just a smaller graph.

### How to expand the vocabulary (for agents)

To add more words to the game:

1. **Edit seed words** — add words to the `SEED_WORDS` list in `pipeline/build_neighbors.py`.
   Group by category. Prefer concrete, evocative nouns (4–10 chars, alphabetic, common English).
   The pipeline will automatically filter out words not in GloVe.

2. **Run the pipeline** — from `pipeline/`:
   ```
   python3 build_neighbors.py --upload
   ```
   This will: load GloVe → filter seeds → compute 50 neighbors each → score targets → upload everything to Firestore.
   The GloVe file (`glove.6B.300d.txt`) must be present in `pipeline/`. If missing, download and unzip:
   ```
   curl -L -o glove.6B.zip https://nlp.stanford.edu/data/glove.6B.zip
   unzip glove.6B.zip glove.6B.300d.txt
   ```
   The zip is ~822MB, the txt file is ~1GB. Both are gitignored.

3. **Deploy functions** — from repo root:
   ```
   cd functions && npm run build && firebase deploy --only functions
   ```
   No code changes needed in functions — they read targets dynamically from Firestore.

4. **Verify** — check the pipeline output:
   - `pipeline/out/vocab.json` — the final filtered vocab (should grow)
   - `pipeline/out/targets.json` — scored target list (auto-generated)
   - `pipeline/out/neighbors.json` — full neighbor graph
   - Firestore `precomputed/targets.count` — should match targets.json length

**Do NOT manually edit `TARGET_POOL` or target lists in `stub.ts`** — the pipeline handles this automatically. The only manual step is adding seed words.

**Quality checks after expanding:**
- Confirm `vocab.json` grew (no regression)
- Check `targets.json` top/bottom 10 for sensibility
- Run a few game rounds to verify reachability

---

## 7. Client Architecture (TirApp/App.tsx)

Single `AppContent` component in one screen:
- **Auth:** Anonymous sign-in via `@react-native-firebase/auth`.
- **Firestore listeners:** subscribes to room doc (mode), round doc (target/phase/countdown), player doc (currentWord/options), players collection (roster), user doc (Elo).
- **Game actions:** Create private room, Enter global shard, Join by room code, Choose option word.
- **Finish window:** countdown timer; when expired, client calls `finalizeFinishWindow` (transitions to `results`).
- **Results barrier:** unskippable popup driven by `phase==='results'`; option grid is hidden; server-time countdown numeral; client calls `advanceRound` when countdown hits 0.
- **NEW ROUND reveal:** on `results→active` phase flip, target hero plays a stronger container-transform-style reveal (collapse 0.82 → surge 1.04 → settle 1.0) with a single `notificationSuccess` haptic, and a "NEW ROUND N" tag fades in/out above the card for ~1.4s.
- **Finish banner:** yellow text "FINISH WINDOW — N" during the 2–5s window.
- **Callable wrappers:** in `TirApp/src/rooms/privateRooms.ts` (thin functions around `fns.httpsCallable(...)`).
- **Latency logging:** `logPerf(label, startTimestamp)` logs `[perf] label Nms` to console.

---

## 8. Firestore Security Rules

- **Clients can READ** rooms, rounds, players, users(self), meta, and `_debug`.
- **All writes are DENIED** to clients; writes happen exclusively through Cloud Functions (Admin SDK).
- `cache/`, `analytics/`, `rewardLocks/`, `finalizeLocks/` are fully denied to clients.

---

## 9. Installation & Setup

Full machine setup (Node / Xcode / CocoaPods / Ruby / Firebase CLI / iOS device path / EAS later) lives in [`SETUP.md`](./SETUP.md). Quick reminders:

- tir uses `@react-native-firebase/*` (native modules), so it **cannot** run in Expo Go. Always `npx expo run:ios --device` or `npx expo run:android`.
- Firebase project id is `tirapp-c596f` (from `.firebaserc`).
- Functions deploy: `cd functions && npm install && npm run build && firebase deploy --only functions,firestore:rules` (run from repo root).
- Word engine uses precomputed GloVe semantic neighbors (no API keys needed). Stub fallback is automatic for missing words.

---

## 10. Testing

### TypeScript checks
```bash
cd TirApp && npx tsc --noEmit    # mobile app
cd functions && npm run build     # functions (tsc)
```

### Unit tests
```bash
cd TirApp && npm test             # Jest (requires @react-native/jest-preset)
```
Note: the jest preset may need manual install depending on RN version.

### Manual testing flow
1. Build and run on device/simulator.
2. App auto-signs in anonymously.
3. Tap **Create private room** — creates room + round + joins.
4. Tap word options to move toward target.
5. When target is reached: finish window countdown appears, then round advances.
6. Share room code with another device to test multiplayer.
7. **Enter global shard** assigns a shared global room.

### Firebase emulator (local)
```bash
cd functions
npm run serve    # builds + starts emulator for functions + firestore
```
When using emulator, point the RN app to localhost by adding to `App.tsx` init:
```typescript
import functions from '@react-native-firebase/functions';
functions().useEmulator('localhost', 5001);
import firestore from '@react-native-firebase/firestore';
firestore().useEmulator('localhost', 8080);
```

---

## 11. Debugging

### Common issues

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `permission-denied` on Firestore write | Old rules deployed (pre-serverside migration) | `firebase deploy --only firestore:rules` |
| `permission-denied` on callable | Auth not ready; user null | Wait for `onAuthStateChanged` before calling |
| "Join room first" from `submitMove` | Player doc doesn't exist | Call `joinPrivateRoom` before `submitMove` |
| "Options changed; retry" | Concurrent move race | Retry (optimistic concurrency) |
| Functions timeout | Cold start | Precomputed neighbors are fast (~30ms); check Firestore connectivity |
| iOS build fails | Pods out of date | `cd ios && pod install --repo-update` |
| `FirebaseApp.configure()` crash | Missing GoogleService-Info.plist | Ensure plist is in `ios/TirApp/` AND `ios/` |

### Useful logs
- Client: `[perf] submitMove Nms`, `[auth] onAuthStateChanged`, `[firestore] startup ping ok`
- Functions: standard Cloud Functions logs in Firebase Console or `firebase functions:log`

---

## 12. Rewards & Rating System

- **Ranked vs practice scope.** ALL of the rewards below apply ONLY to
  rounds played in `mode: 'global'` rooms. Private rooms (created via
  `createPrivateRoom`, joined via the 4-char code) are explicitly the
  practice / friends sandbox: no Elo, no streaks, no `firstWinAt`,
  no `winsToday`, no `roundsPlayed` / `roundsWon` / `roundsPhotoFinish`
  increments, no analytics counter. The popup renders "PRACTICE · no
  elo" in place of the Elo chip. Gating happens in `commitRoundDeltas`
  (which
  short-circuits on non-global mode) and in `finalizeFinishWindow` /
  `closeFinishWindow` (which skip `computeRoundDeltas` and write
  `results.ranked: false` so the client knows). This is the
  intentional product split — competitive ladder lives only in the
  shared global pool; private rooms are for warmup and friend lobbies.
- **Scoring model — V3 (2026-05-10): pure pairwise Elo.** Replaces V2
  (which had constraint-driven floors / caps / damping / grace / dynamic
  K). V3 keeps the rating math mathematically clean: pairwise Elo and
  nothing else. Engagement / loss-protection / onboarding concerns are
  handled by **orthogonal systems** (placement-period UX, daily quests,
  streak celebrations, weekly snapshot leaderboards, tier-promotion
  ceremonies, match history) — never by corrupting the Elo math.
  Source of truth: `functions/src/rewards.ts`.
- **The math, in full:**
  - For each player `P` in a round of `N` players (where `N >= 1`):
    `delta_P = round(K × Σ over opponents O of (actual_PO − expected_PO))`
  - `actual_PO = 1.0 / 0.5 / 0.0` if P beat / tied / lost to O.
  - `expected_PO = 1 / (1 + 10^((elo_O − elo_P) / 400))`.
  - That is the entire scoring model. No floors, no caps, no damping,
    no grace, no K-tiers.
- **Solo rounds (N=1) — diminishing-returns with +1 floor (2026-05-10):**
  Pairwise math has no opponent in solo, so the player would otherwise
  earn zero (and `roundsPlayed`, `winsToday`, `dailyStreak`,
  `winStreak`, placement progress would all silently fail to tick —
  visible at off-peak hours and on launch day). Fix: award a positive
  Elo signal but on a per-day diminishing curve so solo can't be
  farmed into a viable ladder-climb path:
  - Solo win N today → `delta = max(1, round(8 × 0.5^(N-1)))`
  - N=1: +8, N=2: +4, N=3: +2, N=4: +1, N≥5: +1 (floor)
  - All values integer by design.
  - First 4 solo wins/day yield +15 Elo cumulative; subsequent wins
    add a flat +1 each. At 60 rounds/hour that's ~+60 Elo/hour
    post-saturation — a pure-solo grinder takes ≥18 wall-hours to
    climb Stone→Master, and matchmaking against real opponents would
    deflate them fast on any actual multiplayer engagement.
  - The +1 floor is an explicit product choice: "showing up always
    gets at least +1" semantic is more important than perfect
    zero-sum integrity. Bounded acceptable inflation. Riot
    Co-op-vs-AI XP diminishing-returns canon, with a never-zero floor.
  - Symmetric across the ladder: Stone +8 first solo, Master +8
    first solo — nobody is penalised or favoured for being high/low
    rated when alone.
  - By construction the solo player is always the primary winner
    (the round only finalizes when target is reached; no loss path
    exists in solo). The branch is win-only; defensive
    `myRank === 0` guard in code.
  - Storage: `users.{soloWinsToday, firstSoloWinAt}` mirror the
    `winsToday / firstWinAt` pattern. Same stale-day detection
    (counter reset to 1 on first solo win of a new UTC day, atomic
    increment otherwise). Multiplayer wins do NOT touch
    `soloWinsToday` — the next solo win after a multiplayer session
    continues from where the day's solo counter left off.
  - Source: solo branch in `computeRoundDeltas` (`opponentCount === 0
    && myRank === 0`); commit-side counter in `commitRoundDeltas`
    (gated on `row.wasSolo`).
- **K = 16, single value, applies to every player.**
- **Rank tiers per round (drives `actual` in the pairwise sum):**
  `0 = primary winner` (strict first finisher), `1 = photo-finisher`
  (finished inside the 3s finish window), `2 = loser`. Two players at
  the same rank tie (`actual = 0.5` for that pair).
- **Default starting Elo:** `1000` (top of Stone). Server writes 1000
  via `DEFAULT_NEW_PLAYER_ELO` constant; every client default reads
  `?? 1000`. Single source of truth.
- **Sanity floor only:** `ELO_FLOOR = 100` (rating never drops below
  100, matching FIDE's "no negative absolute rating" convention).
- **Intentional consequences (not bugs):**
  - A heavy favorite who wins gains very little (Master beating
    Stone-tier table: +0 to +1). The win was expected.
  - A heavy underdog who wins gains a lot (Stone beating Master-tier
    table: ~+45 on a 4p table).
  - A heavy favorite who loses loses a lot (Master losing to Stone-tier
    table: ~−45). Elo is brutal here; the system is not designed to
    soften it.
  - The system is approximately zero-sum per round (Σ deltas ≈ 0).
    Total population Elo stays roughly constant over time.
  - First-round-of-session players get no special treatment in the
    math. Onboarding pain is addressed via UX (placement-period that
    hides numerical Elo for the first N rounds, NOT a math change).
- **Placement period (T1.1, 2026-05-10).** Riot LP placement-match
  canon. The Elo math runs from round 1 (so the player's hidden
  rating moves immediately and matchmaking is not poisoned), but the
  **surface** numeric Elo and tier are hidden for a player's first
  `PLACEMENT_TOTAL_ROUNDS = 5` ranked rounds. Source of truth for
  the constant: `TirApp/src/rooms/privateRooms.ts`. The placement
  state is checked via `isInPlacement(profile.roundsPlayed)` on the
  client, and via the per-round `roundsAfter[uid]` map embedded in
  `round.results` by the server (so the popup's first frame doesn't
  flicker between "delta = +12" and "calibrating 1/5" while waiting
  on the user-doc listener).
  - Server (`functions/src/rewards.ts`): `RoundDeltasResult` now
    carries `roundsAfterMap: Record<uid, number>` populated as
    `prevRoundsPlayed + 1` for every player in the round. Both
    `finalizeFinishWindow` and `closeFinishWindow` write that map
    into `round.results.roundsAfter` so it ships in the same
    snapshot the client uses to render the popup.
  - Client surfaces hiding numerical Elo during placement:
    - **Results popup** (`game/[roomId].tsx`): focal numeral becomes
      `N/5` over the small-caps label `calibrating` instead of
      `+12 / elo`. Practice-room PRACTICE branch still wins the
      priority order — a placement-stage player in a private room
      sees `— / practice · no elo`, because the private room never
      moved their Elo anyway.
    - **Game stats bar**: ambient bottom bar shows `N/5 calibrating`
      in place of `1023 🥉 bronze`.
    - **Home identity card**: title-prefix tier glyph next to the
      name is suppressed; the right-hand stats grid collapses from
      `RANK / ELO` to a single `CALIBRATING N/5` block.
  - Removes the day-1 sting of an early loss (the most common churn
    moment in competitive ladders) without softening the underlying
    Elo math. After 5 rounds the placement state evaporates and the
    player sees their actual Elo + tier the next time the home or
    popup renders. (No reveal ceremony — that was T1.3 and is
    deferred.)
- **Bonuses removed (kept removed).** Speed / snap / streak / underdog
  bonuses do not affect Elo. They survive as cosmetic UI signals
  (winStreak chip, "📸 snap" badge in the results popup) only. Same
  shape as V2 in this respect.
- **Per-round bookkeeping (unchanged):**
  - winner → `roundsWon += 1`, `winStreak += 1`, daily streak
    progressed, `winsToday` incremented (resets on a new day).
  - photo-finisher → `roundsPhotoFinish += 1`, `winStreak = 0`.
  - loser → `winStreak = 0`.
  - all → `roundsPlayed += 1`, `lastRoundDelta = delta`,
    `lastPlayedDay = today`; player doc gets `lastRoundDelta`,
    `lastRoundDeltaSeq`, `eloAtRoundEnd`.
- **League tiers (8-tier ladder, 2026-05-09):**
  - 🪨 stone (<900) — floor; only reached from sustained losing streak
  - 🥉 bronze (900–1099) — DEFAULT (new users start at Elo 1000, mid-Bronze)
  - 🥈 silver (1100–1299)
  - 🥇 gold (1300–1499)
  - 💠 platinum (1500–1699)
  - 💎 diamond (1700–1899)
  - 👑 master (1900–2099)
  - ♛ grandmaster (2100+) — chess-coded glyph, ~top 1%
  - Source of truth: `LEAGUES` in `TirApp/src/rooms/privateRooms.ts`. Server
    `triggers.ts → leagueFromElo()` must stay in sync (writes lowercase tier
    name into `publicProfiles.league` for filtering/debug; client renders
    the icon by re-deriving the tier from `ratingElo`, so legacy capitalised
    strings on existing docs render the new ladder immediately without a
    backfill).
- Daily analytics: `analytics/{YYYY-MM-DD}.roundCompletions` incremented per finalized round.

---

## 13. Global Room Sharding

- 3 shards (constant `SHARD_COUNT` in `globalRooms.ts`).
- UID hashed to a shard index. Shard room created on first use.
- Shard metadata stored in `meta/globalRooms.roomIds[]`.
- Same round lifecycle as private rooms (shared target, per-player options).

---

## 14. Known Gaps / Next Steps

1. ~~**Idempotent finalize:** concurrent `finalizeFinishWindow` calls could double-issue rewards.~~ Resolved 2026-05-09: rewards are gated by `rewardLocks/{roomId}_{roundSeq}` (`applyRoundRewards`) and `finalizeFinishWindow`/`advanceRound` are CAS-guarded on `phaseEndsAt`. Rewards are applied exactly once on the `finish_window→results` transition.
2. **Rerolls:** designed in spec but not implemented. Should replace all 4 options, earned via streaks/quests.
3. **Event feed:** `rooms/{roomId}/events/` collection exists in rules but nothing writes to it yet. Intended for `playerReachedTarget`, `finishWindowStarted`, `newTarget` events.
4. **Proper noun policy:** content policy currently only blocks profanity; proper noun filtering is stubbed.
5. **Vocab expansion:** current vocab is ~1,250 words with 1,082 auto-scored targets. To expand further, add seed words to `pipeline/build_neighbors.py` and re-run `python3 build_neighbors.py --upload`. See §6 "How to expand the vocabulary" for the full workflow.
7. **Multiple screens:** current UI is a single screen. Needs: Onboarding, Home, Profile/Rank, Results/Feed.
8. **Win streak reset:** `winStreak` increments on wins but never resets on losses.
9. **Daily streak:** spec mentions daily streaks but not implemented.
10. **Room rotation for globals:** shard rooms are never rotated/replaced; might need periodic recycling.
11. **Android:** builds should work but has only been tested on iOS physical device.
12. **Tests:** no unit tests for functions; TirApp Jest test is a minimal render smoke test.
13. **Account-link / portability:** anonymous users currently can't recover their account across devices or reinstalls. Full spec for adding Sign in with Apple + Google via `linkWithCredential` (preserving the existing uid → no data migration): [`docs/account-link-spec.md`](./docs/account-link-spec.md). Specced 2026-05-10, awaits implementation. Until then the home footer's "reset progress" affordance + the deletion flow in §16 are the only account-lifecycle controls.

---

## 15. Key design docs

The dedicated docs are the source of truth for everything below:

| Doc | What it covers |
|---|---|
| [`README.md`](./README.md) | landing — pitch + status + getting-started |
| [`BLUEPRINT.md`](./BLUEPRINT.md) | product + technical spec, cost model, **phased roadmap** (Phase 0 → Phase 4) |
| [`SETUP.md`](./SETUP.md) | machine setup, toolchain prerequisites, troubleshooting |
| [`docs/DEVELOPER_GUIDE.md`](./docs/DEVELOPER_GUIDE.md) | architecture, callable contracts, Firestore ownership, indexes |
| [`docs/DESIGN.md`](./docs/DESIGN.md) | visual identity — voice, palette, typography, motion tokens, HUD spec |
| [`docs/APPS_AND_FEATURES.md`](./docs/APPS_AND_FEATURES.md) | living brainstorm: current build, next up, idea parking lot |
| [`QUESTIONS.md`](./QUESTIONS.md) | original game-design Q&A (the source of every product decision) |
| [`docs/account-link-spec.md`](./docs/account-link-spec.md) | account portability spec — Sign in with Apple + Google via `linkWithCredential` (specced, not implemented) |
| `docs/game-rules-v1.md` | legacy condensed rules (kept for grep) |
| `docs/word-engine.md` | word-engine spec stub (kept for grep) |

---

## 16. Account lifecycle (sign-out / delete)

- **Auth model.** `tir` is currently anonymous-auth-only:
  `signInAnonymously()` is called by `AuthProvider` (`TirApp/lib/auth.tsx`)
  on every fresh app launch where no user exists. There is no Sign in
  with Apple / Google / email / phone path. Every user is a guest.
- **App Review compliance.** Apple App Store Review Guideline 5.1.1(v)
  explicitly requires guest/anonymous-account apps to provide an in-app
  account-deletion flow:
  > *"My app automatically creates an account for the user. Do I need
  > to include an option to initiate account deletion? Yes."*
  > — https://developer.apple.com/support/offering-account-deletion-in-your-app
  Without a delete affordance, App Review will reject the build.
- **No "Sign Out" button until account-link arrives.** With anonymous
  auth, signing out is destructive in the same way as deletion (the
  user can't sign back in to recover the same uid; `AuthProvider`
  immediately re-anon-signs-in to a brand new uid). Surfacing both
  buttons would confuse users and silently leak orphan Firestore docs.
  Single "reset progress" affordance only. Reintroduce a separate
  Sign Out when Sign in with Apple / Google / email lands.
- **Surface.** Single tap target in a terminal footer below the
  leaderboard on the home screen (`app/index.tsx` §6 "Account
  footer"). Styling: dim color, no chrome, two text rows
  (`reset progress` + `permanently deletes account & all data`).
  Follows the Linear / Things 3 / Apple Sports settings convention:
  destructive controls are findable but never compete visually with
  the primary CTA. Color is `colors.dim`, NOT `colors.danger` — the
  destructive intent is communicated by the confirmation alert, not
  by the affordance itself.
- **Confirmation.** Native iOS Alert (`Alert.alert`) with two
  buttons: `cancel` (style: 'cancel') and `reset` (style:
  'destructive', renders red on iOS per HIG). Body copy contains the
  literal words "permanently delete" so App Review keyword searches
  find the affordance even though the trigger uses friendlier "reset"
  language. NN/g destructive-confirm canon — explicit verb on the
  destructive button, named consequence in the body, Cancel as the
  safe default.
- **Implementation — server callable, NOT client-side delete.**
  `TirApp/lib/account.ts → deleteCurrentAccount()` calls the
  `deleteAccount` Cloud Function (`functions/src/callables.ts`),
  then `auth().signOut()` locally to flip `onAuthStateChanged`
  immediately. The home screen handler then `router.replace('/')`
  to dismiss any non-home screen (game, private-room flow) before
  its listeners can fire on the now-deleted uid.
- **Why server-side.** `firestore.rules` disallows client deletes on
  `users/{userId}` (no `allow delete` clause) and disallows ALL
  client writes to `publicProfiles/{userId}` (`allow write: if
  false`). Both surfaces are server-managed. An earlier client-side
  approach (v1) hit silent permission-denied errors inside
  `Promise.allSettled`, then `auth.delete()` succeeded, leaving
  orphan Firestore docs and crashing the home-screen listeners
  (`useUserProfile`, `useLeaderboard`, `useMyGlobalRank`) on the
  next snapshot. v2 (current) uses the admin SDK to bypass rules.
  Lesson: never rely on `Promise.allSettled` to "soak up" failures
  for mutations that MUST succeed.
- **What `deleteAccount` (server) deletes:**
  - `users/{uid}` — private profile, ratingElo, streaks, etc.
  - `publicProfiles/{uid}` — explicitly here AND again by the
    `syncPublicProfile` trigger on the user-doc delete (idempotent).
  - `rooms/{*}/players/{uid}` — for every room the user was in,
    found via `where('memberIds', 'array-contains', uid)`. Other
    players' rosters drop the deleted player immediately.
  - Firebase Auth user record (`admin.auth().deleteUser`).
- **What `deleteAccount` does NOT delete (intentional):**
  - `memberIds` arrays on rooms still containing the deleted uid —
    heartbeat reaper handles eventual cleanup.
  - Past `rounds/{seq}.results.deltas.{uid}` — event/log data, not
    UGC. chess.com / LoL post-deletion convention.
- **Post-delete flow** (matters for understanding what the user
  sees):
  1. Server callable runs admin-SDK deletes.
  2. Client `auth().signOut()` flips `onAuthStateChanged(null)`.
  3. `router.replace('/')` dismisses any open game/lobby screens.
  4. `AuthProvider`'s second effect calls `signInAnonymously()`,
     producing a fresh uid with zero progress.
  5. `useUserProfile(newUid)` returns a profile with no displayName.
  6. `NavigationGate` sees `!hasName && !onNameScreen` and
     `router.replace('/name')` — the user lands on the onboarding
     name screen, which is the closest thing this app has to a
     "sign in" page.
  7. After they pick a name, the gate sees `hasName &&
     !tutorialCompletedAt` and pushes `/welcome` for a fresh run
     of the 3-card tutorial. Reset always re-shows the tutorial
     because the new uid IS a new player. See §18 for the full
     onboarding flow.
- **Listener resilience.** `useUserProfile` (`TirApp/lib/auth.tsx`)
  passes a Firestore error handler to `onSnapshot`. During the
  delete transition, the listener attached to the OLD uid receives
  a `permission-denied` error as auth flips; without an error
  handler, the unhandled promise rejection crashed the iOS app.
  The handler treats any listener error as "profile gone"
  (`setProfile(null)`), which lets `NavigationGate` recover on
  the next userId update.

---

## 18. First-launch onboarding (`/name` → `/welcome` → `/`)

The app is **anon-auth-only** today, so first launch isn't a "create
account" flow — it's an identity capture + 15-second how-to. The flow
is gated by `NavigationGate` in `TirApp/app/_layout.tsx` and routed
purely off the user doc, so a `Reset progress` (server `deleteAccount`)
correctly re-shows the entire flow for the new anon uid.

**Three-stage gate** (in `NavigationGate`):

1. `!userId` → `AuthProvider` is calling `signInAnonymously()`. Render
   nothing visible (Stack returns content under the gate; profile is
   `null` until auth lands).
2. `userId && !displayName` → `router.replace('/name')`.
3. `userId && displayName && !tutorialCompletedAt` → `router.replace('/welcome')`.
4. Otherwise → home.

**`/name` screen** (`TirApp/app/name.tsx`):

- Pre-fills the input with a generated handle (`adjective-noun##`) and
  a randomly-picked emoji avatar so a player can ship in **one tap** —
  this is the frictionless path. NN/g: every typed field adds
  abandonment risk.
- Live identity preview mirrors the home `identityCard` vocabulary
  (44pt avatar slot, accent halo, `1000 ELO · NEW` data grid) so the
  card feels familiar the moment they land on home (KB §Cross-screen
  identity).
- Shuffle button (🎲) reseeds the suggested handle without typing.
- Single CTA `continue →` writes `displayName + avatarEmoji + updatedAt`;
  `NavigationGate` picks up the change and routes to `/welcome` on the
  next effect tick. Single source of truth for routing.
- Motion: entrance stagger (`FadeInDown.delay(i * 60)` matching the
  home screen pattern) + `LinearTransition` on the preview card +
  `PressableScale` on every tappable. No idle loops (KB §Restraint).

**`/welcome` screen** (`TirApp/app/welcome.tsx`):

- 3 horizontal-paged cards, swipeable, with dot indicator + sticky CTA
  (`next` / `let's race`). Skip is in the top-right of every card —
  visible but not loud (NN/g "skip is sacred").
- Each card teaches ONE concept with the actual game UI vocabulary
  rather than abstract diagrams ("show, don't tell" — gameconsole.link
  2026 retention; player-onboarding skill):
  - Card 1 — **THE GOAL**: bordered target card (`OCEAN`), accent halo
    bloom on entry. Same shape as the in-game `targetCard`.
  - Card 2 — **THE MOVE**: current word `RIVER` + four option chips,
    one (`STREAM`) glints accent on entry — the closest meaning *reads*
    brightest. Same chip shape as in-game `OptionChip`.
  - Card 3 — **THE RACE**: roster of avatars (the player's own emoji
    rendered alongside three opponents), the player's ring pulsing
    accent on entry, with a `LIVE · 4 PLAYERS` tick chip.
- All animations are **value-change motion fired once on card-active**
  — no idle loops, all `ReduceMotion.System` for accessibility (KB
  §Restraint over decoration).
- Completion writes `users/{uid}.tutorialCompletedAt = serverTimestamp()`
  via the same client-write path that name.tsx uses; `NavigationGate`
  flips to home on the next tick.

**Firestore rules** (`firestore.rules`):

`users/{userId}` write allow-list expanded from `[displayName,
avatarEmoji, updatedAt]` to `[displayName, avatarEmoji, updatedAt,
tutorialCompletedAt]`. All other fields (rating, streaks, counters)
are written exclusively server-side via the admin SDK and bypass
rules — see §5 callables. Deploy with:

```
cd tir && firebase deploy --only firestore:rules
```

**Sources** (UX research log entry #31, ux-design-expert KB):
- Apple WWDC17 *Love at First Launch* — "lead with content, not registration".
- NN/g `mobile-app-onboarding` — tutorials don't necessarily improve task
  performance; in-context tips + skip are sacred.
- gameconsole.link 2026 retention — meaningful play within 60s, "best
  onboarding is invisible to the player".
- Plotline 2026 onboarding examples — pager dots + sticky CTA pattern.

---

## 19. Environment & tooling

| Tool | Version / Notes |
|---|---|
| Node | ≥ 20 (required by functions) |
| React Native | 0.81.5 (bare, with Expo dev-client; new arch enabled) |
| Expo | ^54 (dev-client only — **not** Expo Go) |
| Firebase SDK in app | `@react-native-firebase/*` v24 (native modules) |
| Firebase Admin | ^12.6 |
| Firebase Functions | ^5.1 (v2 onCall) |
| TypeScript | ^5.8 (TirApp), ^5.6 (functions) |
| Firebase project | `tirapp-c596f` |
| Functions region | `us-central1` |
| iOS bundle id (today) | `com.tirapp` (rebrand to `com.aaam.tir` planned in Phase 1) |
| Studio Apple Team ID | `D92AD98B9B` (`aaam.dev`) |
