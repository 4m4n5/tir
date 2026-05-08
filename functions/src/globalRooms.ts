import * as admin from 'firebase-admin';
const SHARD_COUNT = 3;
const META = 'meta/globalRooms';

function hashUid(uid: string): number {
  let h = 0;
  for (let i = 0; i < uid.length; i++) {
    h = (h << 5) - h + uid.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

async function ensureGlobalRoomShard(
  db: admin.firestore.Firestore,
  shardIndex: number,
): Promise<string> {
  const metaRef = db.doc(META);
  const snap = await metaRef.get();
  const roomIds = (snap.data()?.roomIds ?? []) as string[];
  if (roomIds[shardIndex]) {
    return roomIds[shardIndex];
  }

  const roomRef = db.collection('rooms').doc();
  const roomId = roomRef.id;
  const target = 'ocean';
  const batch = db.batch();
  batch.set(roomRef, {
    mode: 'global',
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    memberIds: [],
    shardIndex,
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

  const nextIds = [...roomIds];
  while (nextIds.length <= shardIndex) {
    nextIds.push('');
  }
  nextIds[shardIndex] = roomId;
  await metaRef.set(
    {roomIds: nextIds, shardCount: SHARD_COUNT, updatedAt: admin.firestore.FieldValue.serverTimestamp()},
    {merge: true},
  );
  return roomId;
}

export async function assignGlobalRoomId(
  db: admin.firestore.Firestore,
  uid: string,
): Promise<{roomId: string; shardIndex: number}> {
  const shardIndex = hashUid(uid) % SHARD_COUNT;
  const roomId = await ensureGlobalRoomShard(db, shardIndex);
  return {roomId, shardIndex};
}
