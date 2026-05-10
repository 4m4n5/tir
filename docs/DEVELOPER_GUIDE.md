# tir — developer guide

**Audience:** engineers and AI agents working on tir. Read
[`AGENTS.md`](../AGENTS.md) first for tone and conventions; use this
file for **architecture, callable contracts, Firestore ownership,
indexes, and feature boundaries**.

**Companion docs:** [`SETUP.md`](../SETUP.md) ·
[`BLUEPRINT.md`](../BLUEPRINT.md) ·
[`DESIGN.md`](./DESIGN.md) ·
[`APPS_AND_FEATURES.md`](./APPS_AND_FEATURES.md)

---

## 1. Quick orientation

| Item | Value |
|---|---|
| App name (today) | `TirApp` (rebrand to `tir` planned in Phase 1) |
| iOS bundle id | `com.tirapp` |
| Android package | `com.tirapp` |
| Expo `slug` | `tirapp` |
| Deep-link scheme | `tirapp://` |
| Firebase project | `tirapp-c596f` (in `.firebaserc`) |
| Cloud Functions region | `us-central1` |
| Functions runtime | Node 20 (v2 onCall) |
| RN version | 0.81.5 (bare, **new arch enabled**) |
| Expo SDK | 54 (dev-client only — *not* Expo Go) |
| Firebase SDK in app | `@react-native-firebase/*` v24 (native), **not** the JS SDK |

First-time clone instructions: [`SETUP.md`](../SETUP.md).

---

## 2. Directory map

```
tir/
├── AGENTS.md                ← agent entry point + conventions
├── BLUEPRINT.md             ← product + technical spec
├── QUESTIONS.md             ← original game-design Q&A
├── README.md                ← landing
├── SETUP.md                 ← machine setup
├── .firebaserc              ← Firebase project: tirapp-c596f
├── firebase.json            ← Firestore + Functions deploy config
├── firestore.rules          ← clients read-only; all writes via Admin SDK
├── firestore.indexes.json   ← (empty — no composites needed yet)
│
├── docs/
│   ├── DEVELOPER_GUIDE.md   ← this file
│   ├── DESIGN.md            ← visual language + motion + components
│   ├── APPS_AND_FEATURES.md ← living brainstorm + backlog
│   ├── game-rules-v1.md     ← legacy condensed-rules sheet (kept for grep)
│   └── word-engine.md       ← engine spec (stub → precomputed roadmap)
│
├── functions/               ← Cloud Functions v2 (TS)
│   └── src/
│       ├── index.ts            ← admin.initializeApp() + re-exports
│       ├── callables.ts        ← 5 onCall functions (the game API)
│       ├── stub.ts             ← 28-word fallback vocab + neighbor graph + MMR
│       ├── embeddingNeighbor.ts← semantic word engine (GloVe precomputed neighbors)
│       ├── contentPolicy.ts    ← single-token ASCII + profanity gate
│       ├── rewards.ts          ← Elo + roundsWon / photo-finish / participation
│       └── globalRooms.ts      ← UID-hashed shard assignment (3 shards)
│
└── TirApp/                  ← React Native bare app
    ├── App.tsx              ← single-screen UI (auth, room, gameplay, HUD)
    ├── index.js             ← `import 'expo/AppEntry'`
    ├── app.json             ← Expo config (bundleId com.tirapp)
    ├── package.json
    ├── ios/                 ← Xcode project, Pods, GoogleService-Info.plist
    ├── android/             ← Gradle, google-services.json
    └── src/
        ├── rooms/
        │   └── privateRooms.ts   ← Firestore refs, types, callable wrappers, logPerf
        ├── wordEngine/
        │   └── stub.ts           ← client copy of stub engine (not actively imported)
        └── firebase/
            └── client.ts         ← thin auth/firestore helpers (not actively imported)
```

---

## 3. The two-process model

```
   ┌──────────────────────────┐                ┌──────────────────────────┐
   │       TirApp (RN)        │  callable RPC  │   Cloud Functions (v2)   │
   │                          │ ──────────────▶│      us-central1         │
   │  - anonymous auth        │                │                          │
   │  - onSnapshot listeners  │◀──── snapshot ─│  - admin SDK writes      │
   │  - render UI             │     updates    │  - all game logic        │
   │  - call functions        │                │  - rewards, sharding     │
   └──────────────────────────┘                └──────────────────────────┘
              │                                              │
              │              read-only listens               │ writes (Admin SDK)
              ▼                                              ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │                          Firestore                                 │
   │  rooms / rounds / players / users / meta / cache / analytics      │
   └────────────────────────────────────────────────────────────────────┘
```

