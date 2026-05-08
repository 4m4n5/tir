import firestore from '@react-native-firebase/firestore';
import functions from '@react-native-firebase/functions';

const fns = functions();

export type RoundState = {
  targetWord: string;
  phase: 'active' | 'finish_window';
  phaseEndsAt: {toMillis: () => number} | null | undefined;
  roundSeq: number;
  primaryWinnerUid: string | null;
  windowFinishers: string[];
};

export type MyPlayerState = {
  currentWord: string;
  options: [string, string, string, string];
  usedOptionWords?: string[];
};

export function roomDoc(roomId: string) {
  return firestore().doc(`rooms/${roomId}`);
}

export function roundDoc(roomId: string) {
  return firestore().doc(`rooms/${roomId}/rounds/current`);
}

export function myPlayerDoc(roomId: string, playerId: string) {
  return firestore().doc(`rooms/${roomId}/players/${playerId}`);
}

export function playersCollection(roomId: string) {
  return firestore().collection(`rooms/${roomId}/players`);
}

export function userDoc(userId: string) {
  return firestore().doc(`users/${userId}`);
}

export function leagueFromElo(elo: number): string {
  if (elo >= 1800) return 'Diamond';
  if (elo >= 1600) return 'Platinum';
  if (elo >= 1400) return 'Gold';
  if (elo >= 1200) return 'Silver';
  return 'Bronze';
}

export async function callCreatePrivateRoom(): Promise<string> {
  const res = await fns.httpsCallable('createPrivateRoom')();
  const data = res.data as {roomId?: string};
  if (!data?.roomId) {
    throw new Error('createPrivateRoom: missing roomId');
  }
  return data.roomId;
}

export async function callJoinPrivateRoom(roomId: string): Promise<void> {
  await fns.httpsCallable('joinPrivateRoom')({roomId});
}

export async function callSubmitMove(roomId: string, nextWord: string): Promise<void> {
  await fns.httpsCallable('submitMove')({roomId, nextWord});
}

export async function callFinalizeFinishWindow(roomId: string): Promise<{
  advanced: boolean;
  waiting?: boolean;
  newTarget?: string;
}> {
  const res = await fns.httpsCallable('finalizeFinishWindow')({roomId});
  return res.data as {advanced: boolean; waiting?: boolean; newTarget?: string};
}

export async function callAssignGlobalRoom(): Promise<{roomId: string; shardIndex: number}> {
  const res = await fns.httpsCallable('assignGlobalRoom')();
  return res.data as {roomId: string; shardIndex: number};
}

export function logPerf(label: string, started: number) {
  const ms = Math.max(0, Math.round(Date.now() - started));
  console.log(`[perf] ${label} ${ms}ms`);
}
