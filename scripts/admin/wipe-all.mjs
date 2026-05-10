#!/usr/bin/env node
/**
 * wipe-all.mjs — DESTRUCTIVE one-shot admin script.
 *
 * Wipes every account and resets the leaderboard for the `tir` project.
 * Touches:
 *   - users/*                     (private profiles, ratingElo, streaks…)
 *   - publicProfiles/*            (denormalised view used by leaderboards)
 *   - rooms/*                     (every private + global room, incl. their
 *                                  players/* and rounds/* subcollections)
 *   - rewardLocks/*               (per-round idempotency keys)
 *   - analytics/*                 (round aggregates)
 *   - meta/globalRooms            (shard pointer; deleted so the next
 *                                  user that boots the app triggers a
 *                                  clean `ensureGlobalRoomShard` cycle
 *                                  with a fresh target word + roundSeq=1)
 *   - Firebase Auth users         (anonymous + linked, all of them)
 *
 * Auth: uses Application Default Credentials. Requires
 *   `gcloud auth application-default login` to have been run, OR
 *   `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account JSON.
 *
 * Run:
 *   node scripts/admin/wipe-all.mjs                      # dry-run (default)
 *   node scripts/admin/wipe-all.mjs --confirm WIPE-tirapp-c596f
 *
 * The confirm token is intentionally project-scoped so a stray copy-paste
 * against a different project ID is rejected.
 */
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve firebase-admin from functions/node_modules so we don't need a
// second install at the repo root.
const require = createRequire(resolve(__dirname, '../../functions/package.json'));
const admin = require('firebase-admin');

const PROJECT_ID = 'tirapp-c596f';
const CONFIRM_TOKEN = `WIPE-${PROJECT_ID}`;

const args = process.argv.slice(2);
const confirmIdx = args.indexOf('--confirm');
const confirmValue = confirmIdx >= 0 ? args[confirmIdx + 1] : null;
const dryRun = confirmValue !== CONFIRM_TOKEN;

// Explicit ADC credential — the default zero-arg initializeApp DOES try
// ADC, but firebase-admin v12 silently falls back to a metadata-server
// probe that 404s locally and ends up with an unauthenticated client
// (the Firestore call then comes back as PERMISSION_DENIED instead of
// the more obvious UNAUTHENTICATED). Passing it explicitly makes the
// failure mode loud if ADC isn't set.
admin.initializeApp({
  projectId: PROJECT_ID,
  credential: admin.credential.applicationDefault(),
});
const db = admin.firestore();
const auth = admin.auth();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Delete every doc in `collRef` in batches of 400. Caller is responsible
// for sweeping subcollections separately (see `nukeRoom`).
async function deleteCollection(collRef, label) {
  let total = 0;
  while (true) {
    const snap = await collRef.limit(400).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    total += snap.size;
    process.stdout.write(`  ${label}: deleted ${total}\r`);
  }
  if (total > 0) process.stdout.write('\n');
  return total;
}

async function countCollection(collRef) {
  // Cheap-ish count via aggregation. Fallback to .get().size if unavailable.
  try {
    const snap = await collRef.count().get();
    return snap.data().count;
  } catch {
    const snap = await collRef.get();
    return snap.size;
  }
}

async function nukeRoom(roomRef) {
  // Each room can have:
  //   - players/* (one doc per member)
  //   - rounds/* (always a `current` doc, plus optionally `history/*`)
  // Delete all subcollection docs first, then the room doc itself.
  let total = 0;
  total += await deleteCollection(roomRef.collection('players'), `room ${roomRef.id} players`);
  // rounds may contain a `current` doc with a `history` subcollection.
  const roundsSnap = await roomRef.collection('rounds').get();
  for (const round of roundsSnap.docs) {
    total += await deleteCollection(round.ref.collection('history'), `room ${roomRef.id} round history`);
    await round.ref.delete();
    total += 1;
  }
  await roomRef.delete();
  total += 1;
  return total;
}