**Rule:** the client never writes a game-state field. The closest
exception is the `_debug/ping` doc, which exists purely as a startup
round-trip check and is wide-open in the rules.

---

## 4. Client bootstrap (`App.tsx`)

Single component (`AppContent`) inside a `SafeAreaProvider`. State
flow:

1. **`firebaseReady`** flips on mount (the `@react-native-firebase`
   modules are auto-initialized by `FirebaseApp.configure()` in
   `AppDelegate.swift` for iOS / `google-services.json` for Android).
2. **`auth().onAuthStateChanged`** → if no `userId`, calls
   `signInAnonymously()`.
3. **`_debug/ping`** write happens once per UID — confirms Firestore
   round-trip.
4. **`useMemo`** builds doc refs (`rRoom`, `rRound`, `rPlayer`,
   `rUser`).
5. **Five `onSnapshot` subscriptions:**
   - `rRoom` → `roomMode`
   - `rRound` → `round` + emits a green "round N" toast on
     `roundSeq` increment
   - `rPlayer` → `myPlayer` (currentWord, options[4], usedOptionWords)
   - `playersCollection(roomId)` → `roster`
   - `rUser` → `elo`
6. **Finish-window timer:** when `round.phase === 'finish_window'` and
   `phaseEndsAt` is in the future, a 250 ms interval ticks the
   countdown; once expired, `maybeFinalize()` is called every 600 ms
   until `roundSeq` advances. Idempotent on the server side.

### User actions

| Action | Server callable | Side effects |
|---|---|---|
| Create private room | `createPrivateRoom()` then `joinPrivateRoom(roomId)` | new `rooms/{id}` + `rounds/current`; player added |
| Enter global shard | `assignGlobalRoom()` then `joinPrivateRoom(roomId)` | UID hashed → shard; shard room created lazily |
| Join by code | direct doc check + `joinPrivateRoom(code)` | player added to existing room |
| Choose option | `submitMove(roomId, word)` | engine returns new word + options; if equal to target, transitions to `finish_window` |

All callables are wrapped in `TirApp/src/rooms/privateRooms.ts` for
typing convenience and `[perf] <name> <ms>` logging.

---

## 5. Cloud Functions (callable contracts)

All functions live in `functions/src/callables.ts`, exported from
`index.ts`. Region: `us-central1`. Auth: anonymous is enough. Bad
inputs throw `HttpsError`s with `invalid-argument`,
`failed-precondition`, `unauthenticated`, etc.

### `createPrivateRoom()`

- **Input**: none
- **Returns**: `{ roomId, targetWord, options }`
- **Effects**: creates `rooms/{id}` (`mode: 'private'`,
  `status: 'active'`, `memberIds: []`) + `rounds/current`
  (`phase: 'active'`, `targetWord: 'ocean'`, `roundSeq: 1`).
- **Notes**: hardcoded initial target. Phase 1 should rotate from a
  curated pool.

### `joinPrivateRoom({ roomId })`

- **Returns**: `{ ok: true }`
- **Effects**: ensures `players/{uid}` exists with a sensible
  `currentWord` + `options`; updates `room.memberIds` arrayUnion.
- **Seeding**: brand-new joiners get a `currentWord` chosen *behind
  the median distance* of existing players from the target (see
  `pickJoinCurrentWord`). Existing returners keep their word.

### `submitMove({ roomId, nextWord })`

- **Returns**: `{ ok: true }`
- **Validates**: word passes `assertAllowedWord`; word is in the
  player's `options`; phase is `active` or `finish_window`; phase
  hasn't expired (if `finish_window`, refuses to act and asks the
  client to call `finalizeFinishWindow`).
- **Effects**:
  - If phase is `active` and target reached → transitions to
    `finish_window`, sets `phaseEndsAt = now + 3s`, sets
    `primaryWinnerUid = uid`, clears `windowFinishers`.
  - If phase is `finish_window` and target reached and uid is not
    already the primary winner → adds uid to `windowFinishers`.
  - Always: regenerates the player's options for their new
    `currentWord`, increments `movesThisRound`, stamps
    `lastPickAt` + `lastSeenAt`.
- **Concurrency**: a Firestore transaction re-checks options + phase
  before committing. Returns `failed-precondition` (`Options changed;
  retry` or `Phase changed; retry`) on a stale write — the client
  retries.

