import * as admin from 'firebase-admin';
import {HttpsError, onCall} from 'firebase-functions/v2/https';
import {assertAllowedWord} from './contentPolicy';
import {embeddingNextMove} from './embeddingNeighbor';
import {assignGlobalRoomId} from './globalRooms';
import {applyRoundRewards} from './rewards';
import {pickNextTargetWord, VOCAB} from './stub';

const REGION = 'us-central1';

function db() {
  return admin.firestore();
}

function rankToTarget(w: string, t: string): number {
  const iw = VOCAB.indexOf(w.toLowerCase());
  const it = VOCAB.indexOf(t.toLowerCase());
  const a = iw === -1 ? 15 : iw;
  const b = it === -1 ? 15 : it;
  return Math.abs(a - b);
}

function pickJoinCurrentWord(othersCurrent: string[], targetWord: string): string {
  if (!othersCurrent.length) {
    return 'start';
  }
  const dists = othersCurrent
    .map(o => rankToTarget(o, targetWord))
    .sort((a, b) => a - b);
  const med = dists[Math.floor(dists.length / 2)] ?? 0;
  const want = med + 1 + Math.floor(Math.random() * 2);
  const cands = VOCAB.filter(w => rankToTarget(w, targetWord) >= want);
  return cands[Math.floor(Math.random() * cands.length)] ?? 'start';
}

function uniqLower(words: string[]): string[] {
  return Array.from(new Set(words.map(w => w.toLowerCase())));
}

