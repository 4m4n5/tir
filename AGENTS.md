# tir — Agent Handoff Document

This file is the single exhaustive reference for any agent continuing work on tir.
Read this before touching any code.

---

## 1. What tir Is

tir is a mobile word-race game (iOS + Android, React Native bare + Firebase).
Players race from a **current word** to a **target word** by repeatedly choosing **1 of 4 semantically-close options**. The first player to hit the target triggers a **3-second finish window** for others. Then a new target rotates in.

Core constraints:
- Target is always **visible**; numeric distance is **hidden**.
- No pay-to-win. Rerolls replace all 4 options and are earned via play.
- Default mode: **global** rooms (large rotating shards). Also supports **private** friend rooms.
- Joiners spawn **behind the median** distance of active players (randomized band).
- Session target: ~2-5 min, fast-twitch feel.

Full game design decisions live in `QUESTIONS.md`.
Condensed v1 rules in `docs/game-rules-v1.md`.
Word engine spec in `docs/word-engine.md`.

---

## 2. Repo Structure

```
tir/
├── AGENTS.md                    ← this file
├── QUESTIONS.md                 ← full game design Q&A
├── README.md                    ← project overview
├── .firebaserc                  ← Firebase project: tirapp-c596f
├── firebase.json                ← Firestore rules + Functions config
├── firestore.rules              ← security rules (clients read-only; writes via Admin SDK)
├── firestore.indexes.json       ← (empty — no custom indexes yet)
├── docs/
│   ├── game-rules-v1.md         ← v1 rules summary
│   └── word-engine.md           ← word engine spec (stub → embeddings)
├── functions/                   ← Cloud Functions (Node 20, TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   ├── .gitignore
│   └── src/
│       ├── index.ts             ← admin.initializeApp() + re-exports callables
│       ├── callables.ts         ← 5 onCall v2 functions (the game API)
│       ├── stub.ts              ← curated vocab + neighbor graph + MMR option gen
│       ├── embeddingNeighbor.ts ← OpenAI embedding + Firestore cache (stub fallback)
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
createdAt: Timestamp
updatedAt: Timestamp
memberIds: string[]      # UIDs of joined players
shardIndex?: number      # global rooms only
```

### `rooms/{roomId}/rounds/current`
```
targetWord: string
phase: 'active' | 'finish_window'
phaseEndsAt: Timestamp | null
roundSeq: number         # increments each round
primaryWinnerUid: string | null
windowFinishers: string[]
updatedAt: Timestamp
```

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
roundsWon: number
roundsPlayed: number
roundsPhotoFinish: number
winStreak: number
lastPlayedDay: string    # 'YYYY-MM-DD'
updatedAt: Timestamp
```

### `meta/globalRooms`
```
roomIds: string[]        # roomId per shard
shardCount: number       # currently 3
updatedAt: Timestamp
```

### `cache/wordEmbeddings/words/{word}`
```
vector: number[]
model: string            # 'text-embedding-3-small'
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
- **Input:** (none)
- **Returns:** `{ roomId, targetWord, options }`
- Creates `rooms/{id}` (mode: private) + `rounds/current` (phase: active, targetWord: 'ocean').

### `joinPrivateRoom`
- **Input:** `{ roomId }`
- **Returns:** `{ ok: true }`
- Creates/updates `players/{uid}` with starting word + options. New joiners are seeded behind the median distance of existing players. Adds UID to `memberIds`.

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
- **Returns:** `{ advanced: boolean, waiting?: boolean, newTarget?: string }`
- Called by client when `phaseEndsAt` has passed. Idempotent (CAS on `phaseEndsAt`).
- Picks new target, regenerates options for all players, resets `usedOptionWords`, increments `roundSeq`, transitions to `phase: 'active'`.
- Issues rewards via `applyRoundRewards` (winner +25 Elo, photo-finishers +10, others participation).

### `assignGlobalRoom`
- **Input:** (none)
- **Returns:** `{ roomId, shardIndex }`
- Hashes UID into one of 3 shards. Creates shard room if missing. Client then calls `joinPrivateRoom` with the returned roomId.

---

## 6. Word Engine

### Phase 1 (current default): Stub
- **41-word curated vocab** (nature-themed: start, stone, rock, ocean, forest, fire, shadow, etc.)
- **Hand-curated neighbor lists** in `NEIGHBORS` map.
- Option generation: **3 nearest** neighbors by rank proximity + **1 MMR diversifier** (alpha=0.85, pool K=50).
- `excludeWords` support: words already chosen this round are filtered out of the pool.
- `pickNextTargetWord`: avoids current word and previous target.
- Identical logic in both `functions/src/stub.ts` and `TirApp/src/wordEngine/stub.ts`.

### Phase 2 (opt-in): Embedding-based
- `functions/src/embeddingNeighbor.ts`: if `OPENAI_API_KEY` env var is set on the Functions runtime, uses **text-embedding-3-small** for cosine similarity ranking.
- Embeddings are **cached** in Firestore at `cache/wordEmbeddings/words/{word}`.
- On any error or missing key, **falls back** to stub.
- **Free alternatives** (not yet implemented): precompute neighbors offline with `all-MiniLM-L6-v2` or another local model, store in Firestore, skip API calls entirely.

---

## 7. Client Architecture (TirApp/App.tsx)

