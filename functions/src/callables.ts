import * as admin from 'firebase-admin';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {assertAllowedWord} from './contentPolicy';
import {DEFAULT_DIFFICULTY, isDifficulty} from './difficulty';
import type {Difficulty} from './difficulty';
import {computeCosineDist, embeddingNextMove, findShortestPath, randomSeedWord} from './embeddingNeighbor';
import {assignGlobalRoomId} from './globalRooms';
import {commitRoundDeltas, computeRoundDeltas} from './rewards';
import {pickNextTargetWord} from './stub';

const REGION = 'us-central1';

// 3-second barrier between rounds. All online players see the results popup
// for this duration; nobody can submit moves until the barrier expires and
// the round advances. See AGENTS.md §Round phase machine.
const RESULTS_BARRIER_MS = 3000;

// A player is "actively present in the round" if their last heartbeat
// landed within this window. The client sends a heartbeat every 5s
// from `[roomId].tsx`, so 15s = 3 missed heartbeats — tight enough to
// catch a backgrounded/force-quit app within a few seconds, generous
// enough to absorb a Cloud Function cold start + cellular jitter.
//
// Distinct from `STALE_PRESENCE_MS` (60s) used by the scheduler in
// `advanceFromResults` for between-round `memberIds` pruning — that
// path is more conservative because pruning kicks a player out of the
// room entirely, whereas this threshold only decides who counts as a
// participant for THIS round's Elo math.
const ACTIVE_PRESENCE_MS = 15_000;

function db() {
  return admin.firestore();
}

async function pickJoinCurrentWord(
  others: string[],
  targetWord: string,
): Promise<string> {
  if (!others.length) return randomSeedWord();

  const dists = await Promise.all(
    others.map(o => computeCosineDist(db(), o, targetWord)),
  );
  dists.sort((a, b) => a - b);
  const medianDist = dists[Math.floor(dists.length / 2)] ?? 0.5;
  const wantDist = Math.min(1, medianDist + 0.05 + Math.random() * 0.05);

  if (wantDist > 0.7) return randomSeedWord();

  return randomSeedWord();
}

function uniqLower(words: string[]): string[] {
  return Array.from(new Set(words.map(w => w.toLowerCase())));
}

function dedupUsed(used: string[]): string[] {
  return uniqLower(used);
}

// Curated alphabet for 4-char join codes. Excludes characters that are
// easy to misread on a phone screen (0/O, 1/I/L, plus the lowercase
// version is unnecessary because we display + accept uppercase only).
// 31^4 = 923,521 codes — comfortably more than the active-room ceiling
// even at viral scale.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;
const MAX_CODE_ATTEMPTS = 12;

function randomCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

// Tries to atomically claim a 4-char code as the room doc ID using
// Firestore's `create()` (which fails if the doc already exists).
// Retries on collision; surfaces a clear error if the alphabet is
// saturated (which would mean ~5–10% of all codes are in use, i.e. tens
// of thousands of active private rooms — at that point we'd grow the
// alphabet to 5 chars rather than retry harder).
async function reserveRoomCode(
  uid: string,
  difficulty: Difficulty,
): Promise<{code: string; ref: FirebaseFirestore.DocumentReference}> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = randomCode();
    const ref = db().collection('rooms').doc(code);
    try {
      await ref.create({
        mode: 'private',
        status: 'active',
        code,
        difficulty,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        memberIds: [uid],
      });
      return {code, ref};
    } catch (err) {
      const code = (err as {code?: number; message?: string})?.code;
      // Firestore returns code 6 (ALREADY_EXISTS) on create() collision.
      // Anything else is a real failure — surface it.
      if (code !== 6) throw err;
    }
  }
  throw new HttpsError(
    'resource-exhausted',
    'could not allocate a unique room code, please retry',
  );
}

