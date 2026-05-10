import {useEffect, useState} from 'react';
import firestore from '@react-native-firebase/firestore';
import functions from '@react-native-firebase/functions';

const fns = functions();

// MUST stay in sync with functions/src/globalRooms.ts → SHARD_COUNT and
// the `hashUid` algorithm there. The global pool is sharded so concurrent
// rounds run in parallel and matchmaking spreads load. Each user is
// deterministically routed to one shard based on `hashUid(uid) %
// SHARD_COUNT`; tapping PLAY puts them in *that* shard, not in some
// notion of "the busiest" shard. The home-screen live ticker therefore
// subscribes to the SAME shard the user will land in — so the target
// word it previews is the target word the user actually sees in-game.
//
// Earlier the ticker surfaced the highest-`roundSeq` shard regardless
// of the user's destined assignment, which produced a "live: plaza" /
// in-game: "osprey" mismatch (logged 2026-05-10 #41). The element-x-ios
// "stale room previews" issue catalogues the broader pattern: home
// previews diverging from destination state break user trust on every
// glance (https://github.com/element-hq/element-x-ios/issues/1775). The
// fix is to make the preview the destination's truth, not a "more
// interesting" shard's truth.
export const GLOBAL_SHARD_COUNT = 3;

// Mirror of functions/src/globalRooms.ts → hashUid. Same algorithm, same
// modulo, so the client and server pick the same shard for the same uid
// without the client having to call `assignGlobalRoom` (which is heavy:
// ensures shard exists, picks targets, hits embeddings). Plain string
// hash; do not change without updating the server in lockstep.
export function destinedGlobalShard(uid: string, shardCount: number = GLOBAL_SHARD_COUNT): number {
  let h = 0;
  for (let i = 0; i < uid.length; i++) {
    h = (h << 5) - h + uid.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) % Math.max(1, shardCount);
}

// Round phase machine (see functions/src/callables.ts):
//   active → (winner) → finish_window → (timer) → results → (3s) → active'
// `results` is the 3-sec server-enforced sync barrier — every client renders
// the popup; nobody can submit moves; on expiry the next round starts for
// all players simultaneously via the phase flip back to `active`.
export type RoundResultsSnapshot = {
  targetWord: string;
  primaryWinnerUid: string | null;
  windowFinishers: string[];
  winnerMoves: number | null;
  winnerSnap: boolean;
  completedSeq: number;
  // Per-player Elo deltas. Server pre-computes these BEFORE the CAS that
  // flips phase to `results`, so the popup can read correct numbers on its
  // very first frame instead of jittering from 0 → real value when the
  // separate player snapshot eventually lands.
  // For private (practice) rooms this map is empty — see `ranked` below.
  deltas?: Record<string, number>;
  // Per-uid post-this-round count of completed rounds. Used by the
  // results popup and home identity card to decide whether to render
  // the placement banner ("Calibrating N/5") instead of the Elo
  // numeral when the player is still inside their first
  // PLACEMENT_TOTAL_ROUNDS rounds. Embedded server-side so the popup's
  // first frame is correct (gating on profile.roundsPlayed flickers
  // because the user-doc listener lags the round-doc listener by
  // ~200ms). May be absent on legacy round.results blobs from before
  // the placement system existed — treat absent as "post-placement"
  // so existing veterans don't see the banner.
  roundsAfter?: Record<string, number>;
  // false for private rooms (practice / friends). Client uses this flag to
  // render "PRACTICE" in the popup instead of an Elo delta. Treat absence
  // as `true` for back-compat with rounds that completed before this
  // field was introduced — those were ranked global rounds.
  ranked?: boolean;
};

