import * as admin from 'firebase-admin';

const db = () => admin.firestore();

export async function applyRoundRewards(args: {
  roomId: string;
  primaryWinnerUid: string | null;
  windowFinisherUids: string[];
  allPlayerUids: string[];
}): Promise<void> {
  const {primaryWinnerUid, windowFinisherUids, allPlayerUids} = args;
  const batch = db().batch();
  const dayKey = new Date().toISOString().slice(0, 10);

  const bumpUser = (uid: string, patch: Record<string, unknown>) => {
    const ref = db().collection('users').doc(uid);
    batch.set(
      ref,
      {
        ...patch,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      {merge: true},
    );
  };

  const rewarded = new Set<string>();

  if (primaryWinnerUid) {
    bumpUser(primaryWinnerUid, {
      ratingElo: admin.firestore.FieldValue.increment(25),
      roundsWon: admin.firestore.FieldValue.increment(1),
      winStreak: admin.firestore.FieldValue.increment(1),
      lastPlayedDay: dayKey,
      roundsPlayed: admin.firestore.FieldValue.increment(1),
    });
    rewarded.add(primaryWinnerUid);
  }

  for (const uid of windowFinisherUids) {
    if (rewarded.has(uid)) continue;
    bumpUser(uid, {
      ratingElo: admin.firestore.FieldValue.increment(10),
      roundsPhotoFinish: admin.firestore.FieldValue.increment(1),
      lastPlayedDay: dayKey,
      roundsPlayed: admin.firestore.FieldValue.increment(1),
    });
    rewarded.add(uid);
  }

  for (const uid of allPlayerUids) {
    if (rewarded.has(uid)) continue;
    bumpUser(uid, {
      roundsPlayed: admin.firestore.FieldValue.increment(1),
      lastPlayedDay: dayKey,
    });
    rewarded.add(uid);
  }

  const agg = db().collection('analytics').doc(dayKey);
  batch.set(
    agg,
    {
      roundCompletions: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    {merge: true},
  );

  await batch.commit();
}