async function listAllAuthUids() {
  const uids = [];
  let pageToken = undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) uids.push(u.uid);
    pageToken = page.pageToken;
  } while (pageToken);
  return uids;
}

// ---------------------------------------------------------------------------
// Dry-run summary
// ---------------------------------------------------------------------------
console.log(`\nProject: ${PROJECT_ID}`);
console.log(`Mode:    ${dryRun ? 'DRY RUN (no writes)' : 'EXECUTE WIPE'}\n`);

const [
  usersCount,
  publicProfilesCount,
  rewardLocksCount,
  analyticsCount,
  roomsSnap,
  metaGlobalRoomsSnap,
  authUids,
] = await Promise.all([
  countCollection(db.collection('users')),
  countCollection(db.collection('publicProfiles')),
  countCollection(db.collection('rewardLocks')),
  countCollection(db.collection('analytics')),
  db.collection('rooms').get(),
  db.doc('meta/globalRooms').get(),
  listAllAuthUids(),
]);

console.log('Found:');
console.log(`  users/                  ${usersCount}`);
console.log(`  publicProfiles/         ${publicProfilesCount}`);
console.log(`  rewardLocks/            ${rewardLocksCount}`);
console.log(`  analytics/              ${analyticsCount}`);
console.log(`  rooms/                  ${roomsSnap.size}`);
console.log(`  meta/globalRooms        ${metaGlobalRoomsSnap.exists ? 'present' : 'absent'}`);
console.log(`  auth users              ${authUids.length}`);
console.log('');

if (dryRun) {
  console.log(`To execute: node scripts/admin/wipe-all.mjs --confirm ${CONFIRM_TOKEN}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// EXECUTE
// ---------------------------------------------------------------------------
console.log('Wiping…\n');

let totalDocs = 0;

console.log('rooms/');
for (const roomDoc of roomsSnap.docs) {
  totalDocs += await nukeRoom(roomDoc.ref);
}

if (metaGlobalRoomsSnap.exists) {
  await db.doc('meta/globalRooms').delete();
  totalDocs += 1;
  console.log('  meta/globalRooms: deleted');
}

console.log('rewardLocks/');
totalDocs += await deleteCollection(db.collection('rewardLocks'), '  rewardLocks');

console.log('analytics/');
totalDocs += await deleteCollection(db.collection('analytics'), '  analytics');

console.log('publicProfiles/');
totalDocs += await deleteCollection(db.collection('publicProfiles'), '  publicProfiles');

console.log('users/');
totalDocs += await deleteCollection(db.collection('users'), '  users');

console.log(`\nFirestore: ${totalDocs} docs deleted`);

console.log('\nFirebase Auth:');
let authDeleted = 0;
for (let i = 0; i < authUids.length; i += 1000) {
  const chunk = authUids.slice(i, i + 1000);
  const result = await auth.deleteUsers(chunk);
  authDeleted += result.successCount;
  if (result.failureCount > 0) {
    console.warn(`  failed to delete ${result.failureCount} users in batch ${i / 1000}`);
    for (const e of result.errors.slice(0, 3)) console.warn('   ', e.error?.message);
  }
  process.stdout.write(`  deleted ${authDeleted} / ${authUids.length}\r`);
}
if (authUids.length > 0) process.stdout.write('\n');

console.log(`\nDone.`);
console.log(`  Firestore docs deleted: ${totalDocs}`);
console.log(`  Auth users deleted:     ${authDeleted}`);
console.log('');
console.log('Next user to launch the app will:');
console.log('  1. Get a fresh anonymous Firebase Auth uid');
console.log('  2. Land on /name (no profile doc → NavigationGate routes there)');
console.log('  3. After /name → /welcome → /, joining global room');
console.log('  4. assignGlobalRoom will trigger a fresh ensureGlobalRoomShard');
console.log('     with a new target word and roundSeq=1');
console.log('');
process.exit(0);