// Placement period — the number of rounds a brand-new player plays
// with their numerical Elo HIDDEN. The Elo math runs underneath as
// normal (so they get the climb / fall they earn), but the popup and
// home identity card both render "Calibrating N/5" instead of a
// number. After round PLACEMENT_TOTAL_ROUNDS the popup transitions
// to the normal Elo display and the home shows their tier badge.
//
// Rationale: pure Elo (V3) gives no protection on round 1. A new
// player who loses their first round sees `-12 elo` on the popup —
// loss aversion peaks on the first negative outcome of a session.
// Hiding the number until the player has had 5 rounds to find their
// true skill level removes the early-volatility scare without
// corrupting the Elo math itself.
//
// Canon: Riot League of Legends "5 placement matches at 0 LP loss"
// (https://support-leagueoflegends.riotgames.com/hc/en-us/articles/4405783687443).
// Tir's variant is UX-only (Elo math runs identically); Riot's also
// gates the LP math, which we don't.
//
// Server source of truth is implicit (the popup reads `roundsAfter`
// out of the round.results blob; the home reads profile.roundsPlayed
// directly). If you change this constant, no server-side migration
// is needed — every comparison happens client-side.
export const PLACEMENT_TOTAL_ROUNDS = 5;

export function isInPlacement(roundsPlayed: number | null | undefined): boolean {
  if (roundsPlayed == null) return true; // brand-new account
  return roundsPlayed < PLACEMENT_TOTAL_ROUNDS;
}

export type RoundState = {
  targetWord: string;
  phase: 'active' | 'finish_window' | 'results';
  phaseEndsAt: {toMillis: () => number} | null | undefined;
  roundSeq: number;
  primaryWinnerUid: string | null;
  windowFinishers: string[];
  winnerMoves?: number;
  winnerSnap?: boolean;
  results?: RoundResultsSnapshot;
};

