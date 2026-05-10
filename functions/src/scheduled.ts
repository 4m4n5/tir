import * as admin from 'firebase-admin';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {deletePrivateRoomCascade} from './callables';
import {DEFAULT_DIFFICULTY, isDifficulty} from './difficulty';
import type {Difficulty} from './difficulty';
import {embeddingNextMove, randomSeedWord} from './embeddingNeighbor';
import {commitRoundDeltas, computeRoundDeltas} from './rewards';
import {pickNextTargetWord} from './stub';

const REGION = 'us-central1';
const STALE_PRESENCE_MS = 60_000;
const RESULTS_BARRIER_MS = 3000;
// Grace period applied on top of phaseEndsAt before the ghost job intervenes.
// Live clients normally drive transitions within ~600ms of phaseEndsAt; the
// scheduler is the safety net for rooms with no active client.
const GHOST_GRACE_MS = 4_000;

// How long a private room must have been idle (no player heartbeats inside
// the staleness window) before the reaper deletes it. Set generously to
// 5 minutes so a brief app backgrounding (lock screen, switching apps,
// dropped network) doesn't nuke a room out from under the user. Explicit
// `leaveRoom` calls from the client cascade-delete immediately; this only
// catches abandoned rooms (host crashed at create, all players force-quit,
// network died mid-session).
const ROOM_REAPER_STALE_MS = 5 * 60 * 1000;

function db() {
  return admin.firestore();
}

async function closeFinishWindow(
  roundRef: FirebaseFirestore.DocumentReference,
  roomRef: FirebaseFirestore.DocumentReference,
  round: FirebaseFirestore.DocumentData,
  expectedEnds: number,
): Promise<void> {
  const roomDataSnap = await roomRef.get();
  const memberIds = (roomDataSnap.data()?.memberIds ?? []) as string[];
  const roomMode = String(roomDataSnap.data()?.mode ?? 'private');
  const isRanked = roomMode === 'global';
  const roomDifficulty: Difficulty = isDifficulty(roomDataSnap.data()?.difficulty)
    ? (roomDataSnap.data()!.difficulty as Difficulty)
    : DEFAULT_DIFFICULTY;
  const beforeSeq = Number(round.roundSeq ?? 1);
  const oldTarget = String(round.targetWord).toLowerCase();
  const primaryWinnerUid = (round.primaryWinnerUid as string | null) ?? null;
  const windowFinishers = (round.windowFinishers as string[] | undefined) ?? [];
  const winnerMoves = typeof round.winnerMoves === 'number' ? round.winnerMoves : null;
  const winnerSnap = !!round.winnerSnap;
  // Mirror callables.ts §finalizeFinishWindow: use the participant set
  // frozen at finish_window start so a winner who already left
  // memberIds (very common — clients call leaveRoom on unmount) is
  // still credited. Falls back to live memberIds for legacy rounds
  // that pre-date the snapshot field, and unions in winner / finishers
  // as a defensive guard.
  const frozenIds = (round.finishWindowMemberIds as string[] | undefined) ?? memberIds;
  const participantSet = new Set<string>(frozenIds);
  if (primaryWinnerUid) participantSet.add(primaryWinnerUid);
  for (const f of windowFinishers) participantSet.add(f);
  const allPlayerUids = Array.from(participantSet);

  // Pre-compute Elo deltas BEFORE the CAS — same reasoning as the
  // live-client path in callables.ts. Embedded into the results blob so
  // the popup renders correct deltas on its first frame.
  // Skipped for private (practice) rooms — the popup renders a
  // "PRACTICE" label and does not consult the deltas.
  const deltasComputation = isRanked
    ? await computeRoundDeltas({
        primaryWinnerUid,
        windowFinisherUids: windowFinishers,
        allPlayerUids,
        winnerMoves,
        winnerSnap,
      })
    : {rows: [], deltaMap: {}, roundsAfterMap: {}};

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
        results: {
          targetWord: oldTarget,
          primaryWinnerUid,
          windowFinishers,
          winnerMoves,
          winnerSnap,
          completedSeq: beforeSeq,
          deltas: deltasComputation.deltaMap,
          roundsAfter: deltasComputation.roundsAfterMap,
          ranked: isRanked,
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
    return true;
  });

  if (!claimed) return;

  // Mirror the live-client path: commit reward side-effects and pre-compute
  // the next round in parallel so the next scheduler tick (or any client
  // that wakes up) can advance with a fast CAS-only write.
  await Promise.all([
    commitRoundDeltas({
      roomId: roomRef.id,
      roundSeq: beforeSeq,
      rows: deltasComputation.rows,
    }),
    (async () => {
      try {
        const newTarget = await pickNextTargetWord({
          currentWord: oldTarget,
          avoidTarget: oldTarget,
          db: db(),
        });
        const playerSnaps = await Promise.all(
          memberIds.map(id => roomRef.collection('players').doc(id).get()),
        );
        const perPlayer = (
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
                difficulty: roomDifficulty,
              });
              return {uid: ps.id, currentWord: move.currentWord, options: move.options};
            }),
          )
        ).filter(
          (x): x is {uid: string; currentWord: string; options: [string, string, string, string]} =>
            x !== null,
        );
        await roundRef.set(
          {
            nextRoundPrecomputed: {
              forSeq: beforeSeq,
              targetWord: newTarget,
              perPlayer,
              computedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
          },
          {merge: true},
        );
      } catch (e) {
        console.warn('ghost precompute failed', roomRef.id, e);
      }
    })(),
  ]);
}