export const createPrivateRoom = onCall({region: REGION}, async request => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const rawDifficulty = request.data?.difficulty;
  const difficulty: Difficulty = isDifficulty(rawDifficulty) ? rawDifficulty : DEFAULT_DIFFICULTY;
  // Reserve the 4-char code as the room doc ID via atomic create().
  const {code, ref: roomRef} = await reserveRoomCode(uid, difficulty);
  const target = await pickNextTargetWord({currentWord: 'start', db: db()});
  const startWord = randomSeedWord();
  const move = await embeddingNextMove({
    db: db(),
    currentWord: startWord,
    targetWord: target,
    excludeWords: [],
    movesThisRound: 0,
    difficulty,
  });
  const batch = db().batch();
  batch.set(roomRef.collection('rounds').doc('current'), {
    targetWord: target,
    phase: 'active',
    phaseEndsAt: null,
    roundSeq: 1,
    primaryWinnerUid: null,
    windowFinishers: [] as string[],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  batch.set(roomRef.collection('players').doc(uid), {
    currentWord: move.currentWord,
    options: move.options,
    usedOptionWords: [],
    movesThisRound: 0,
    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return {roomId: code, code, targetWord: target, options: move.options};
});

// Short private-room codes are stored / matched in uppercase. Long
// Firestore auto-IDs (used by sharded global rooms) are 20 chars and
// must pass through unchanged, so we only uppercase inputs that look
// like join codes (≤ 6 chars). Any other length is treated as an
// opaque room ID.
function normalizeRoomId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 6) return trimmed.toUpperCase();
  return trimmed;
}

export const joinPrivateRoom = onCall({region: REGION}, async request => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const rawRoomId = request.data?.roomId as string | undefined;
  if (!rawRoomId) {
    throw new HttpsError('invalid-argument', 'roomId required');
  }
  const roomId = normalizeRoomId(rawRoomId);
  const roomRef = db().collection('rooms').doc(roomId);
  const roundRef = roomRef.collection('rounds').doc('current');
  const playerRef = roomRef.collection('players').doc(uid);
  const [roomSnap, roundSnap, existingPlayer] = await Promise.all([
    roomRef.get(),
    roundRef.get(),
    playerRef.get(),
  ]);
  if (!roomSnap.exists) {
    throw new HttpsError('not-found', 'Room not found');
  }
  if (!roundSnap.exists) {
    throw new HttpsError('failed-precondition', 'Round not initialized');
  }
  const targetWord = String(roundSnap.data()?.targetWord ?? 'ocean').toLowerCase();
  const roomDifficulty: Difficulty = isDifficulty(roomSnap.data()?.difficulty) ? roomSnap.data()!.difficulty : DEFAULT_DIFFICULTY;
  const playersSnap = await roomRef.collection('players').get();
  const others = playersSnap.docs
    .filter(d => d.id !== uid)
    .map(d => String(d.data()?.currentWord ?? randomSeedWord()));
  const startWord = existingPlayer.exists
    ? String(existingPlayer.data()?.currentWord ?? randomSeedWord()).toLowerCase()
    : await pickJoinCurrentWord(others, targetWord);
  const used = dedupUsed((existingPlayer.data()?.usedOptionWords ?? []) as string[]);
  const moves = existingPlayer.data()?.movesThisRound ?? 0;
  const move = await embeddingNextMove({
    db: db(),
    currentWord: startWord,
    targetWord,
    excludeWords: used,
    movesThisRound: moves,
    difficulty: roomDifficulty,
  });
  const batch = db().batch();
  batch.set(
    playerRef,
    {
      currentWord: move.currentWord,
      options: move.options,
      usedOptionWords: used,
      movesThisRound: moves,
      joinedAt:
        existingPlayer.data()?.joinedAt ?? admin.firestore.FieldValue.serverTimestamp(),
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );
  batch.set(
    roomRef,
    {
      memberIds: admin.firestore.FieldValue.arrayUnion(uid),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );
  await batch.commit();
  return {ok: true};
});

export const submitMove = onCall({region: REGION}, async request => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const roomId = request.data?.roomId as string | undefined;
  const nextWordRaw = request.data?.nextWord as string | undefined;
  if (!roomId || !nextWordRaw) {
    throw new HttpsError('invalid-argument', 'roomId and nextWord required');
  }
  let nextWord: string;
  try {
    assertAllowedWord(nextWordRaw);
    nextWord = nextWordRaw.trim().toLowerCase();
  } catch (e) {
    throw new HttpsError('invalid-argument', String(e));
  }

  const roomRef = db().collection('rooms').doc(roomId);
  const roundRef = roomRef.collection('rounds').doc('current');
  const playerRef = roomRef.collection('players').doc(uid);

  const [roundSnap, playerSnap, roomSnap] = await Promise.all([roundRef.get(), playerRef.get(), roomRef.get()]);
  if (!roundSnap.exists || !playerSnap.exists) {
    throw new HttpsError('failed-precondition', 'Join room first');
  }
  const roomDifficulty: Difficulty = isDifficulty(roomSnap.data()?.difficulty) ? roomSnap.data()!.difficulty : DEFAULT_DIFFICULTY;
  const round = roundSnap.data()!;
  const phase = String(round.phase ?? 'active');
  const targetWord = String(round.targetWord ?? 'ocean').toLowerCase();
  const roundSeq = Number(round.roundSeq ?? 1);
  const p = playerSnap.data()!;
  const opts = (p.options as string[] | undefined)?.map(o => o.toLowerCase()) ?? [];
  if (opts.length !== 4 || !opts.includes(nextWord)) {
    throw new HttpsError('failed-precondition', 'Invalid pick');
  }
  const prevUsed = ((p.usedOptionWords ?? []) as string[]).map(x => String(x).toLowerCase());
  const usedAfterPick = dedupUsed(uniqLower([...prevUsed, nextWord]));
  const reached = nextWord === targetWord;
  const movesThisRound = Number(p.movesThisRound ?? 0) + 1;
  const cosineDist = await computeCosineDist(db(), nextWord, targetWord);

  const ends = round.phaseEndsAt as admin.firestore.Timestamp | undefined;
  if (phase === 'finish_window' && ends && ends.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Call finalizeFinishWindow first');
  }
  // The 3-sec results barrier — nobody can play during this window.
  if (phase === 'results') {
    throw new HttpsError('failed-precondition', 'Round results — wait for next round');
  }

  let engineMove: Awaited<ReturnType<typeof embeddingNextMove>>;
  let roundPatch: Record<string, unknown> | null = null;

  // Snap bonus: if player picks the target word within 1.5s of seeing options
  const lastPickTs = p.lastPickAt as admin.firestore.Timestamp | undefined;
  const pickDeltaMs = lastPickTs ? Date.now() - lastPickTs.toMillis() : 99999;
  const SNAP_THRESHOLD_MS = 1500;
  const isSnap = reached && pickDeltaMs <= SNAP_THRESHOLD_MS;

  if (phase === 'active') {
    if (reached) {
      engineMove = await embeddingNextMove({
        db: db(),
        currentWord: nextWord,
        targetWord,
        excludeWords: [],
        movesThisRound,
        difficulty: roomDifficulty,
      });

      const playersSnap = await roomRef.collection('players').get();
      let closestDist = 1;
      for (const ps of playersSnap.docs) {
        if (ps.id === uid) continue;
        const cw = String(ps.data()?.currentWord ?? '').toLowerCase();
        if (!cw) continue;
        const d = await computeCosineDist(db(), cw, targetWord);
        closestDist = Math.min(closestDist, d);
      }
      const proximityFactor = Math.max(0, 1 - closestDist);
      // Photo-finish window: min 3s (covers Cloud Function cold-start + finalize
      // round-trip so the results popup arrives feeling crisp, not stuck), max
      // 4.5s when other players are very close to target. See AGENTS.md
      // §Round phase machine — "finish_window length budget".
      const windowMs = Math.round(Math.max(3000, Math.min(4500, 3000 + 1500 * proximityFactor)));

      // Freeze the round's participant set at the instant finish_window
      // starts. The Elo math (computeRoundDeltas) reads from this list
      // instead of the live memberIds so that a winner who taps Back
      // during the 3s window (which fires `leaveRoom` and prunes them
      // from memberIds) is still credited for the round. Critical for
      // solo global rounds — the lone winner has no popup to wait on
      // and routinely exits before maybeFinalize succeeds; without this
      // snapshot the ghost finalizer ran with allPlayerUids=[], wrote
      // no rows, and roundsPlayed/Elo never advanced. Mirrors the same
      // "frozen at finish_window" contract that already applies to
      // primaryWinnerUid / windowFinishers / winnerMoves / winnerSnap.
      //
      // CRITICAL: filter `liveMemberIds` to players whose `lastSeenAt`
      // is within `ACTIVE_PRESENCE_MS`. Without this, a player who
      // backgrounded or force-quit the app (no React unmount, so no
      // `leaveRoom` callable, so still in memberIds) was counted as a
      // loser in the Elo math whenever someone else won — a real Elo
      // grief vector. The winner is always included (they just
      // submitted, so they're trivially present, but the playersSnap
      // we read above is from *before* this transaction so their
      // `lastSeenAt` on it is still the previous heartbeat).
      const liveMemberIds = (roomSnap.data()?.memberIds ?? []) as string[];
      const presenceNow = Date.now();
      const freshPresenceIds = new Set<string>();
      for (const ps of playersSnap.docs) {
        if (!ps.exists) continue;
        const ls = ps.data()?.lastSeenAt as admin.firestore.Timestamp | undefined;
        if (ls && presenceNow - ls.toMillis() < ACTIVE_PRESENCE_MS) {
          freshPresenceIds.add(ps.id);
        }
      }
      freshPresenceIds.add(uid);
      const finishWindowMemberIds = liveMemberIds.filter(m =>
        freshPresenceIds.has(m),
      );
      if (!finishWindowMemberIds.includes(uid)) {
        finishWindowMemberIds.push(uid);
      }

      roundPatch = {
        phase: 'finish_window',
        phaseEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + windowMs),
        primaryWinnerUid: uid,
        windowFinishers: [] as string[],
        winnerMoves: movesThisRound,
        winnerSnap: isSnap,
        finishWindowMemberIds,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    } else {
      engineMove = await embeddingNextMove({
        db: db(),
        currentWord: nextWord,
        targetWord,
        excludeWords: usedAfterPick,
        movesThisRound,
        difficulty: roomDifficulty,
      });
    }
  } else if (phase === 'finish_window') {
    if (!ends || ends.toMillis() <= Date.now()) {
      throw new HttpsError('failed-precondition', 'Call finalizeFinishWindow first');
    }
    const fin = [...((round.windowFinishers as string[] | undefined) ?? [])];
    if (reached && !fin.includes(uid) && round.primaryWinnerUid !== uid) {
      fin.push(uid);
    }
    roundPatch = {
      windowFinishers: fin,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    engineMove = await embeddingNextMove({
      db: db(),
      currentWord: nextWord,
      targetWord,
      excludeWords: reached ? dedupUsed(uniqLower([...prevUsed, nextWord])) : usedAfterPick,
      movesThisRound,
      difficulty: roomDifficulty,
    });
  } else {
    throw new HttpsError('failed-precondition', 'Bad phase');
  }

  let usedOut: string[];
  if (phase === 'active' && reached) {
    usedOut = [];
  } else if (phase === 'finish_window' && reached) {
    usedOut = dedupUsed(uniqLower([...prevUsed, nextWord]));
  } else {
    usedOut = usedAfterPick;
  }

  const playerPatch = {
    currentWord: engineMove.currentWord,
    options: engineMove.options,
    usedOptionWords: usedOut,
    movesThisRound: admin.firestore.FieldValue.increment(1),
    cosineDist: reached ? 0 : cosineDist,
    lastPickAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await db().runTransaction(async tx => {
    const [r2, p2] = await Promise.all([tx.get(roundRef), tx.get(playerRef)]);
    if (!r2.exists || !p2.exists) {
      throw new HttpsError('failed-precondition', 'Stale room');
    }
    const curOpts = (p2.data()?.options as string[] | undefined)?.map(o => o.toLowerCase()) ?? [];
    if (curOpts.length !== 4 || !curOpts.includes(nextWord)) {
      throw new HttpsError('failed-precondition', 'Options changed; retry');
    }
    const rPhase = String(r2.data()?.phase ?? 'active');
    if (rPhase !== phase) {
      throw new HttpsError('failed-precondition', 'Phase changed; retry');
    }
    const rTarget = String(r2.data()?.targetWord ?? '').toLowerCase();
    if (rTarget !== targetWord) {
      throw new HttpsError('failed-precondition', 'Target changed; retry');
    }
    const rSeq = Number(r2.data()?.roundSeq ?? 1);
    if (rSeq !== roundSeq) {
      throw new HttpsError('failed-precondition', 'Round advanced; retry');
    }
    tx.set(playerRef, playerPatch, {merge: true});
    if (roundPatch) {
      tx.set(roundRef, roundPatch, {merge: true});
    }
  });

  return {ok: true};
});

// finalizeFinishWindow: closes the photo-finish window and transitions the
// room to the `results` phase — a 3-sec server-enforced sync barrier where
// every online player sees the same results popup and nobody can submit moves.
// Rewards are applied here so per-player Elo deltas are committed before any
// client renders them. The round target/options DO NOT change here; that
// happens in `advanceRound` after the results barrier expires.
export const finalizeFinishWindow = onCall({region: REGION}, async request => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const roomId = request.data?.roomId as string | undefined;
  if (!roomId) {
    throw new HttpsError('invalid-argument', 'roomId required');
  }
  const roomRef = db().collection('rooms').doc(roomId);
  const roundRef = roomRef.collection('rounds').doc('current');
  const [roomSnap, roundSnap] = await Promise.all([roomRef.get(), roundRef.get()]);
  if (!roundSnap.exists) {
    return {transitioned: false};
  }
  const round = roundSnap.data()!;
  if (round.phase !== 'finish_window') {
    return {transitioned: false, phase: round.phase};
  }
  const ends = round.phaseEndsAt as admin.firestore.Timestamp | undefined;
  if (!ends || ends.toMillis() > Date.now()) {
    return {transitioned: false, waiting: true, endsAtMillis: ends?.toMillis() ?? null};
  }

  const beforeSeq = Number(round.roundSeq ?? 1);
  const memberIds = (roomSnap.data()?.memberIds ?? []) as string[];
  const roomMode = String(roomSnap.data()?.mode ?? 'private');
  const isRanked = roomMode === 'global';
  const oldTarget = String(round.targetWord).toLowerCase();
  const primaryWinnerUid = (round.primaryWinnerUid as string | null) ?? null;
  const windowFinishers = (round.windowFinishers as string[] | undefined) ?? [];
  const winnerMoves = typeof round.winnerMoves === 'number' ? round.winnerMoves : null;
  const winnerSnap = !!round.winnerSnap;
  // Use the participant set frozen when finish_window started (see
  // submitMove §finishWindowMemberIds). Falls back to live memberIds
  // for legacy rounds in flight at deploy time. We additionally union
  // in primaryWinnerUid + windowFinishers as a defensive guard against
  // any pre-snapshot rounds where the winner had already left
  // memberIds before this code shipped.
  const frozenIds = (round.finishWindowMemberIds as string[] | undefined) ?? memberIds;
  const participantSet = new Set<string>(frozenIds);
  if (primaryWinnerUid) participantSet.add(primaryWinnerUid);
  for (const f of windowFinishers) participantSet.add(f);
  const allPlayerUids = Array.from(participantSet);

  // Pre-compute Elo deltas BEFORE the CAS so we can embed them in the
  // same `results` blob the popup reads from. Without this the popup
  // would render `delta=0` for ~500ms until `lastRoundDelta` was
  // written to the player docs, then jitter to the real value. See
  // KB §results-popup-must-render-correct-elo-on-first-frame.
  //
  // Skipped entirely for non-ranked (private) rooms — the popup
  // renders a "PRACTICE" label there and does not consult the deltas.
  const deltasComputation = isRanked
    ? await computeRoundDeltas({
        primaryWinnerUid,
        windowFinisherUids: windowFinishers,
        allPlayerUids,
        winnerMoves,
        winnerSnap,
      })
    : {rows: [], deltaMap: {}, roundsAfterMap: {}};

  // Try to claim the transition with a CAS — only one client/job succeeds.
  const expectedEnds = ends.toMillis();
  const claimed = await db().runTransaction(async tx => {
    const r = await tx.get(roundRef);
    const d = r.data();
    if (!d || d.phase !== 'finish_window') return false;
    const pe = d.phaseEndsAt as admin.firestore.Timestamp | undefined;
    if (!pe || pe.toMillis() !== expectedEnds) return false;
    tx.set(
      roundRef,
      {
        phase: 'results',
        phaseEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + RESULTS_BARRIER_MS),
        // The popup renders entirely from this blob — including the
        // Elo deltas — so it shows correct numbers on its very first
        // frame. The user-stat side-effects (winStreak, dailyStreak,
        // updated ratingElo on users/{uid}) are committed in parallel
        // below; the popup doesn't depend on them.
        // For private rooms we still write the blob (so the popup
        // appears) but with `ranked: false` and an empty deltas map —
        // the client renders a "PRACTICE" affordance instead of an
        // Elo number.
        results: {
          targetWord: oldTarget,
          primaryWinnerUid,
          windowFinishers,
          winnerMoves,
          winnerSnap,
          completedSeq: beforeSeq,
          deltas: deltasComputation.deltaMap,
          // Per-uid post-this-round count of completed rounds, used by
          // the client to render the placement banner ("Calibrating
          // N/5") instead of the Elo numeral when the player is still
          // inside their first PLACEMENT_TOTAL_ROUNDS rounds. Embedded
          // here so the popup's first frame shows the correct surface
          // — gating on profile.roundsPlayed flickers because the
          // user-doc listener lags the round-doc listener by ~200ms.
          roundsAfter: deltasComputation.roundsAfterMap,
          ranked: isRanked,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    return true;
  });

  if (!claimed) {
    return {transitioned: false, raced: true};
  }

  // The phase=results snapshot has now fanned out — every client's results
  // popup is animating in WITH correct deltas. We have ~RESULTS_BARRIER_MS
  // milliseconds of breathing room before `advanceRound` fires. Use that
  // window to:
  //   1. Commit reward side-effects (user docs, lastRoundDelta on player
  //      docs, analytics) — idempotent via rewardLocks.
  //   2. Pre-compute the next round (target + per-player options) and
  //      stash it on the round doc as `nextRoundPrecomputed`. Then
  //      `advanceRound` becomes a fast CAS-only write — no embedding
  //      reads on the critical path between the popup countdown hitting 0
  //      and the new target appearing.
  // History writing is fire-and-forget — it's non-essential.
  const advDifficulty: Difficulty = isDifficulty(roomSnap.data()?.difficulty)
    ? (roomSnap.data()!.difficulty as Difficulty)
    : DEFAULT_DIFFICULTY;
  await Promise.all([
    commitRoundDeltas({
      roomId,
      roundSeq: beforeSeq,
      rows: deltasComputation.rows,
    }),
    precomputeNextRound({
      roomRef,
      roundRef,
      memberIds,
      oldTarget,
      difficulty: advDifficulty,
      forSeq: beforeSeq,
    }),
  ]);

  // History (fire-and-forget).
  const seedWord = randomSeedWord();
  findShortestPath(db(), seedWord, oldTarget)
    .then(async optimalPath => {
      if (!optimalPath) return;
      await roundRef.collection('history').doc(String(beforeSeq)).set({
        targetWord: oldTarget,
        optimalPath,
        optimalMoves: optimalPath.length - 1,
        winnerMoves,
        winnerSnap,
        primaryWinnerUid,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    })
    .catch(() => {});

  return {transitioned: true, phase: 'results'};
});

// Pre-computes the next round's target + per-player options and writes them
// onto the round doc as `nextRoundPrecomputed`. Called from
// `finalizeFinishWindow` so the work happens during the 3s results barrier
// (while players are looking at the popup) instead of after the barrier
// expires (when players are waiting for the new round to start).
//
// Idempotent: keyed by `forSeq` so repeated calls during the same results
// phase don't double-write.
async function precomputeNextRound(args: {
  roomRef: admin.firestore.DocumentReference;
  roundRef: admin.firestore.DocumentReference;
  memberIds: string[];
  oldTarget: string;
  difficulty: Difficulty;
  forSeq: number;
}): Promise<void> {
  const {roomRef, roundRef, memberIds, oldTarget, difficulty, forSeq} = args;
  try {
    const newTarget = await pickNextTargetWord({
      currentWord: oldTarget,
      avoidTarget: oldTarget,
      db: db(),
    });
    const playerSnaps = await Promise.all(
      memberIds.map(id => roomRef.collection('players').doc(id).get()),
    );
    const perPlayer = await Promise.all(
      playerSnaps.map(async ps => {
        if (!ps.exists) return null;
        const cw = String(ps.data()?.currentWord ?? randomSeedWord()).toLowerCase();
        const move = await embeddingNextMove({
          db: db(),
          currentWord: cw,
          targetWord: newTarget,
          excludeWords: [],
          movesThisRound: 0,
          difficulty,
        });
        return {uid: ps.id, currentWord: move.currentWord, options: move.options};
      }),
    );
    await roundRef.set(
      {
        nextRoundPrecomputed: {
          forSeq,
          targetWord: newTarget,
          perPlayer: perPlayer.filter((x): x is NonNullable<typeof x> => x !== null),
          computedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      },
      {merge: true},
    );
  } catch (e) {
    // Swallow — `advanceRound` falls back to computing on the critical path.
    console.warn('precomputeNextRound failed', e);
  }
}

// advanceRound: closes the `results` barrier and starts the next round —
// picks a new target, computes new options for every player, increments
// roundSeq. Triggered by any client whose results countdown reached 0; the
// CAS on phaseEndsAt ensures only one call wins. The phase flip from
// `results` → `active` is the moment all clients perceive as "next round
// starts now", because Firestore delivers the snapshot atomically.
export const advanceRound = onCall({region: REGION}, async request => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const roomId = request.data?.roomId as string | undefined;
  if (!roomId) {
    throw new HttpsError('invalid-argument', 'roomId required');
  }
  const roomRef = db().collection('rooms').doc(roomId);
  const roundRef = roomRef.collection('rounds').doc('current');
  const [roomSnap, roundSnap] = await Promise.all([roomRef.get(), roundRef.get()]);
  if (!roundSnap.exists) {
    return {advanced: false};
  }
  const round = roundSnap.data()!;
  if (round.phase !== 'results') {
    return {advanced: false, phase: round.phase};
  }
  const ends = round.phaseEndsAt as admin.firestore.Timestamp | undefined;
  if (!ends || ends.toMillis() > Date.now()) {
    return {advanced: false, waiting: true, endsAtMillis: ends?.toMillis() ?? null};
  }

  const advDifficulty: Difficulty = isDifficulty(roomSnap.data()?.difficulty)
    ? (roomSnap.data()!.difficulty as Difficulty)
    : DEFAULT_DIFFICULTY;
  const memberIds = (roomSnap.data()?.memberIds ?? []) as string[];
  const oldTarget = String(round.targetWord).toLowerCase();
  const beforeSeq = Number(round.roundSeq ?? 1);

  // Fast path: `finalizeFinishWindow` should have stashed pre-computed
  // next-round data on the round doc during the results barrier. If so,
  // this callable becomes a single CAS write — no embedding reads on the
  // critical path between countdown==0 and the new target appearing.
  type PrecomputedRow = {
    uid: string;
    currentWord: string;
    options: [string, string, string, string];
  };
  const cached = round.nextRoundPrecomputed as
    | {forSeq?: number; targetWord?: string; perPlayer?: PrecomputedRow[]}
    | undefined;
  let newTarget: string;
  let perPlayer: PrecomputedRow[];
  if (
    cached &&
    cached.forSeq === beforeSeq &&
    typeof cached.targetWord === 'string' &&
    Array.isArray(cached.perPlayer) &&
    cached.perPlayer.length > 0
  ) {
    newTarget = cached.targetWord;
    perPlayer = cached.perPlayer;
  } else {
    // Fallback path (precomputation didn't run or raced): do it now.
    newTarget = await pickNextTargetWord({
      currentWord: oldTarget,
      avoidTarget: oldTarget,
      db: db(),
    });
    const playerSnaps = await Promise.all(
      memberIds.map(id => roomRef.collection('players').doc(id).get()),
    );
    perPlayer = (
      await Promise.all(
        playerSnaps.map(async ps => {
          if (!ps.exists) return null;
          const cw = String(ps.data()?.currentWord ?? randomSeedWord()).toLowerCase();
          const move = await embeddingNextMove({
            db: db(),
            currentWord: cw,
            targetWord: newTarget,
            excludeWords: [],
            movesThisRound: 0,
            difficulty: advDifficulty,
          });
          return {uid: ps.id, currentWord: move.currentWord, options: move.options};
        }),
      )
    ).filter((x): x is PrecomputedRow => x !== null);
  }

  const expectedEnds = ends.toMillis();
  const advanced = await db().runTransaction(async tx => {
    const r = await tx.get(roundRef);
    const d = r.data();
    if (!d || d.phase !== 'results') return false;
    const pe = d.phaseEndsAt as admin.firestore.Timestamp | undefined;
    if (!pe || pe.toMillis() !== expectedEnds) return false;

    for (const row of perPlayer) {
      const ref = roomRef.collection('players').doc(row.uid);
      tx.set(
        ref,
        {
          currentWord: row.currentWord,
          options: row.options,
          usedOptionWords: [],
          movesThisRound: 0,
          // lastRoundDelta intentionally NOT cleared — clients keep the
          // last delta visible on the stats bar until the next round ends.
          lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
    }
    tx.set(
      roundRef,
      {
        targetWord: newTarget,
        phase: 'active',
        phaseEndsAt: null,
        roundSeq: admin.firestore.FieldValue.increment(1),
        primaryWinnerUid: null,
        windowFinishers: [] as string[],
        winnerMoves: admin.firestore.FieldValue.delete(),
        winnerSnap: admin.firestore.FieldValue.delete(),
        results: admin.firestore.FieldValue.delete(),
        nextRoundPrecomputed: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    return true;
  });

  return {advanced, newTarget: advanced ? newTarget : undefined};
});

export const heartbeat = onCall({region: REGION}, async request => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const roomId = request.data?.roomId as string | undefined;
  if (!roomId) {
    throw new HttpsError('invalid-argument', 'roomId required');
  }
  const playerRef = db().collection('rooms').doc(roomId).collection('players').doc(uid);
  await playerRef.set(
    {lastSeenAt: admin.firestore.FieldValue.serverTimestamp()},
    {merge: true},
  );
  return {ok: true};
});

export const assignGlobalRoom = onCall({region: REGION}, async request => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const uid = request.auth.uid;
  const {roomId, shardIndex} = await assignGlobalRoomId(db(), uid);
  return {roomId, shardIndex};
});

// ---------------------------------------------------------------------------
// Room lifecycle: explicit leave + cascade delete
// ---------------------------------------------------------------------------
//
// Private rooms are short-lived practice/friend lobbies. They should not
// outlive the players inside them. When the LAST player leaves a private
// room (either explicitly via `leaveRoom`, or implicitly via the
// `ghostFinalizer` reaper for crashed/backgrounded clients), the room is
// cascade-deleted: its `players/*`, `rounds/*`, and `rewardLocks/{room}_*`
// docs are wiped along with the room doc itself.
//
// Global rooms (`mode === 'global'`) are EXEMPT from cascade delete at every
// layer. They're shared infrastructure — assigned by `assignGlobalRoom`,
// driven by the scheduled finalizer, and keep their seq running across
// player turnover. A global room can have all its players leave; the next
// player who joins picks up where the round left off.
//
// Source of truth for the deletion policy: §Room lifecycle in AGENTS.md.

/**
 * Cascade-delete a private room and all of its subcollection state.
 * Idempotent — safe to call on an already-deleted room (just no-ops).
 *
 * Uses two batches because Firestore caps batches at 500 ops; with a few
 * players + rounds (`current` only, in our schema) + a handful of
 * `rewardLocks` per round, we comfortably fit in two batches even for the
 * busiest room.
 *
 * Caller is responsible for confirming `mode === 'private'` BEFORE calling
 * this function. We re-assert it here as a guard so a misuse never wipes a
 * global room.
 */
async function deletePrivateRoomCascade(
  roomRef: FirebaseFirestore.DocumentReference,
): Promise<void> {
  const roomSnap = await roomRef.get();
  if (!roomSnap.exists) return;
  if (String(roomSnap.data()?.mode ?? 'private') === 'global') {
    console.warn('refusing to cascade-delete global room', roomRef.id);
    return;
  }

  const roomId = roomRef.id;
  const [playersSnap, roundsSnap, locksSnap] = await Promise.all([
    roomRef.collection('players').get(),
    roomRef.collection('rounds').get(),
    // Range-query `rewardLocks` by doc-ID prefix `${roomId}_` — locks are
    // keyed `${roomId}_${roundSeq}`. The `~` upper bound is the highest
    // printable ASCII char so it captures every numeric suffix.
    db()
      .collection('rewardLocks')
      .where(admin.firestore.FieldPath.documentId(), '>=', `${roomId}_`)
      .where(admin.firestore.FieldPath.documentId(), '<', `${roomId}_~`)
      .get(),
  ]);

  const batch = db().batch();
  for (const d of playersSnap.docs) batch.delete(d.ref);
  for (const d of roundsSnap.docs) batch.delete(d.ref);
  for (const d of locksSnap.docs) batch.delete(d.ref);
  batch.delete(roomRef);
  await batch.commit();
}

// Exposed for the scheduler so it can use the same cascade path.
export {deletePrivateRoomCascade};

export const leaveRoom = onCall({region: REGION}, async request => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const roomId = request.data?.roomId as string | undefined;
  if (!roomId) {
    throw new HttpsError('invalid-argument', 'roomId required');
  }
  const roomRef = db().collection('rooms').doc(roomId);

  // Phase 1 — atomic membership update inside a transaction. Returns
  // `true` if we just removed the last member of a PRIVATE room (caller
  // then runs the cascade outside the transaction). Returns `false` if
  // the room is global (always retained), if other members remain, or if
  // the room is already gone.
  const wasLastInPrivate = await db().runTransaction(async tx => {
    const snap = await tx.get(roomRef);
    if (!snap.exists) return false;
    const data = snap.data()!;
    const mode = String(data.mode ?? 'private');
    const memberIds = (data.memberIds ?? []) as string[];
    const remaining = memberIds.filter(m => m !== uid);
    const playerRef = roomRef.collection('players').doc(uid);

    if (mode === 'global') {
      // Global rooms: drop our membership + player presence, but never
      // delete the room. The next player who joins inherits whatever
      // round state was live.
      tx.update(roomRef, {
        memberIds: remaining,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      tx.delete(playerRef);
      return false;
    }

    if (remaining.length === 0) {
      // We're the last one. Don't write the membership update — let the
      // cascade tear the whole room down outside the transaction.
      return true;
    }

    tx.update(roomRef, {
      memberIds: remaining,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.delete(playerRef);
    return false;
  });

  if (wasLastInPrivate) {
    try {
      await deletePrivateRoomCascade(roomRef);
    } catch (e) {
      // Log but don't throw — the client doesn't care if the cascade
      // fully completed; the next reaper run is the safety net.
      console.warn('leaveRoom cascade failed', roomId, e);
    }
  }

  return {ok: true};
});

// Delete the caller's account: removes the user's entire footprint and
// the Firebase Auth record atomically. Apple App Review 5.1.1(v)
// compliance for guest/anonymous accounts.
//
// MUST be a server callable (not a client-side delete) because
// firestore.rules disallows client deletes on `users/{uid}` and any
// writes to `publicProfiles/{uid}` (both are server-managed surfaces).
// Earlier client-side attempts hit permission-denied silently between
// `Promise.allSettled`, then `auth.delete()` succeeded, leaving orphan
// docs and a torn-down auth context that crashed open listeners.
//
// What gets deleted:
//   - `users/{uid}`            — private profile, ratingElo, streaks, etc.
//   - `publicProfiles/{uid}`   — explicitly here, AND the
//     `syncPublicProfile` Firestore trigger removes it again on the
//     `users/{uid}` delete event. Idempotent: double-deleting a doc
//     that doesn't exist is a no-op in Firestore.
//   - `rooms/{*}/players/{uid}` for every room the user is in —
//     best-effort cleanup of presence so the leaderboard / roster on
//     other players' screens drops the deleted player immediately.
//     Found via `where(memberIds array-contains uid)` on `rooms`,
//     which uses Firestore's automatic single-field index (no
//     `firestore.indexes.json` change needed).
//   - The Firebase Auth user record (`admin.auth().deleteUser`).
//     After this resolves, the client's auth token is invalid; the
//     client should call `auth().signOut()` locally to flip its
//     `onAuthStateChanged` immediately and trigger re-anon-sign-in.
//
// What doesn't get deleted (intentional):
//   - `memberIds` arrays on rooms still containing the deleted uid —
//     surgically removing per-room would require a transaction per
//     room; the user is gone, the heartbeat reaper will clean it up.
//   - Past `rounds/{seq}.results.deltas.{uid}` blobs — event/log
//     data, not UGC. chess.com / League of Legends post-deletion
//     convention. App Review accepts retention of operational logs.
export const deleteAccount = onCall({region: REGION}, async request => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }

  // 1. Find every room where the user is currently a member, so we can
  // delete their `players/{uid}` presence doc in each. Best-effort: if
  // the query fails (transient Firestore error), we still proceed with
  // the user/auth deletes — the heartbeat reaper will sweep stale
  // player docs eventually.
  let playerRefs: FirebaseFirestore.DocumentReference[] = [];
  try {
    const roomsSnap = await db()
      .collection('rooms')
      .where('memberIds', 'array-contains', uid)
      .get();
    playerRefs = roomsSnap.docs.map(r =>
      r.ref.collection('players').doc(uid),
    );
  } catch (e) {
    console.warn('deleteAccount: room sweep failed', uid, e);
  }

  // 2. Atomic Firestore batch — user doc, public profile, all player
  // presence docs. The `syncPublicProfile` trigger will fire on the
  // `users/{uid}` delete and re-attempt the publicProfile delete (no-op
  // if already gone). Batches in Firestore admin SDK can hold up to 500
  // operations; in practice a user is in <10 rooms at once so this is
  // far below the cap.
  const batch = db().batch();
  batch.delete(db().collection('users').doc(uid));
  batch.delete(db().collection('publicProfiles').doc(uid));
  for (const ref of playerRefs) batch.delete(ref);
  try {
    await batch.commit();
  } catch (e) {
    console.warn('deleteAccount: firestore batch failed', uid, e);
    throw new HttpsError(
      'internal',
      'Failed to delete account data. Try again.',
    );
  }

  // 3. Delete the Firebase Auth user. If this fails the user can still
  // see they have no docs (effectively reset) but their auth identity
  // lingers — the next AuthProvider boot will reuse the same uid,
  // useUserProfile will see no doc, NavigationGate will route to /name
  // and the user will be prompted to re-onboard. Acceptable degraded
  // state, but log loudly so we can investigate.
  try {
    await admin.auth().deleteUser(uid);
  } catch (e) {
    console.warn('deleteAccount: auth.deleteUser failed', uid, e);
  }

  return {ok: true};
});