export type MyPlayerState = {
  currentWord: string;
  options: [string, string, string, string];
  usedOptionWords?: string[];
  cosineDist?: number;
  movesThisRound?: number;
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

// ---------------------------------------------------------------------------
// League ladder.
//
// 8-tier ladder (was 5). Chess.com population is right-skewed: median ≈ 1000,
// 1200 ≈ top 30%, 1500 ≈ top 5%, 1800 ≈ top 1%
// (https://chessgrandmonkey.com/chess-rating-percentile-calculator-graph).
// A flat 5-band ladder collapses the head and crowds the tail. The 8-tier
// version below adds Stone (floor) and Master + Grandmaster (head) so the
// climb keeps yielding promotions deeper into the curve.
//
// Default user starts at Elo 1000, which lands mid-Bronze (900–1099) so the
// first promotion arrives in ~5–8 wins (Duolingo early-dopamine principle)
// and a single loss never drops them below the ladder. Grandmaster at
// 2100 ≈ top ~1% of the expected population — rare enough to preserve
// prestige (cf. Apex Legends Season 26 rank-inflation case where 35–40% of
// players sat in Diamond and the tier visibly devalued).
//
// Icon vocabulary shifts deliberately at Master / Grandmaster: medals →
// gems → crown → chess piece. The shift is the message — you've crossed
// into a different category. ♛ (U+265B) is a text-presentation glyph that
// renders in the current text color on every modern OS, so it stays legible
// on the dark theme.
// ---------------------------------------------------------------------------

export type LeagueKey =
  | 'stone'
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'master'
  | 'grandmaster';

export type LeagueTier = {
  key: LeagueKey;
  name: string;     // lowercase label, used in chips and copy
  icon: string;     // single-glyph badge
  minElo: number;   // inclusive lower bound; top tier is open-ended up
};

export const LEAGUES: LeagueTier[] = [
  {key: 'stone',       name: 'stone',       icon: '🪨', minElo: 0},
  {key: 'bronze',      name: 'bronze',      icon: '🥉', minElo: 900},
  {key: 'silver',      name: 'silver',      icon: '🥈', minElo: 1100},
  {key: 'gold',        name: 'gold',        icon: '🥇', minElo: 1300},
  {key: 'platinum',    name: 'platinum',    icon: '💠', minElo: 1500},
  {key: 'diamond',     name: 'diamond',     icon: '💎', minElo: 1700},
  {key: 'master',      name: 'master',      icon: '👑', minElo: 1900},
  {key: 'grandmaster', name: 'grandmaster', icon: '♛',  minElo: 2100},
];

export function leagueTierFromElo(elo: number): LeagueTier {
  for (let i = LEAGUES.length - 1; i >= 0; i--) {
    if (elo >= LEAGUES[i].minElo) return LEAGUES[i];
  }
  return LEAGUES[0];
}

// Back-compat: lowercase tier name. Prefer leagueTierFromElo() in new code
// so you also get the icon and the typed key.
export function leagueFromElo(elo: number): string {
  return leagueTierFromElo(elo).name;
}

export type Difficulty = 'chill' | 'normal' | 'hard' | 'expert';

export async function callCreatePrivateRoom(difficulty?: Difficulty): Promise<string> {
  const res = await fns.httpsCallable('createPrivateRoom')({difficulty: difficulty ?? 'normal'});
  const data = res.data as {roomId?: string};
  if (!data?.roomId) {
    throw new Error('createPrivateRoom: missing roomId');
  }
  return data.roomId;
}

export async function callJoinPrivateRoom(roomId: string): Promise<void> {
  await fns.httpsCallable('joinPrivateRoom')({roomId});
}

// Explicit leave: removes the player from the room's `memberIds` and
// deletes their player doc. If the leaving player is the LAST member of a
// PRIVATE room, the server cascade-deletes the room (players, rounds,
// rewardLocks, and the room doc itself). Global rooms are never deleted —
// the player is just unregistered. Errors are swallowed by the caller
// (game-screen unmount); the scheduled reaper is the safety net.
export async function callLeaveRoom(roomId: string): Promise<void> {
  await fns.httpsCallable('leaveRoom')({roomId});
}

// Server-side account deletion. Removes the user doc, public profile,
// every player presence doc the user has across all rooms, AND the
// Firebase Auth user record. After this resolves the local auth token
// is invalid; the client should call `auth().signOut()` immediately so
// `onAuthStateChanged` fires and `AuthProvider` re-anon-signs-in to a
// fresh uid (which lands the player on /name to re-onboard).
//
// Why server-side: firestore.rules disallows client deletes on
// `users/{uid}` and any client writes to `publicProfiles/{uid}`. The
// admin SDK bypasses rules. Apple App Review 5.1.1(v) compliance for
// guest/anonymous accounts.
export async function callDeleteAccount(): Promise<void> {
  await fns.httpsCallable('deleteAccount')({});
}

export async function callSubmitMove(roomId: string, nextWord: string): Promise<void> {
  await fns.httpsCallable('submitMove')({roomId, nextWord});
}

export async function callFinalizeFinishWindow(roomId: string): Promise<{
  transitioned: boolean;
  waiting?: boolean;
  phase?: string;
  raced?: boolean;
}> {
  const res = await fns.httpsCallable('finalizeFinishWindow')({roomId});
  return res.data as {
    transitioned: boolean;
    waiting?: boolean;
    phase?: string;
    raced?: boolean;
  };
}

export async function callAdvanceRound(roomId: string): Promise<{
  advanced: boolean;
  waiting?: boolean;
  phase?: string;
  newTarget?: string;
}> {
  const res = await fns.httpsCallable('advanceRound')({roomId});
  return res.data as {
    advanced: boolean;
    waiting?: boolean;
    phase?: string;
    newTarget?: string;
  };
}

export async function callAssignGlobalRoom(): Promise<{roomId: string; shardIndex: number}> {
  const res = await fns.httpsCallable('assignGlobalRoom')();
  return res.data as {roomId: string; shardIndex: number};
}

export async function callHeartbeat(roomId: string): Promise<void> {
  await fns.httpsCallable('heartbeat')({roomId});
}

export function publicProfileDoc(userId: string) {
  return firestore().doc(`publicProfiles/${userId}`);
}

export function publicProfilesCollection() {
  return firestore().collection('publicProfiles');
}

export function logPerf(label: string, started: number) {
  const ms = Math.max(0, Math.round(Date.now() - started));
  console.log(`[perf] ${label} ${ms}ms`);
}

// ---------------------------------------------------------------------------
// useGlobalLivePulse — live ticker data for the home screen.
//
// Subscribes to `meta/globalRooms` to discover the shard roomIds, then
// opens ONE snapshot listener on the shard the local user is destined
// to be assigned to (`destinedGlobalShard(uid)`). The ticker therefore
// previews the EXACT room the user will land in when they tap PLAY —
// no shard mismatch, no "live · plaza" → in-game "osprey" surprise.
//
// Returns null while booting, while uid is unknown, or before the
// destined shard's current-round doc has arrived. 2 listeners total
// (1 meta + 1 shard), both on small docs.
//
// Earlier this hook surfaced the highest-`roundSeq` shard across all
// 3 shards, with the rationale "show the most active one so the ticker
// shows real action." That choice broke truthfulness as soon as the
// destined shard wasn't the busiest — the ticker advertised one game,
// the user joined another. The `element-x-ios` "stale room previews"
// issue catalogues the broader UX cost: home previews diverging from
// destination state break trust on every glance
// (https://github.com/element-hq/element-x-ios/issues/1775).
//
// Trade-off acknowledged: when the destined shard is sleepy (low
// player count), the ticker word changes less often and the home feels
// less kinetic. That is the truthful state — making it appear busier
// than it is would be theatre. The remedy if the home feels too still
// is to *consolidate shards* (drop SHARD_COUNT to 1 until concurrency
// demands more), not to lie on the ticker.
//
// Per Sportmonks 2026 best practice (centralised polling): the source
// of truth is already in Firestore so we listen to it directly. Per
// Apple Live Activities convention: live data belongs as a glanceable
// ticker on the surface the user already sees, not as a notification
// (https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities).
// ---------------------------------------------------------------------------

export type LivePulseSnapshot = {
  targetWord: string;
  roundSeq: number;
  phase: 'active' | 'finish_window' | 'results';
  shardIndex: number;
};

export function useGlobalLivePulse(
  ready: boolean,
  uid: string | null,
): LivePulseSnapshot | null {
  const [roomIds, setRoomIds] = useState<string[]>([]);
  const [shardCount, setShardCount] = useState<number>(GLOBAL_SHARD_COUNT);
  const [data, setData] = useState<LivePulseSnapshot | null>(null);

  useEffect(() => {
    if (!ready) return;
    return firestore()
      .doc('meta/globalRooms')
      .onSnapshot(
        snap => {
          if (!snap?.exists) return;
          const d = snap.data();
          const ids = (d?.roomIds as string[] | undefined) ?? [];
          // Server may write `shardCount`; fall back to the client constant
          // so we still resolve a shard before the meta doc is fully
          // populated (e.g. during the first user's bootstrap).
          const count = Number(d?.shardCount ?? GLOBAL_SHARD_COUNT);
          setRoomIds(ids);
          setShardCount(count > 0 ? count : GLOBAL_SHARD_COUNT);
        },
        err => {
          console.warn('meta/globalRooms snapshot failed:', err.message);
        },
      );
  }, [ready]);

  // Resolve the user's destined shard and listen ONLY to that shard's
  // current-round doc. When uid is unknown we deliberately render
  // nothing on the ticker — the alternative (preview some other
  // shard) reintroduces the destination-mismatch bug.
  useEffect(() => {
    if (!ready || !uid || roomIds.length === 0) {
      setData(null);
      return;
    }
    const idx = destinedGlobalShard(uid, shardCount);
    const roomId = roomIds[idx];
    if (!roomId) {
      // Server hasn't ensured this shard yet (first user about to join).
      // Render nothing instead of a stale neighbour shard's data.
      setData(null);
      return;
    }
    return firestore()
      .doc(`rooms/${roomId}/rounds/current`)
      .onSnapshot(
        snap => {
          const d = snap?.data();
          if (!d || !d.targetWord) return;
          setData({
            targetWord: String(d.targetWord ?? ''),
            roundSeq: Number(d.roundSeq ?? 0),
            phase: (d.phase as LivePulseSnapshot['phase']) ?? 'active',
            shardIndex: idx,
          });
        },
        err => {
          console.warn(
            `globalShard[${idx}] snapshot failed:`,
            err.message,
          );
        },
      );
  }, [ready, uid, roomIds, shardCount]);

  return data;
}