async function advanceFromResults(
  roundRef: FirebaseFirestore.DocumentReference,
  roomRef: FirebaseFirestore.DocumentReference,
  round: FirebaseFirestore.DocumentData,
  expectedEnds: number,
): Promise<void> {
  const roomSnap = await roomRef.get();
  const difficulty: Difficulty = isDifficulty(roomSnap.data()?.difficulty)
    ? (roomSnap.data()!.difficulty as Difficulty)
    : DEFAULT_DIFFICULTY;
  const memberIds = (roomSnap.data()?.memberIds ?? []) as string[];
  const oldTarget = String(round.targetWord).toLowerCase();
  const beforeSeq = Number(round.roundSeq ?? 1);

  // Reuse precomputed data if `finalizeFinishWindow` already populated it.
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
  let activeMemberIds: string[];
  if (
    cached &&
    cached.forSeq === beforeSeq &&
    typeof cached.targetWord === 'string' &&
    Array.isArray(cached.perPlayer) &&
    cached.perPlayer.length > 0
  ) {
    newTarget = cached.targetWord;
    perPlayer = cached.perPlayer;
    // We still need fresh presence data to prune stale members.
    const playerSnaps = await Promise.all(
      memberIds.map(id => roomRef.collection('players').doc(id).get()),
    );
    const now = Date.now();
    activeMemberIds = [];
    for (const ps of playerSnaps) {
      if (!ps.exists) continue;
      const lastSeen = ps.data()?.lastSeenAt as admin.firestore.Timestamp | undefined;
      if (lastSeen && now - lastSeen.toMillis() < STALE_PRESENCE_MS) {
        activeMemberIds.push(ps.id);
      }
    }
  } else {
    newTarget = await pickNextTargetWord({
      currentWord: oldTarget,
      avoidTarget: oldTarget,
      db: db(),
    });
    const playerSnaps = await Promise.all(
      memberIds.map(id => roomRef.collection('players').doc(id).get()),
    );
    const now = Date.now();
    activeMemberIds = [];
    for (const ps of playerSnaps) {
      if (!ps.exists) continue;
      const lastSeen = ps.data()?.lastSeenAt as admin.firestore.Timestamp | undefined;
      if (lastSeen && now - lastSeen.toMillis() < STALE_PRESENCE_MS) {
        activeMemberIds.push(ps.id);
      }
    }
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
            difficulty,
          });
          return {uid: ps.id, currentWord: move.currentWord, options: move.options};
        }),
      )
    ).filter((x): x is PrecomputedRow => x !== null);
  }

  await db().runTransaction(async tx => {
    const r = await tx.get(roundRef);
    const d = r.data();
    if (!d || d.phase !== 'results') return;
    const pe = d.phaseEndsAt as admin.firestore.Timestamp | undefined;
    if (!pe || pe.toMillis() !== expectedEnds) return;

    for (const row of perPlayer) {
      const ref = roomRef.collection('players').doc(row.uid);
      tx.set(
        ref,
        {
          currentWord: row.currentWord,
          options: row.options,
          usedOptionWords: [],
          movesThisRound: 0,
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

    if (activeMemberIds.length < memberIds.length) {
      tx.set(
        roomRef,
        {
          memberIds: activeMemberIds,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
      );
    }
  });
}

export const ghostFinalizer = onSchedule(
  {schedule: 'every 1 minutes', region: REGION, timeoutSeconds: 60},
  async () => {
    const now = Date.now();

    // Pass 1: stuck finish_window → push to results barrier.
    const stuckFinish = await db()
      .collectionGroup('rounds')
      .where('phase', '==', 'finish_window')
      .get();
    for (const roundDoc of stuckFinish.docs) {
      const round = roundDoc.data();
      const ends = round.phaseEndsAt as admin.firestore.Timestamp | undefined;
      if (!ends || ends.toMillis() + GHOST_GRACE_MS > now) continue;
      const roomRef = roundDoc.ref.parent.parent;
      if (!roomRef) continue;
      try {
        await closeFinishWindow(roundDoc.ref, roomRef, round, ends.toMillis());
      } catch (e) {
        console.error('ghost closeFinishWindow failed', roomRef.id, e);
      }
    }

    // Pass 2: stuck results → advance to next round.
    const stuckResults = await db()
      .collectionGroup('rounds')
      .where('phase', '==', 'results')
      .get();
    for (const roundDoc of stuckResults.docs) {
      const round = roundDoc.data();
      const ends = round.phaseEndsAt as admin.firestore.Timestamp | undefined;
      if (!ends || ends.toMillis() + GHOST_GRACE_MS > now) continue;
      const roomRef = roundDoc.ref.parent.parent;
      if (!roomRef) continue;
      try {
        await advanceFromResults(roundDoc.ref, roomRef, round, ends.toMillis());
      } catch (e) {
        console.error('ghost advanceFromResults failed', roomRef.id, e);
      }
    }

    // Pass 3: reap private rooms with no live presence.
    //
    // A private room is reapable when ALL of these are true:
    //   • mode === 'private' (global rooms are forever)
    //   • either memberIds is empty, OR every member's player doc has a
    //     `lastSeenAt` older than ROOM_REAPER_STALE_MS (5 min)
    //   • the room itself has not been touched (`updatedAt`) within
    //     ROOM_REAPER_STALE_MS — ensures we don't reap a room that was
    //     literally just created by `createPrivateRoom` and whose host
    //     hasn't had time to send their first heartbeat yet
    //
    // The explicit `leaveRoom` callable handles the common case (user
    // taps back); this pass catches abandoned rooms (force-quit,
    // network death, app uninstalled mid-session). Bounded latency:
    // worst case ROOM_REAPER_STALE_MS + reaper interval (1 min) = 6 min.
    const reapCutoff = admin.firestore.Timestamp.fromMillis(
      now - ROOM_REAPER_STALE_MS,
    );
    const privateRooms = await db()
      .collection('rooms')
      .where('mode', '==', 'private')
      .where('updatedAt', '<', reapCutoff)
      .get();
    for (const roomDoc of privateRooms.docs) {
      const memberIds = (roomDoc.data().memberIds ?? []) as string[];
      let reap = memberIds.length === 0;
      if (!reap) {
        const playerSnaps = await Promise.all(
          memberIds.map(uid =>
            roomDoc.ref.collection('players').doc(uid).get(),
          ),
        );
        const anyLive = playerSnaps.some(ps => {
          if (!ps.exists) return false;
          const seen = ps.data()?.lastSeenAt as
            | admin.firestore.Timestamp
            | undefined;
          return seen != null && now - seen.toMillis() < ROOM_REAPER_STALE_MS;
        });
        reap = !anyLive;
      }
      if (!reap) continue;
      try {
        await deletePrivateRoomCascade(roomDoc.ref);
      } catch (e) {
        console.error('reapStaleRoom failed', roomDoc.id, e);
      }
    }
  },
);
