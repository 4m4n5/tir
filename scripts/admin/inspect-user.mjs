#!/usr/bin/env node
// inspect-user.mjs — read-only diagnostic for a single user.
//
// Lists the user doc, every room they're a member of (with the round
// state), and the publicProfile mirror. Use to verify that
// `roundsPlayed` / `roundsWon` / `winsToday` etc. are actually being
// incremented server-side after a round finishes.
//
// Run:
//   node scripts/admin/inspect-user.mjs <displayName-or-uid>
//
// Auth: same ADC setup as `wipe-all.mjs`.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../../functions/package.json'));
const admin = require('firebase-admin');

const PROJECT_ID = 'tirapp-c596f';
admin.initializeApp({
  projectId: PROJECT_ID,
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();

const query = process.argv[2];
if (!query) {
  console.error('usage: node scripts/admin/inspect-user.mjs <displayName-or-uid>');
  process.exit(2);
}

async function findUid() {
  // Try as uid first.
  const direct = await db.collection('users').doc(query).get();
  if (direct.exists) return query;
  // Search publicProfiles for the displayName.
  const ppSnap = await db
    .collection('publicProfiles')
    .where('displayName', '==', query)
    .get();
  if (ppSnap.empty) return null;
  return ppSnap.docs[0].id;
}

const uid = await findUid();
if (!uid) {
  console.error(`No user found for "${query}"`);
  process.exit(1);
}

console.log(`uid: ${uid}\n`);

const userSnap = await db.collection('users').doc(uid).get();
console.log('users/' + uid + ':');
console.log(JSON.stringify(userSnap.data() ?? {EMPTY: true}, null, 2));
console.log();

const ppSnap = await db.collection('publicProfiles').doc(uid).get();
console.log('publicProfiles/' + uid + ':');
console.log(JSON.stringify(ppSnap.data() ?? {EMPTY: true}, null, 2));
console.log();

const roomsSnap = await db
  .collection('rooms')
  .where('memberIds', 'array-contains', uid)
  .get();
console.log(`rooms containing ${uid}: ${roomsSnap.size}`);
for (const room of roomsSnap.docs) {
  const r = room.data();
  console.log(`  rooms/${room.id}  mode=${r.mode}  members=${(r.memberIds ?? []).length}  status=${r.status ?? 'n/a'}`);
  const cur = await db.collection('rooms').doc(room.id).collection('rounds').doc('current').get();
  if (cur.exists) {
    const c = cur.data();
    console.log(`    rounds/current  seq=${c.roundSeq}  phase=${c.phase}  target=${c.targetWord}  primaryWinner=${c.primaryWinnerUid}`);
  }
  const me = await db.collection('rooms').doc(room.id).collection('players').doc(uid).get();
  if (me.exists) {
    const m = me.data();
    console.log(`    players/${uid}  movesThisRound=${m.movesThisRound}  currentWord=${m.currentWord}  lastRoundDelta=${m.lastRoundDelta}  lastRoundDeltaSeq=${m.lastRoundDeltaSeq}`);
  }
}
process.exit(0);