Single `AppContent` component in one screen:
- **Auth:** Anonymous sign-in via `@react-native-firebase/auth`.
- **Firestore listeners:** subscribes to room doc (mode), round doc (target/phase/countdown), player doc (currentWord/options), players collection (roster), user doc (Elo).
- **Game actions:** Create private room, Enter global shard, Join by room code, Choose option word.
- **Finish window:** countdown timer; when expired, client calls `finalizeFinishWindow` and polls until round advances.
- **Round toast:** green text flash on `roundSeq` increment ("New target — round N").
- **Finish banner:** yellow text "FINISH WINDOW — N" during the 3s window.
- **Callable wrappers:** in `TirApp/src/rooms/privateRooms.ts` (thin functions around `fns.httpsCallable(...)`).
- **Latency logging:** `logPerf(label, startTimestamp)` logs `[perf] label Nms` to console.

---

## 8. Firestore Security Rules

- **Clients can READ** rooms, rounds, players, users(self), meta, and `_debug`.
- **All writes are DENIED** to clients; writes happen exclusively through Cloud Functions (Admin SDK).
- `cache/`, `analytics/`, `rewardLocks/`, `finalizeLocks/` are fully denied to clients.

---

## 9. Installation & Setup

### Prerequisites
- Node >= 20
- Xcode (iOS) / Android Studio (Android)
- Ruby + Bundler (for CocoaPods)
- Firebase CLI (`npm i -g firebase-tools && firebase login`)

### Mobile app
```bash
cd TirApp
npm install
cd ios && pod install && cd ..

# iOS (physical device — requires Apple dev team signing in Xcode)
npx expo run:ios --device

# Android
npx expo run:android

# Dev server (after native build)
npx expo start --dev-client
```

### Cloud Functions
```bash
cd functions
npm install
npm run build          # compiles TS to lib/

# Deploy
firebase deploy --only functions

# Deploy with rules
firebase deploy --only functions,firestore:rules
```

### Optional: Enable embedding-based word engine
```bash
# Set OpenAI key on Functions runtime
firebase functions:config:set openai.key="sk-..."
# OR set as env var in functions/.env (gitignored):
# OPENAI_API_KEY=sk-...
```

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
| Functions timeout | Cold start + embedding API latency | Stub fallback handles this; check OPENAI_API_KEY |
| iOS build fails | Pods out of date | `cd ios && pod install --repo-update` |
| `FirebaseApp.configure()` crash | Missing GoogleService-Info.plist | Ensure plist is in `ios/TirApp/` AND `ios/` |

### Useful logs
- Client: `[perf] submitMove Nms`, `[auth] onAuthStateChanged`, `[firestore] startup ping ok`
- Functions: standard Cloud Functions logs in Firebase Console or `firebase functions:log`

---

## 12. Rewards & Rating System

- **Winner:** +25 Elo, +1 roundsWon, +1 winStreak
- **Photo-finisher** (reached target during 3s window): +10 Elo, +1 roundsPhotoFinish
- **Others:** +1 roundsPlayed only
- **League tiers:** Bronze (<1200), Silver (1200+), Gold (1400+), Platinum (1600+), Diamond (1800+)
- Daily analytics: `analytics/{YYYY-MM-DD}.roundCompletions` incremented per finalized round.

---

## 13. Global Room Sharding

- 3 shards (constant `SHARD_COUNT` in `globalRooms.ts`).
- UID hashed to a shard index. Shard room created on first use.
- Shard metadata stored in `meta/globalRooms.roomIds[]`.
- Same round lifecycle as private rooms (shared target, per-player options).

---

## 14. Known Gaps / Next Steps

1. **Idempotent finalize:** concurrent `finalizeFinishWindow` calls could double-issue rewards. Add a lock doc or deduplicate by `roundSeq`.
2. **Rerolls:** designed in spec but not implemented. Should replace all 4 options, earned via streaks/quests.
3. **Event feed:** `rooms/{roomId}/events/` collection exists in rules but nothing writes to it yet. Intended for `playerReachedTarget`, `finishWindowStarted`, `newTarget` events.
4. **Proper noun policy:** content policy currently only blocks profanity; proper noun filtering is stubbed.
5. **Larger vocab:** stub has 41 words. Production needs a real vocabulary (thousands of words) + precomputed neighbor lists or live embeddings.
6. **Free embeddings:** replace OpenAI with offline-precomputed neighbors (e.g. `all-MiniLM-L6-v2` run locally, store top-K neighbors per word in Firestore).
7. **Multiple screens:** current UI is a single screen. Needs: Onboarding, Home, Profile/Rank, Results/Feed.
8. **Win streak reset:** `winStreak` increments on wins but never resets on losses.
9. **Daily streak:** spec mentions daily streaks but not implemented.
10. **Room rotation for globals:** shard rooms are never rotated/replaced; might need periodic recycling.
11. **Android:** builds should work but has only been tested on iOS physical device.
12. **Tests:** no unit tests for functions; TirApp Jest test is a minimal render smoke test.

---

## 15. Key Design Docs

| Doc | Path | What it covers |
|-----|------|----------------|
| Game design Q&A | `QUESTIONS.md` | Every design decision with answers |
| v1 rules | `docs/game-rules-v1.md` | Visibility, timing, moves, multiplayer, anti-cheat |
| Word engine spec | `docs/word-engine.md` | Distance definition, option gen algorithm, MMR formula, policies, stub vs embeddings |

---

## 16. Environment & Tooling

| Tool | Version / Notes |
|------|----------------|
| Node | >= 20 (required by functions) |
| React Native | 0.81.5 (bare, with Expo dev-client) |
| Expo | ^54 |
| Firebase Admin | ^12.6 |
| Firebase Functions | ^5.1 (v2 onCall) |
| TypeScript | ^5.8 (TirApp), ^5.6 (functions) |
| Firebase project | `tirapp-c596f` |
| Functions region | `us-central1` |