### `finalizeFinishWindow({ roomId })`

- **Returns**: `{ advanced: boolean, waiting?: boolean,
  endsAtMillis?, newTarget? }`
- **Idempotent**: CAS on `phaseEndsAt`. Multiple clients calling at
  the same time cause at most one round advance.
- **Effects**: picks a new `targetWord`, regenerates options for every
  player from their current word, resets `usedOptionWords`,
  increments `roundSeq`, transitions back to `phase: 'active'`. Then
  calls `applyRoundRewards`.
- **Known sharp edge**: rewards are not yet locked behind a
  deduplication doc. Track in
  [`BLUEPRINT.md` § Anti-cheat](../BLUEPRINT.md).

### `assignGlobalRoom()`

- **Returns**: `{ roomId, shardIndex }`
- **Effects**: hashes the UID into one of `SHARD_COUNT` (= 3) shards;
  creates the shard room lazily on first use; returns its id. Client
  is then expected to call `joinPrivateRoom(roomId)`.

---

## 6. Firestore — collections & code ownership

| Collection | Owner module | Notes |
|---|---|---|
| `rooms/{roomId}` | `callables.ts`, `globalRooms.ts` | `mode`, `status`, `memberIds[]`, `shardIndex?` |
| `rooms/{roomId}/rounds/current` | `callables.ts` | one doc per room, always `current` |
| `rooms/{roomId}/players/{uid}` | `callables.ts` | per-player state |
| `rooms/{roomId}/events/*` | (planned) | event feed; rules already allow it |
| `users/{uid}` | `rewards.ts` | Elo + counters; created lazily on first reward |
| `meta/globalRooms` | `globalRooms.ts` | shard registry |
| `precomputed/neighbors/words/{word}` | `embeddingNeighbor.ts` | GloVe semantic neighbors (top-50) + cosine scores |
| `analytics/{YYYY-MM-DD}` | `rewards.ts` | `roundCompletions` per day |
| `rewardLocks/*` / `finalizeLocks/*` | (planned) | one-shot dedupe for idempotent reward issuance |
| `_debug/ping` | `App.tsx` | dev round-trip check; only collection writable from the client |

### Indexes

`firestore.indexes.json` is empty. All current queries are either
single-doc `onSnapshot`s or small-subcollection scans
(`players` per room). When the **event feed** ships, expect to add a
composite on `(type, createdAt desc)` per room.

### Security rules (`firestore.rules`)

```
rooms/{roomId}                read: signedIn         | write: false
  rounds/{roundId}            read: signedIn         | write: false
  players/{playerId}          read: signedIn         | write: false
  events/{eventId}            read: signedIn         | write: false
users/{userId}                read: self only        | write: false
meta/{docId}                  read: signedIn         | write: false
cache/{anything}              fully denied
analytics/{anything}          fully denied
rewardLocks / finalizeLocks   fully denied
_debug/{docId}                read+write: signedIn   ← dev only
```

The hard rule for new collections: **deny client writes by default.
Add a callable.**

---

## 7. Word engine plumbing (semantic similarity)

> **Core principle:** tir is a **semantic matching game**. Words are
> connected by **meaning**, not by spelling or letter patterns.

The engine has one entry point: `embeddingNextMove(...)` in
`functions/src/embeddingNeighbor.ts`. It reads precomputed GloVe
semantic neighbors from Firestore:

```
embeddingNextMove(...)
  ├── Read precomputed neighbors from `precomputed/neighbors/words/{word}`
  ├── Build candidate pool from top-50 semantic (meaning-based) neighbors
  ├── Select: 1 closest + 1 medium + 1 path-toward-target + 1 MMR diversifier
  ├── Apply minimum-moves guard (target excluded until ≥ 2 moves)
  ├── Shuffle and return 4 options
  └── (if word missing from precomputed data) → stubNextMove(...) fallback
```

### Pipeline

Neighbors are precomputed offline using **GloVe** (word co-occurrence
embeddings, NOT character-level). Pipeline: `pipeline/build_neighbors.py`.

```bash
cd pipeline && python3 build_neighbors.py --upload
```

This embeds ~900 curated common words using GloVe 300d, computes top-50
cosine neighbors, filters out lexically-similar words (shared prefix/suffix
> 60%), and uploads to Firestore at `precomputed/neighbors/words/{word}`.

### Telemetry