export const createPrivateRoom = onCall({region: REGION}, async request => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const roomRef = db().collection('rooms').doc();
  const target = 'ocean';
  const move = await embeddingNextMove({
    db: db(),
    currentWord: 'start',
    targetWord: target,
    excludeWords: [],
  });
  const batch = db().batch();
  batch.set(roomRef, {
    mode: 'private',
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    memberIds: [],
  });
  batch.set(roomRef.collection('rounds').doc('current'), {
    targetWord: target,
    phase: 'active',
    phaseEndsAt: null,
    roundSeq: 1,
    primaryWinnerUid: null,
    windowFinishers: [] as string[],
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();
  return {roomId: roomRef.id, targetWord: target, options: move.options};
});

export const joinPrivateRoom = onCall({region: REGION}, async request => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const roomId = request.data?.roomId as string | undefined;
  if (!roomId) {
    throw new HttpsError('invalid-argument', 'roomId required');
  }
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
  const playersSnap = await roomRef.collection('players').get();
  const others = playersSnap.docs
    .filter(d => d.id !== uid)
    .map(d => String(d.data()?.currentWord ?? 'start'));
  const startWord = existingPlayer.exists
    ? String(existingPlayer.data()?.currentWord ?? 'start').toLowerCase()
    : pickJoinCurrentWord(others, targetWord);
  const used = (existingPlayer.data()?.usedOptionWords ?? []) as string[];
  const move = await embeddingNextMove({
    db: db(),
    currentWord: startWord,
    targetWord,
    excludeWords: used,
  });
  const batch = db().batch();
  batch.set(
    playerRef,
    {
      currentWord: move.currentWord,
      options: move.options,
      usedOptionWords: used,
      movesThisRound: existingPlayer.data()?.movesThisRound ?? 0,
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

  const [roundSnap, playerSnap] = await Promise.all([roundRef.get(), playerRef.get()]);
  if (!roundSnap.exists || !playerSnap.exists) {
    throw new HttpsError('failed-precondition', 'Join room first');
  }
  const round = roundSnap.data()!;
  const phase = String(round.phase ?? 'active');
  const targetWord = String(round.targetWord ?? 'ocean').toLowerCase();
  const p = playerSnap.data()!;
  const opts = (p.options as string[] | undefined)?.map(o => o.toLowerCase()) ?? [];
  if (opts.length !== 4 || !opts.includes(nextWord)) {
    throw new HttpsError('failed-precondition', 'Invalid pick');
  }
  const prevUsed = ((p.usedOptionWords ?? []) as string[]).map(x => String(x).toLowerCase());
  const usedAfterPick = uniqLower([...prevUsed, nextWord]);
  const reached = nextWord === targetWord;

  const ends = round.phaseEndsAt as admin.firestore.Timestamp | undefined;
  if (phase === 'finish_window' && ends && ends.toMillis() <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Call finalizeFinishWindow first');
  }

  let engineMove: Awaited<ReturnType<typeof embeddingNextMove>>;
  let roundPatch: Record<string, unknown> | null = null;

  if (phase === 'active') {
    if (reached) {
      engineMove = await embeddingNextMove({
        db: db(),
        currentWord: nextWord,
        targetWord,
        excludeWords: [],
      });
      roundPatch = {
        phase: 'finish_window',
        phaseEndsAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3000),
        primaryWinnerUid: uid,
        windowFinishers: [] as string[],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
    } else {
      engineMove = await embeddingNextMove({
        db: db(),
        currentWord: nextWord,
        targetWord,
        excludeWords: usedAfterPick,
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
      excludeWords: reached ? uniqLower([...prevUsed, nextWord]) : usedAfterPick,
    });
  } else {
    throw new HttpsError('failed-precondition', 'Bad phase');
  }

  let usedOut: string[];
  if (phase === 'active' && reached) {
    usedOut = [];
  } else if (phase === 'finish_window' && reached) {
    usedOut = uniqLower([...prevUsed, nextWord]);
  } else {
    usedOut = usedAfterPick;
  }

  const playerPatch = {
    currentWord: engineMove.currentWord,
    options: engineMove.options,
    usedOptionWords: usedOut,
    movesThisRound: admin.firestore.FieldValue.increment(1),
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
    tx.set(playerRef, playerPatch, {merge: true});
    if (roundPatch) {
      tx.set(roundRef, roundPatch, {merge: true});
    }
  });

  return {ok: true};
});

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
  const roomSnap = await roomRef.get();
  const roundSnap = await roundRef.get();
  if (!roundSnap.exists) {
    return {advanced: false};
  }
  const round = roundSnap.data()!;
  if (round.phase !== 'finish_window') {
    return {advanced: false, phase: round.phase};
  }
  const ends = round.phaseEndsAt as admin.firestore.Timestamp | undefined;
  if (!ends || ends.toMillis() > Date.now()) {
    return {advanced: false, waiting: true, endsAtMillis: ends?.toMillis() ?? null};
  }

  const beforeSeq = Number(round.roundSeq ?? 1);
  const memberIds = (roomSnap.data()?.memberIds ?? []) as string[];
  const playerSnaps = await Promise.all(
    memberIds.map(id => roomRef.collection('players').doc(id).get()),
  );
  const oldTarget = String(round.targetWord).toLowerCase();
  const newTarget = pickNextTargetWord({
    currentWord: oldTarget,
    avoidTarget: oldTarget,
  });
  const precomputed = await Promise.all(
    playerSnaps.map(async ps => {
      if (!ps.exists) return null;
      const cw = String(ps.data()?.currentWord ?? 'start').toLowerCase();
      const move = await embeddingNextMove({
        db: db(),
        currentWord: cw,
        targetWord: newTarget,
        excludeWords: [],
      });
      return {ref: ps.ref, move};
    }),
  );

  const expectedEnds = ends.toMillis();
  await db().runTransaction(async tx => {
    const r = await tx.get(roundRef);
    const d = r.data();
    if (!d || d.phase !== 'finish_window') {
      return;
    }
    const pe = d.phaseEndsAt as admin.firestore.Timestamp | undefined;
    if (!pe || pe.toMillis() !== expectedEnds) {
      return;
    }
    for (const row of precomputed) {
      if (!row) continue;
      tx.set(
        row.ref,
        {
          options: row.move.options,
          usedOptionWords: [],
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
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
  });

  const after = await roundRef.get();
  const afterSeq = Number(after.data()?.roundSeq ?? 1);
  if (afterSeq > beforeSeq) {
    await applyRoundRewards({
      roomId,
      primaryWinnerUid: (round.primaryWinnerUid as string | null) ?? null,
      windowFinisherUids: (round.windowFinishers as string[] | undefined) ?? [],
      allPlayerUids: memberIds,
    });
  }

  return {advanced: afterSeq > beforeSeq, newTarget};
});

export const assignGlobalRoom = onCall({region: REGION}, async request => {
  if (!request.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Auth required');
  }
  const uid = request.auth.uid;
  const {roomId, shardIndex} = await assignGlobalRoomId(db(), uid);
  return {roomId, shardIndex};
});