`generationMeta.provider` is `'precomputed'` for GloVe-backed moves,
`'stub'` for fallback.

---

## 8. Reward system (`rewards.ts`)

`applyRoundRewards({ roomId, primaryWinnerUid, windowFinisherUids,
allPlayerUids })` writes a single batched commit:

| Player class | Elo | counters |
|---|---|---|
| `primaryWinnerUid` | +25 | `roundsWon +1`, `winStreak +1`, `roundsPlayed +1` |
| each `windowFinisherUids` (not the primary) | +10 | `roundsPhotoFinish +1`, `roundsPlayed +1` |
| each remaining `allPlayerUids` | 0 | `roundsPlayed +1` |

`lastPlayedDay` (UTC `YYYY-MM-DD`) is stamped for every uid.
`analytics/{day}.roundCompletions` is incremented by 1.

Known gaps tracked in [`BLUEPRINT.md` § 6](../BLUEPRINT.md):
`winStreak` never resets on a loss; `dailyStreak` is unimplemented;
the issuer is not yet idempotent against double-fire of
`finalizeFinishWindow`.

---

## 9. Adding a new feature — checklists

### A new on-screen interaction (no new server logic)

1. Read the design language in [`DESIGN.md`](./DESIGN.md). Pick the
   right primitive (Pressable + Reanimated, not raw TouchableOpacity).
2. Update `App.tsx` (or, in Phase 1+, the relevant Expo Router file)
   and any `src/rooms/privateRooms.ts` helpers.
3. Run `cd TirApp && npx tsc --noEmit` before committing.

### A new collection or callable

1. Add the collection deny-by-default to `firestore.rules`.
2. Add the callable to `functions/src/callables.ts` (export it from
   `index.ts`).
3. Define the input/return types and add a thin wrapper in
   `TirApp/src/rooms/privateRooms.ts`.
4. If the client needs to read live state, add an `onSnapshot` and
   make sure rules allow `read: if signedIn();` (or stricter).
5. Add an index to `firestore.indexes.json` if you need a
   compound query (`coupleId + createdAt`-style). Deploy with
   `firebase deploy --only firestore:indexes`.
6. Update [`AGENTS.md` § Firestore Data Model](../AGENTS.md) and
   [`BLUEPRINT.md` § 8](../BLUEPRINT.md) so the docs don't drift.

### A new word-engine provider

1. Implement the same shape `embeddingNextMove(...)` exports
   (`{ currentWord, targetWord, options[4], generationMeta }`).
2. Plug it into the dispatch chain (today the dispatcher *is*
   `embeddingNextMove`; in Phase 1 we'll factor that out into a small
   `engineNextMove` resolver).
3. Stamp `generationMeta.provider` correctly so analytics is honest.

---

## 10. Tests, lint, typecheck

```bash
# Mobile app
cd TirApp
npx tsc --noEmit          # TypeScript check
npm run lint              # ESLint
npm test                  # Jest — currently a single render smoke test

# Functions
cd functions
npm run build             # tsc → lib/
```

There are **no callable-level tests yet** for the functions. When the
precomputed engine and reward dedup land in Phase 1, plan to add a
small `firebase-functions-test` harness.

---

## 11. Performance + telemetry

- `logPerf(label, started)` in `App.tsx` and `privateRooms.ts` writes
  `[perf] <label> <ms>` to console. Useful labels today:
  `createPrivateRoom`, `joinPrivateRoom`, `assignGlobalRoom`,
  `submitMove`, `finalizeFinishWindow`.
- Server side: standard Cloud Functions logs in the Firebase console
  or `firebase functions:log`. There's no structured-events feed yet
  (planned in [`BLUEPRINT.md` § Phase 2](../BLUEPRINT.md)).
- Daily `analytics/{YYYY-MM-DD}.roundCompletions` is the only
  rolled-up metric today.

---

## 12. Where to look next

| Need | Doc |
|---|---|
| Product decisions, roadmap, cost model | [`../BLUEPRINT.md`](../BLUEPRINT.md) |
| Original game-design Q&A | [`../QUESTIONS.md`](../QUESTIONS.md) |
| Visual language + motion + components | [`./DESIGN.md`](./DESIGN.md) |
| Idea backlog | [`./APPS_AND_FEATURES.md`](./APPS_AND_FEATURES.md) |
| Setup on a new machine | [`../SETUP.md`](../SETUP.md) |
| Tone + conventions for agents | [`../AGENTS.md`](../AGENTS.md) |
